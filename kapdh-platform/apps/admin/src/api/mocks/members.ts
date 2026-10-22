import type { Permission } from "@kapdh/contracts";
import {
  mockAdminRef,
  mockAdminRole,
  mockHasPermission,
  requireAdmin,
  requirePermission,
  requireReauth,
} from "./auth";
import { error, json, type MockRequest, type MockRoute, noContent, paginate, type S } from "./http";

/**
 * Tiruan Manajemen Users (F-15, F-16, AC F05-6, F12-3..F12-5, F16-4) dan master profesi/keahlian (F-10, AC F10-4)
 * mengikuti kontrak admin-members dan admin-masters final (C2). Data contoh meniru guideline hal. 16 dengan
 * identitas sintetis; bukan bukti lulus acceptance criteria (PRD 7.3). Endpoint nyata dibangun irisan API
 * admin dan network.
 *
 * Aturan server yang ditiru:
 * - Penyaringan per izin pada SETIAP AdminMemberDetail (200 maupun `current` 409): tanpa payments.read
 *   `recent_payments` null; tanpa events.manage dan payments.read `recent_tickets` null; tanpa moderation.read
 *   `moderation` null dan alasan suspend disembunyikan (`reason_redacted`). Histori tanpa moderation.read tidak
 *   memuat `warn` dan filter kind=warn ditolak 403.
 * - Nomor anggota AA.SS.JK.N dihitung server dari data tersimpan; koreksi identitas menghitung ulang prefix dan
 *   mempertahankan N, mencatat histori `number_correction` (AC F05-6). `member_number` dari klien ditolak 400.
 * - Konflik kepentingan (PRD 2.3): akun alumni yang tertaut ke admin pelaku tidak dapat diubah, dibatasi,
 *   dicabut pembatasannya atau di-reset sandinya oleh admin tersebut (403).
 * - If-Match berbeda -> 409 VERSION_CONFLICT dengan `current`; Idempotency-Key yang sama dengan payload sama
 *   mengembalikan hasil pertama.
 * - Master terpakai tidak dapat dihapus (409 VALIDATION_ERROR dengan `current`), dinonaktifkan sebagai gantinya.
 * - Prasyarat gagal dengan bentuk server yang sama: suspend/unsuspend memakai bentuk MembershipKernel (400 tanpa
 *   field_errors, `current` {suspended_at, account_status, version}); ubah data akun yang sedang dihapus dan
 *   pemulihan sandi akun tidak aktif memakai galat akar `field_errors._`.
 * - Pemulihan sandi tunduk pada batas OTP 5 per jam per email (429 RATE_LIMITED dengan retry_after_seconds).
 * - Profil berulang (professions, education, social_links) adalah sumber kebenaran; field lama diturunkan darinya:
 *   `profession` = profesi pertama bertaut master, `last_education_institution` = institusi teratas,
 *   `social_<platform>` = tautan pertama platform itu. Field lama yang dikirim mengubah entri padanannya; field lama
 *   bersama penggantinya ditolak 400. Pendidikan disimpan terbaru di atas (tanpa tahun di atas).
 */
type Detail = S["AdminMemberDetail"];
type Summary = S["AdminMemberSummary"];
type MembershipEvent = S["AdminMembershipEvent"];
type MasterItem = S["AdminMasterItem"];
type MasterKind = S["MasterKind"];
type Gender = S["Gender"];
type EffectiveStatus = S["EffectiveStatus"];

/** Waktu server tiruan saat data contoh dibuat; dasar perhitungan effective_status agar deterministik. */
export const MEMBERS_MOCK_NOW = Date.parse("2026-10-12T11:00:00Z");
const DAY_MS = 86_400_000;
/** app_settings membership.expiring_days (PRD 2.2). */
const EXPIRING_DAYS = 30;
/** Challenge OTP pemulihan berlaku 10 menit (PRD 2.5). */
const OTP_TTL_MS = 10 * 60_000;

/** UUID v7 tiruan yang stabil: awalan heksadesimal + nomor urut. */
function mockId(prefix: string, n: number): string {
  return `0199e000-0000-7000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`;
}

/** Status pendidikan SS dari kelas masuk/keluar (tabel PRD 3.5). */
export function educationStatus(classIn: number, classOut: number): S["EducationStatus"] {
  const tamatMts = classIn <= 3 && classOut >= 3;
  const tamatAliyah = classOut === 6;
  if (tamatMts && tamatAliyah) return "01";
  if (tamatMts || tamatAliyah) return "02";
  return "03";
}

/** Nomor anggota AA.SS.JK.N (PRD 3.5); null bila N belum dialokasikan (pending_otp). */
export function memberNumber(m: {
  cohort: number;
  class_in: number;
  class_out: number;
  gender: Gender;
  seq: number | null;
}): string | null {
  if (m.seq === null) return null;
  const aa = String(m.cohort).padStart(2, "0");
  const jk = m.gender === "male" ? "01" : "02";
  return `${aa}.${educationStatus(m.class_in, m.class_out)}.${jk}.${m.seq}`;
}

interface Suspension {
  suspended_at: string;
  reason: string | null;
  member_message: string | null;
  suspended_by: S["AdminMemberActor"] | null;
}

interface MemberState {
  user_id: string;
  full_name: string;
  email: string;
  gender: Gender;
  cohort: number;
  class_in: number;
  class_out: number;
  /** N dari sequence server; null = pending_otp. */
  seq: number | null;
  city: string | null;
  avatar_file_id: string | null;
  account_status: S["AccountStatus"];
  starts_at: string | null;
  expires_at: string | null;
  registered_at: string;
  email_verified_at: string | null;
  last_login_at: string | null;
  phone: string | null;
  bio: string | null;
  /** Profesi sesuai urutan anggota: tertaut master (`profession_id`) atau ketikan sendiri (`label`). */
  professions: ProfessionEntry[];
  /** Riwayat pendidikan, terbaru di atas (urutan server). */
  education: S["EducationEntry"][];
  social_links: S["SocialLink"][];
  /** Kota lulusan dari aplikasi lama (field lama tanpa padanan di `education`). */
  last_education_city: string | null;
  privacy: S["ProfilePrivacy"];
  skill_ids: string[];
  suspension: Suspension | null;
  linked_admin: S["AdminMemberLinkedAdmin"] | null;
  periods: S["MembershipPeriod"][];
  recent_payments: S["AdminMemberPaymentSummary"][];
  recent_tickets: S["AdminMemberTicketSummary"][];
  moderation: S["AdminMemberModerationSummary"];
  /** Histori lengkap (termasuk warn); disaring per izin saat dikirim. */
  events: MembershipEvent[];
  /** Banding aktif (reports berkategori appeal open/in_review) milik anggota. */
  openAppeals: number;
  /** Jumlah sesi umum anggota yang masih aktif (dicabut saat suspend/reset sandi). */
  sessions: number;
  version: number;
}

interface ProfessionEntry {
  profession_id: string | null;
  label: string | null;
}

interface MasterState {
  id: string;
  kind: MasterKind;
  label: string;
  active: boolean;
  sort_order: number;
  version: number;
  created_at: string;
  updated_at: string;
}

let members = new Map<string, MemberState>();
let masters = new Map<string, MasterState>();
let eventSeq = 0;
let masterSeq = 0;
/** Idempotency-Key tindakan anggota: payload pertama dan respons pertama (ARCHITECTURE §4.2). */
const replays = new Map<string, { payload: string; status: number; body: unknown }>();
/** Waktu pengiriman OTP per email dalam jendela satu jam (kunci server `otp:<email>`, PRD 2.5). */
const otpSends = new Map<string, number[]>();
/** PRD 2.5 (Usulan D1): 5 pengiriman OTP per jam per email, sama dengan modul auth server. */
const OTP_SENDS_PER_HOUR = 5;
const HOUR_MS = 3_600_000;

/** Angkatan terbaru menurut tahun Jakarta, seperti MembershipKernel.latestCohort server (PRD 3.5). */
function serverLatestCohort(now = new Date()): number {
  const jakartaYear = new Date(now.getTime() + 7 * 3_600_000).getUTCFullYear();
  return jakartaYear - 1996;
}

export interface MemberRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  background: boolean;
  idempotencyKey: string | null;
  ifMatch: string | null;
  reauthToken: string | null;
  body: Record<string, unknown> | null;
}

/** Log permintaan ke endpoint anggota/master tiruan, untuk uji (filter server, If-Match, Idempotency-Key). */
export const memberRequests: MemberRequestLog[] = [];

function log(req: MockRequest): void {
  memberRequests.push({
    method: req.method,
    path: req.path,
    query: Object.fromEntries(req.url.searchParams.entries()),
    background: req.headers.get("X-Background-Request") === "1",
    idempotencyKey: req.headers.get("Idempotency-Key"),
    ifMatch: req.headers.get("If-Match"),
    reauthToken: req.headers.get("X-Reauth-Token"),
    body: req.body,
  });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Data contoh                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

const PROFESSION_LABELS = [
  "Aparatur Sipil Negara",
  "Guru",
  "Dosen/Peneliti",
  "Ustadz/Dai",
  "Dokter",
  "Profesional Teknologi Informasi",
  "Karyawan Swasta",
  "Wirausaha",
  "Petani/Peternak/Nelayan",
  "Mahasiswa/Pelajar",
  "Pensiunan",
] as const;
/** Master nonaktif: "Petani/Peternak/Nelayan" masih dipakai (label historis, AC F10-4), "Pensiunan" belum. */
const INACTIVE_PROFESSIONS = new Set(["Petani/Peternak/Nelayan", "Pensiunan"]);

const SKILL_LABELS = [
  "Bahasa Arab",
  "Bahasa Inggris",
  "Tahfidz Al-Qur'an",
  "Dakwah dan Public Speaking",
  "Kewirausahaan",
  "Pemasaran Digital",
  "Desain Grafis",
  "Pemrograman",
  "Analisis Data",
  "Kuliner",
] as const;
const INACTIVE_SKILLS = new Set(["Kuliner"]);

export function professionId(label: (typeof PROFESSION_LABELS)[number]): string {
  return mockId("6", PROFESSION_LABELS.indexOf(label) + 1);
}

export function skillId(label: (typeof SKILL_LABELS)[number]): string {
  return mockId("7", SKILL_LABELS.indexOf(label) + 1);
}

/**
 * Pengguna contoh yang dipakai uji (tata letak guideline hal. 16 dan contoh AC F05-6). Nama, email dan nomor
 * urut N persona guideline (91-94) sintetis, bukan data alumni nyata.
 */
export const MOCK_MEMBER = {
  hasan: mockId("5", 1),
  galih: mockId("5", 2),
  ridho: mockId("5", 3),
  /** Tertaut ke admin tiruan yang sedang masuk (konflik kepentingan, PRD 2.3). */
  fikriRamadhan: mockId("5", 4),
  /** Contoh AC F05-6: 12.02.01.7, kelas keluar 5. */
  umar: mockId("5", 5),
  siti: mockId("5", 6),
  nur: mockId("5", 7),
  hendra: mockId("5", 8),
  /** Suspended dengan masa aktif masih berjalan dan banding aktif. */
  rizky: mockId("5", 9),
  /** Suspended dengan masa aktif yang sudah habis (unsuspend -> expired, AC F12-5). */
  dewi: mockId("5", 10),
  fikri: mockId("5", 11),
  fatimah: mockId("5", 12),
  yusuf: mockId("5", 13),
} as const;

const PRIVACY_DEFAULT: S["ProfilePrivacy"] = {
  show_in_directory: true,
  show_phone: false,
  show_email: false,
  show_social: false,
};

const EMPTY_MODERATION: S["AdminMemberModerationSummary"] = {
  open_report_count: 0,
  total_report_count: 0,
  warning_count: 0,
  last_action_at: null,
};

const SYSTEM_ADMIN: S["AdminMemberActor"] = {
  admin_id: mockId("ad", 2),
  display_name: "Hasan Basri",
};

function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

function activation(paymentId: string, approvedAt: string): S["MembershipPeriod"] {
  return {
    kind: "activation",
    starts_at: approvedAt,
    expires_at: addMonths(approvedAt, 12),
    approved_at: approvedAt,
    payment_id: paymentId,
  };
}

/** Perpanjangan: periode baru dari max(expiry lama, approved_at) + 12 bulan (PRD 4.2). */
function renewal(prev: S["MembershipPeriod"], paymentId: string, approvedAt: string): S["MembershipPeriod"] {
  const starts = Date.parse(prev.expires_at) > Date.parse(approvedAt) ? prev.expires_at : approvedAt;
  return {
    kind: "renewal",
    starts_at: starts,
    expires_at: addMonths(starts, 12),
    approved_at: approvedAt,
    payment_id: paymentId,
  };
}

/** Histori activation/renewal dari satu payment paid (approver = pengurus contoh). */
function periodEvent(p: S["MembershipPeriod"], prev: S["MembershipPeriod"] | null): MembershipEvent {
  eventSeq += 1;
  return {
    id: mockId("9", eventSeq),
    kind: p.kind,
    created_at: p.approved_at,
    actor: SYSTEM_ADMIN,
    payment_id: p.payment_id,
    reason: null,
    reason_redacted: false,
    before_starts_at: prev?.starts_at ?? null,
    after_starts_at: p.starts_at,
    before_expires_at: prev?.expires_at ?? null,
    after_expires_at: p.expires_at,
    before_member_number: null,
    after_member_number: null,
  };
}

function moderationEvent(
  kind: "suspend" | "unsuspend" | "warn",
  at: string,
  reason: string,
  actor: S["AdminMemberActor"] | null,
): MembershipEvent {
  eventSeq += 1;
  return {
    id: mockId("9", eventSeq),
    kind,
    created_at: at,
    actor,
    payment_id: null,
    reason,
    reason_redacted: false,
    before_starts_at: null,
    after_starts_at: null,
    before_expires_at: null,
    after_expires_at: null,
    before_member_number: null,
    after_member_number: null,
  };
}

function payment(
  n: number,
  type: S["PaymentType"],
  status: S["PaymentStatus"],
  createdAt: string,
  decidedAt: string | null,
): S["AdminMemberPaymentSummary"] {
  return {
    id: mockId("a", n),
    type,
    status,
    amount: type === "registration" ? "60000.00" : type === "renewal" ? "10000.00" : "75000.00",
    proof_version: 1,
    created_at: createdAt,
    submitted_at: createdAt,
    decided_at: decidedAt,
  };
}

/** Bentuk ringkas data lama (satu profesi, lulusan terakhir, empat kolom sosial) yang diubah seed() menjadi daftar. */
interface LegacySeed {
  profession_id?: string | null;
  last_education_institution?: string | null;
  social_instagram?: string | null;
  social_x?: string | null;
  social_facebook?: string | null;
  social_linkedin?: string | null;
}

type Seed = Partial<MemberState> &
  LegacySeed &
  Pick<
    MemberState,
    "user_id" | "full_name" | "email" | "gender" | "cohort" | "class_in" | "class_out" | "seq" | "city"
  >;

function seed(input: Seed): MemberState {
  const {
    profession_id,
    last_education_institution,
    social_instagram,
    social_x,
    social_facebook,
    social_linkedin,
    ...s
  } = input;
  const legacyLinks: S["SocialLink"][] = (
    [
      ["instagram", social_instagram],
      ["x", social_x],
      ["facebook", social_facebook],
      ["linkedin", social_linkedin],
    ] as const
  ).flatMap(([platform, value]) => (value ? [{ platform, value }] : []));
  const registered = s.registered_at ?? "2025-11-02T03:00:00Z";
  const periods = s.periods ?? [];
  const latest = periods[0];
  // Periode terbaru lebih dulu; histori dibuat dari yang terlama.
  const events =
    s.events ?? [...periods].reverse().map((p, i, all) => periodEvent(p, i === 0 ? null : all[i - 1]!));
  return {
    avatar_file_id: null,
    account_status: "active",
    starts_at: latest?.starts_at ?? null,
    expires_at: latest?.expires_at ?? null,
    registered_at: registered,
    email_verified_at: s.seq === null ? null : new Date(Date.parse(registered) + 5 * 60_000).toISOString(),
    last_login_at: "2026-10-10T02:15:00Z",
    phone: null,
    bio: null,
    professions: profession_id ? [{ profession_id, label: null }] : [],
    education: last_education_institution
      ? [{ institution: last_education_institution, major: null, level: null, graduation_year: null }]
      : [],
    social_links: legacyLinks,
    last_education_city: null,
    privacy: PRIVACY_DEFAULT,
    skill_ids: [],
    suspension: null,
    linked_admin: null,
    recent_payments: [],
    recent_tickets: [],
    moderation: EMPTY_MODERATION,
    openAppeals: 0,
    sessions: 1,
    version: 1,
    ...s,
    periods,
    events,
  };
}

/** Data gambar foto profil tiruan (persegi hijau berinisial); server asli memberi URL bertanda tangan. */
function avatarDataUrl(initials: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#1a4b17"/><text x="48" y="58" font-size="32" text-anchor="middle" fill="#fff" font-family="sans-serif">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function memberFixtures(): MemberState[] {
  const rizkySuspendedAt = "2026-10-05T04:00:00Z";
  const dewiSuspendedAt = "2026-08-20T04:00:00Z";
  const list: MemberState[] = [
    seed({
      user_id: MOCK_MEMBER.hasan,
      full_name: "Hasan Basri",
      email: "hasan.basri@alumni.test",
      gender: "male",
      cohort: 5,
      class_in: 1,
      class_out: 2,
      seq: 93,
      city: "Dumai",
      registered_at: "2026-01-04T02:00:00Z",
      phone: "+62 812-7000-1002",
      bio: "Pengusaha konveksi dan pembina UMKM alumni.",
      professions: [
        { profession_id: professionId("Wirausaha"), label: null },
        { profession_id: null, label: "Konsultan UMKM" },
      ],
      education: [
        {
          institution: "Universitas Terbuka",
          major: "Magister Manajemen",
          level: "s2",
          graduation_year: 2021,
        },
        { institution: "Universitas Riau", major: "Manajemen", level: "s1", graduation_year: 2013 },
      ],
      last_education_city: "Pekanbaru",
      social_links: [
        { platform: "instagram", value: "hasan.uji" },
        { platform: "linkedin", value: "https://www.linkedin.com/in/hasan-uji" },
        { platform: "tiktok", value: "hasan.konveksi" },
      ],
      skill_ids: [skillId("Kewirausahaan"), skillId("Pemasaran Digital")],
      linked_admin: {
        admin_id: SYSTEM_ADMIN.admin_id,
        display_name: "Hasan Basri",
        role: "admin",
        status: "active",
      },
      periods: [activation(mockId("a", 1), "2026-01-05T03:00:00Z")],
      recent_payments: [payment(1, "registration", "paid", "2026-01-04T02:30:00Z", "2026-01-05T03:00:00Z")],
    }),
    seed({
      user_id: MOCK_MEMBER.galih,
      full_name: "Galih Saputra",
      email: "galih.saputra@alumni.test",
      gender: "male",
      cohort: 10,
      class_in: 1,
      class_out: 4,
      seq: 94,
      city: null,
      registered_at: "2026-04-20T04:00:00Z",
      profession_id: professionId("Karyawan Swasta"),
      periods: [activation(mockId("a", 2), "2026-04-25T03:00:00Z")],
      recent_payments: [payment(2, "registration", "paid", "2026-04-21T01:00:00Z", "2026-04-25T03:00:00Z")],
    }),
    seed({
      user_id: MOCK_MEMBER.ridho,
      full_name: "Ridho",
      email: "ridho@alumni.test",
      gender: "male",
      cohort: 6,
      class_in: 4,
      class_out: 6,
      seq: 92,
      city: "Bengkalis",
      registered_at: "2026-01-10T04:00:00Z",
      profession_id: professionId("Ustadz/Dai"),
      skill_ids: [skillId("Bahasa Arab"), skillId("Dakwah dan Public Speaking")],
      periods: [activation(mockId("a", 3), "2026-01-12T03:00:00Z")],
    }),
    seed({
      user_id: MOCK_MEMBER.fikriRamadhan,
      full_name: "Fikri Ramadhan",
      email: "fikri.ramadhan@alumni.test",
      gender: "male",
      cohort: 9,
      class_in: 1,
      class_out: 3,
      seq: 91,
      city: "Pekanbaru",
      registered_at: "2025-09-15T04:00:00Z",
      profession_id: professionId("Profesional Teknologi Informasi"),
      skill_ids: [skillId("Pemrograman")],
      linked_admin: {
        admin_id: mockAdminRef().admin_id,
        display_name: mockAdminRef().display_name,
        role: "super_admin",
        status: "active",
      },
      periods: [activation(mockId("a", 4), "2026-02-01T03:00:00Z")],
    }),
    seed({
      user_id: MOCK_MEMBER.umar,
      full_name: "Umar Faruq",
      email: "umar.faruq@alumni.test",
      gender: "male",
      cohort: 12,
      class_in: 1,
      class_out: 5,
      seq: 7,
      city: "Bangkinang",
      registered_at: "2026-03-01T04:00:00Z",
      profession_id: professionId("Guru"),
      skill_ids: [skillId("Tahfidz Al-Qur'an")],
      periods: [activation(mockId("a", 5), "2026-03-02T03:00:00Z")],
      sessions: 2,
      recent_payments: [payment(5, "registration", "paid", "2026-03-01T05:00:00Z", "2026-03-02T03:00:00Z")],
      recent_tickets: [
        {
          id: mockId("c", 5),
          event_id: mockId("e", 1),
          event_title: "Halal bi Halal",
          event_starts_at: "2026-10-24T01:00:00Z",
          status: "paid",
          total: "75000.00",
          checked_in_at: null,
          created_at: "2026-10-01T02:00:00Z",
        },
      ],
    }),
    seed({
      user_id: MOCK_MEMBER.siti,
      full_name: "Siti Rahmawati",
      email: "siti.rahmawati@alumni.test",
      gender: "female",
      cohort: 27,
      class_in: 4,
      class_out: 6,
      seq: 8,
      city: "Pekanbaru",
      registered_at: "2026-10-09T01:30:00Z",
      skill_ids: [skillId("Kuliner")],
      // Iuran pendaftaran yang menunggu verifikasi berasal dari tiruan payments (anggota yang sama, D6-02).
    }),
    seed({
      user_id: MOCK_MEMBER.nur,
      full_name: "Nur Aisyah",
      email: "nur.aisyah@alumni.test",
      gender: "female",
      cohort: 30,
      class_in: 1,
      class_out: 6,
      seq: 9,
      city: "Kampar",
      avatar_file_id: mockId("f", 7),
      registered_at: "2026-07-01T04:00:00Z",
      profession_id: professionId("Mahasiswa/Pelajar"),
      privacy: { show_in_directory: true, show_phone: true, show_email: true, show_social: true },
      phone: "+62 813-6100-0009",
      social_instagram: "nur.aisyah",
      education: [
        { institution: "Universitas Islam Riau", major: "Farmasi", level: "s1", graduation_year: null },
      ],
      periods: [activation(mockId("a", 7), "2026-07-02T03:00:00Z")],
    }),
    seed({
      user_id: MOCK_MEMBER.hendra,
      full_name: "Hendra Gunawan",
      email: "hendra.gunawan@alumni.test",
      gender: "male",
      cohort: 16,
      class_in: 1,
      class_out: 4,
      seq: 10,
      city: "Siak",
      registered_at: "2025-08-20T04:00:00Z",
      profession_id: professionId("Petani/Peternak/Nelayan"),
      periods: [activation(mockId("a", 8), "2025-09-01T03:00:00Z")],
    }),
    seed({
      user_id: MOCK_MEMBER.rizky,
      full_name: "Rizky Pratama",
      email: "rizky.pratama@alumni.test",
      gender: "male",
      cohort: 22,
      class_in: 4,
      class_out: 5,
      seq: 11,
      city: "Pekanbaru",
      registered_at: "2026-02-10T04:00:00Z",
      periods: [activation(mockId("a", 9), "2026-02-11T03:00:00Z")],
      suspension: {
        suspended_at: rizkySuspendedAt,
        reason: "Promosi berulang di grup alumni setelah peringatan.",
        member_message: "Akun Anda dibatasi karena melanggar pedoman komunitas.",
        suspended_by: SYSTEM_ADMIN,
      },
      moderation: {
        open_report_count: 2,
        total_report_count: 4,
        warning_count: 1,
        last_action_at: rizkySuspendedAt,
      },
      openAppeals: 1,
    }),
    seed({
      user_id: MOCK_MEMBER.dewi,
      full_name: "Dewi Lestari",
      email: "dewi.lestari@alumni.test",
      gender: "female",
      cohort: 25,
      class_in: 1,
      class_out: 6,
      seq: 12,
      city: "Duri",
      registered_at: "2025-08-01T04:00:00Z",
      periods: [activation(mockId("a", 10), "2025-08-02T03:00:00Z")],
      suspension: {
        suspended_at: dewiSuspendedAt,
        reason: "Menyebarkan data pribadi alumni lain.",
        member_message: "Akun Anda dibatasi sementara oleh pengurus.",
        suspended_by: SYSTEM_ADMIN,
      },
      moderation: {
        open_report_count: 0,
        total_report_count: 1,
        warning_count: 0,
        last_action_at: dewiSuspendedAt,
      },
    }),
    seed({
      user_id: MOCK_MEMBER.fikri,
      full_name: "Muhammad Fikri",
      email: "m.fikri@alumni.test",
      gender: "male",
      cohort: 18,
      class_in: 1,
      class_out: 6,
      seq: 13,
      city: "Pekanbaru",
      registered_at: "2024-10-20T04:00:00Z",
      profession_id: professionId("Dokter"),
      // Diperpanjang sekali dan kini tersisa < 30 hari (expiring, PRD 2.2).
      periods: (() => {
        const first = activation(mockId("a", 11), "2024-10-28T03:00:00Z");
        return [renewal(first, mockId("a", 12), "2025-10-20T03:00:00Z"), first];
      })(),
      recent_payments: [
        payment(12, "renewal", "paid", "2025-10-19T03:00:00Z", "2025-10-20T03:00:00Z"),
        payment(11, "registration", "paid", "2024-10-27T03:00:00Z", "2024-10-28T03:00:00Z"),
      ],
    }),
    seed({
      user_id: MOCK_MEMBER.fatimah,
      full_name: "Fatimah Zahra",
      email: "fatimah.zahra@alumni.test",
      gender: "female",
      cohort: 28,
      class_in: 1,
      class_out: 6,
      seq: null,
      city: null,
      account_status: "pending_otp",
      registered_at: "2026-10-12T08:00:00Z",
      last_login_at: null,
      sessions: 0,
    }),
    seed({
      user_id: MOCK_MEMBER.yusuf,
      full_name: "Yusuf Hamdani",
      email: "yusuf.hamdani@alumni.test",
      gender: "male",
      cohort: 14,
      class_in: 2,
      class_out: 6,
      seq: 14,
      city: "Rengat",
      account_status: "deletion_pending",
      registered_at: "2025-12-01T04:00:00Z",
      periods: [activation(mockId("a", 13), "2025-12-02T03:00:00Z")],
      sessions: 0,
    }),
  ];

  // Riwayat moderasi contoh: peringatan lalu suspend (AC F12-3).
  const rizky = list.find((m) => m.user_id === MOCK_MEMBER.rizky)!;
  rizky.events.push(
    moderationEvent("warn", "2026-09-20T04:00:00Z", "Promosi produk di grup alumni.", SYSTEM_ADMIN),
    moderationEvent(
      "suspend",
      rizkySuspendedAt,
      rizky.suspension!.reason ?? "Pelanggaran pedoman komunitas.",
      SYSTEM_ADMIN,
    ),
  );
  const dewi = list.find((m) => m.user_id === MOCK_MEMBER.dewi)!;
  dewi.events.push(moderationEvent("suspend", dewiSuspendedAt, dewi.suspension!.reason ?? "", SYSTEM_ADMIN));

  // Data sintetis agar paging kursor dapat dicoba (lebih lama dari data guideline).
  for (let i = 1; i <= 20; i += 1) {
    const n = String(i).padStart(2, "0");
    const approved = new Date(Date.UTC(2026, 4, i, 3)).toISOString();
    list.push(
      seed({
        user_id: mockId("8", i),
        full_name: `Alumni Contoh ${n}`,
        email: `alumni${n}@alumni.test`,
        gender: i % 2 === 0 ? "female" : "male",
        cohort: 10 + (i % 15),
        class_in: 1,
        class_out: 6,
        seq: 100 + i,
        city: i % 3 === 0 ? "Pekanbaru" : "Kampar",
        registered_at: new Date(Date.UTC(2025, 4, i, 1)).toISOString(),
        profession_id: i % 4 === 0 ? professionId("Guru") : null,
        periods: [activation(mockId("a", 100 + i), approved)],
      }),
    );
  }
  return list;
}

function masterFixtures(): MasterState[] {
  const at = "2026-01-05T02:00:00Z";
  const professions = PROFESSION_LABELS.map<MasterState>((label, i) => ({
    id: mockId("6", i + 1),
    kind: "professions",
    label,
    active: !INACTIVE_PROFESSIONS.has(label),
    sort_order: i * 10,
    version: 1,
    created_at: at,
    updated_at: at,
  }));
  const skills = SKILL_LABELS.map<MasterState>((label, i) => ({
    id: mockId("7", i + 1),
    kind: "skills",
    label,
    active: !INACTIVE_SKILLS.has(label),
    sort_order: i * 10,
    version: 1,
    created_at: at,
    updated_at: at,
  }));
  return [...professions, ...skills];
}

/** Kegagalan buatan (uji keadaan galat): permintaan yang cocok dijawab galat server `remaining` kali. */
let failures: { method: string; path: RegExp; status: number; remaining: number }[] = [];
/** Permintaan ditahan sampai dilepas (uji keadaan memuat). */
let held: Promise<void> | null = null;

export function reset(): void {
  memberRequests.length = 0;
  replays.clear();
  otpSends.clear();
  failures = [];
  held = null;
  eventSeq = 0;
  masterSeq = 100;
  masters = new Map(masterFixtures().map((m) => [m.id, m]));
  members = new Map(memberFixtures().map((m) => [m.user_id, m]));
}
reset();

/* ------------------------------------------------------------------------------------------------------------ */
/* Bentuk respons                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

function effectiveStatus(m: MemberState): EffectiveStatus {
  if (m.account_status === "pending_otp") return "pending_otp";
  if (m.account_status === "disabled") return "disabled";
  if (m.account_status === "deletion_pending" || m.account_status === "deleted") return "deletion_pending";
  if (m.suspension) return "suspended";
  if (!m.expires_at) return "unverified";
  const exp = Date.parse(m.expires_at);
  if (MEMBERS_MOCK_NOW >= exp) return "expired";
  if (exp - MEMBERS_MOCK_NOW <= EXPIRING_DAYS * DAY_MS) return "expiring";
  return "verified";
}

function masterRef(id: string): S["MasterItem"] | null {
  const m = masters.get(id);
  return m ? { id: m.id, label: m.label, active: m.active } : null;
}

/** Label profesi sesuai urutan; label master dibaca dari master (label historis, AC F10-4). */
function professionLabels(m: MemberState): string[] {
  return m.professions.map((e) =>
    e.profession_id ? (masters.get(e.profession_id)?.label ?? "") : (e.label ?? ""),
  );
}

/** Field lama `profession`: profesi pertama yang tertaut master. */
function primaryProfession(m: MemberState): S["MasterItem"] | null {
  const entry = m.professions.find((e) => e.profession_id !== null);
  return entry?.profession_id ? masterRef(entry.profession_id) : null;
}

/** Field lama `social_<platform>`: tautan pertama platform itu. */
function firstLink(m: MemberState, platform: S["SocialPlatform"]): string | null {
  return m.social_links.find((l) => l.platform === platform)?.value ?? null;
}

function summaryOf(m: MemberState): Summary {
  return {
    user_id: m.user_id,
    full_name: m.full_name,
    email: m.email,
    gender: m.gender,
    cohort: m.cohort,
    cohort_code: `KAPDH ${m.cohort}`,
    member_number: memberNumber(m),
    city: m.city,
    avatar_url: m.avatar_file_id ? avatarDataUrl(initialsOf(m.full_name)) : null,
    profession_label: professionLabels(m)[0] ?? null,
    account_status: m.account_status,
    effective_status: effectiveStatus(m),
    expires_at: m.expires_at,
    has_linked_admin: m.linked_admin !== null,
    registered_at: m.registered_at,
  };
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")
  ).toUpperCase();
}

/** Detail lengkap yang disaring per izin pemanggil (kontrak adminGetMember, PRD 2.3, AC F15-1). */
function present(m: MemberState): Detail {
  const canPayments = mockHasPermission("payments.read");
  const canEvents = mockHasPermission("events.manage");
  const canModeration = mockHasPermission("moderation.read");
  const grad = 1996 + m.cohort;
  return {
    ...summaryOf(m),
    class_in: m.class_in,
    class_out: m.class_out,
    education_status: educationStatus(m.class_in, m.class_out),
    entry_year: grad - (6 - m.class_in) - 1,
    exit_year: grad - (6 - m.class_out),
    graduation_year: grad,
    phone: m.phone,
    bio: m.bio,
    last_education_institution: m.education[0]?.institution ?? null,
    last_education_city: m.last_education_city,
    social_instagram: firstLink(m, "instagram"),
    social_x: firstLink(m, "x"),
    social_facebook: firstLink(m, "facebook"),
    social_linkedin: firstLink(m, "linkedin"),
    privacy: m.privacy,
    profession: primaryProfession(m),
    professions: professionLabels(m),
    education: m.education.map((e) => ({ ...e })),
    social_links: m.social_links.map((l) => ({ ...l })),
    skills: m.skill_ids.map(masterRef).filter((s): s is S["MasterItem"] => s !== null),
    avatar_file_id: m.avatar_file_id,
    email_verified_at: m.email_verified_at,
    last_login_at: m.last_login_at,
    starts_at: m.starts_at,
    renewal_opens_at: m.expires_at
      ? new Date(Date.parse(m.expires_at) - EXPIRING_DAYS * DAY_MS).toISOString()
      : null,
    suspension: m.suspension
      ? {
          suspended_at: m.suspension.suspended_at,
          reason: canModeration ? m.suspension.reason : null,
          reason_redacted: !canModeration,
          member_message: m.suspension.member_message,
          suspended_by: m.suspension.suspended_by,
        }
      : null,
    linked_admin: m.linked_admin,
    periods: [...m.periods],
    recent_payments: canPayments ? recentPayments(m).slice(0, 10) : null,
    recent_tickets: canEvents || canPayments ? m.recent_tickets.slice(0, 10) : null,
    moderation: canModeration ? m.moderation : null,
    version: String(m.version),
  };
}

function presentEvent(e: MembershipEvent): MembershipEvent {
  if (mockHasPermission("moderation.read")) return e;
  if (e.kind === "suspend" || e.kind === "unsuspend") return { ...e, reason: null, reason_redacted: true };
  return e;
}

function presentMaster(m: MasterState): MasterItem {
  return {
    id: m.id,
    kind: m.kind,
    label: m.label,
    active: m.active,
    sort_order: m.sort_order,
    usage_count: usageCount(m),
    version: String(m.version),
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

function usageCount(master: MasterState): number {
  let n = 0;
  for (const m of members.values()) {
    if (m.account_status === "deleted") continue;
    if (
      master.kind === "professions"
        ? m.professions.some((e) => e.profession_id === master.id)
        : m.skill_ids.includes(master.id)
    )
      n += 1;
  }
  return n;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Kendali uji                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** Kendali server tiruan untuk uji: membaca keadaan dan meniru perubahan oleh admin lain (AC F15-4). */
export const mockMembers = {
  get(userId: string): Detail | undefined {
    const m = members.get(userId);
    return m ? present(m) : undefined;
  },
  /** Data mentah (tanpa penyaringan izin) untuk pemeriksaan uji. */
  raw(userId: string): Readonly<MemberState> | undefined {
    return members.get(userId);
  },
  /** Admin lain mengubah anggota: versi naik sehingga formulir lama mendapat 409 VERSION_CONFLICT. */
  touchByOtherAdmin(userId: string, patch: Partial<Pick<MemberState, "city" | "phone" | "bio">> = {}): void {
    const m = members.get(userId);
    if (!m) return;
    Object.assign(m, patch);
    m.version += 1;
  },
  /**
   * Anggota meminta penghapusan akun (F-14) setelah halaman dimuat: users.status menjadi deletion_pending tanpa
   * menaikkan alumni.version, sehingga If-Match tetap cocok dan server menjawab prasyarat gagal (400).
   */
  requestDeletion(userId: string): void {
    const m = members.get(userId);
    if (m) m.account_status = "deletion_pending";
  },
  /**
   * Batas OTP email anggota habis (PRD 2.5): 5 pengiriman tercatat sehingga pengiriman berikutnya ditolak 429
   * RATE_LIMITED dengan retry_after_seconds = `retryAfterSeconds`.
   */
  exhaustOtpSends(userId: string, retryAfterSeconds: number): void {
    const m = members.get(userId);
    if (!m) return;
    const at = Date.now() - HOUR_MS + retryAfterSeconds * 1000;
    otpSends.set(
      m.email,
      Array.from({ length: OTP_SENDS_PER_HOUR }, () => at),
    );
  },
  master(id: string): MasterItem | undefined {
    const m = masters.get(id);
    return m ? presentMaster(m) : undefined;
  },
  /** Admin lain mengubah master (versi naik). */
  touchMasterByOtherAdmin(id: string, patch: Partial<Pick<MasterState, "label" | "active">> = {}): void {
    const m = masters.get(id);
    if (!m) return;
    Object.assign(m, patch);
    m.version += 1;
  },
  /** Anggota mulai memakai master (mis. memilih keahlian di profil) setelah daftar dimuat. */
  useMaster(userId: string, masterId: string): void {
    const m = members.get(userId);
    const master = masters.get(masterId);
    if (!m || !master) return;
    if (master.kind === "professions") {
      if (!m.professions.some((e) => e.profession_id === masterId))
        m.professions = [...m.professions, { profession_id: masterId, label: null }];
    } else if (!m.skill_ids.includes(masterId)) m.skill_ids = [...m.skill_ids, masterId];
  },
  /** Permintaan `method` yang path-nya cocok dijawab galat server (bawaan 500) sebanyak `times` kali. */
  fail(method: string, path: RegExp, status = 500, times = 1): void {
    failures.push({ method, path, status, remaining: times });
  },
  /** Tahan semua permintaan anggota/master sampai fungsi yang dikembalikan dipanggil. */
  hold(): () => void {
    let release: () => void = () => undefined;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      held = null;
      release();
    };
  },
};

/* ------------------------------------------------------------------------------------------------------------ */
/* Akses lintas tiruan (pembayaran)                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Identitas dan status keanggotaan anggota tiruan untuk area pembayaran (baca saja). Tiruan payments memakai anggota
 * yang SAMA (user_id sama) untuk payment contoh Siti, Hendra, Muhammad Fikri dan Nur, untuk pencatatan iuran
 * D13 (adminRecordPayment) dan untuk keputusan iuran, sehingga tautan antara detail anggota dan Verifikasi
 * Pembayaran menunjuk data yang sama di dev:mock.
 */
export interface MockMemberSnapshot {
  user_id: string;
  full_name: string;
  member_number: string | null;
  cohort: number;
  account_status: S["AccountStatus"];
  effective_status: EffectiveStatus;
  expires_at: string | null;
  /** Admin yang tertaut ke akun alumni ini (konflik kepentingan, PRD 2.3). */
  linked_admin_id: string | null;
}

export function peekMemberForMocks(userId: string): MockMemberSnapshot | undefined {
  const m = members.get(userId);
  if (!m) return undefined;
  return {
    user_id: m.user_id,
    full_name: m.full_name,
    member_number: memberNumber(m),
    cohort: m.cohort,
    account_status: m.account_status,
    effective_status: effectiveStatus(m),
    expires_at: m.expires_at,
    linked_admin_id: m.linked_admin?.admin_id ?? null,
  };
}

/**
 * Sumber ringkasan pembayaran anggota dari tiruan payments. Didaftarkan oleh payments.ts (yang mengimpor berkas ini)
 * agar tidak ada impor melingkar; tanpa sumber hanya data historis anggota yang tampil.
 */
type MemberPaymentsSource = (userId: string) => S["AdminMemberPaymentSummary"][];
let memberPaymentsSource: MemberPaymentsSource | null = null;

export function registerMemberPaymentsSourceForMocks(source: MemberPaymentsSource | null): void {
  memberPaymentsSource = source;
}

/** Pembayaran terbaru: data historis anggota + payment tiruan payments milik anggota ini, terbaru dahulu. */
function recentPayments(m: MemberState): S["AdminMemberPaymentSummary"][] {
  const live = memberPaymentsSource?.(m.user_id) ?? [];
  const ids = new Set(live.map((p) => p.id));
  return [...live, ...m.recent_payments.filter((p) => !ids.has(p.id))].sort(
    (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
  );
}

/**
 * Iuran anggota menjadi paid (keputusan pengurus atau pencatatan D13): periode baru seperti handler keanggotaan
 * server (PRD 4.2): aktivasi dari approved_at, perpanjangan dari max(expires_at lama, approved_at), 12 bulan.
 */
export function applyPaidDuesForMocks(
  userId: string,
  input: { paymentId: string; type: "registration" | "renewal"; approvedAt: string },
): void {
  const m = members.get(userId);
  if (!m) return;
  const prev = m.periods[0] ?? null;
  const period =
    input.type === "renewal" && prev
      ? renewal(prev, input.paymentId, input.approvedAt)
      : activation(input.paymentId, input.approvedAt);
  m.periods = [period, ...m.periods];
  m.starts_at = period.starts_at;
  m.expires_at = period.expires_at;
  m.events = [...m.events, { ...periodEvent(period, prev), actor: mockAdminRef() }];
  m.version += 1;
}

/** Bungkus handler: tahanan dan kegagalan buatan diterapkan sebelum logika server tiruan. */
function controlled(route: MockRoute): MockRoute {
  return {
    ...route,
    handler: async (req) => {
      if (held) await held;
      const failure = failures.find(
        (f) => f.method === req.method && f.path.test(req.path) && f.remaining > 0,
      );
      if (failure) {
        failure.remaining -= 1;
        log(req);
        return error(failure.status, "INTERNAL_ERROR", "Terjadi kesalahan. Coba lagi.");
      }
      return route.handler(req);
    },
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Validasi                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

const PHONE = /^\+?[0-9][0-9 -]{5,22}$/;
const SOCIAL_HANDLE =
  /^(?:@?[A-Za-z0-9._-]{1,100}|https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[/?#][^\s<>"'`]*)?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FieldErrors = Record<string, string[]>;

function validationError(
  fieldErrors: FieldErrors,
  message = "Periksa kembali isian yang ditandai.",
): Response {
  return error(400, "VALIDATION_ERROR", message, { field_errors: fieldErrors });
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** Teks yang dipangkas dengan batas panjang; `undefined` bila valid, pesan galat bila tidak. */
function textError(v: unknown, label: string, min: number, max: number): string | undefined {
  if (typeof v !== "string") return `${label} tidak valid.`;
  const t = v.trim();
  if (t.length < min) return min <= 1 ? `${label} wajib diisi.` : `${label} minimal ${min} karakter.`;
  if (v.length > max) return `${label} maksimal ${max} karakter.`;
  return undefined;
}

function nullableText(v: unknown, label: string, min: number, max: number): string | undefined {
  return v === null ? undefined : textError(v, label, min, max);
}

const UPDATE_KEYS = new Set([
  "reason",
  "full_name",
  "gender",
  "cohort",
  "class_in",
  "class_out",
  "city",
  "phone",
  "bio",
  "professions",
  "education",
  "social_links",
  "last_education_institution",
  "last_education_city",
  "social_instagram",
  "social_x",
  "social_facebook",
  "social_linkedin",
  "profession_id",
  "skill_ids",
  "remove_avatar",
]);
const SOCIAL_KEYS = ["social_instagram", "social_x", "social_facebook", "social_linkedin"] as const;
const LEGACY_PLATFORM: Record<(typeof SOCIAL_KEYS)[number], S["SocialPlatform"]> = {
  social_instagram: "instagram",
  social_x: "x",
  social_facebook: "facebook",
  social_linkedin: "linkedin",
};
/** Field lama per daftar penggantinya; dikirim bersama penggantinya -> 400 pada field lama (seperti server). */
const LEGACY_FIELDS: Record<"professions" | "education" | "social_links", readonly string[]> = {
  professions: ["profession_id"],
  education: ["last_education_institution", "last_education_city"],
  social_links: SOCIAL_KEYS,
};
const SOCIAL_PLATFORMS: readonly S["SocialPlatform"][] = [
  "instagram",
  "tiktok",
  "x",
  "facebook",
  "linkedin",
  "youtube",
  "threads",
  "telegram",
  "website",
];
const EDUCATION_LEVELS: readonly S["EducationLevel"][] = ["d3", "s1", "s2", "s3", "other"];
const MAX_PROFESSIONS = 5;
const MAX_LIST = 10;

/** Nama pengguna disimpan tanpa @ di depan (aturan SocialHandle); URL https apa adanya. */
function normalizeHandle(v: string): string {
  const t = v.trim();
  return t.startsWith("https://") ? t : t.replace(/^@/, "");
}

/** Tahun berjalan Asia/Jakarta: batas atas tahun tamat (kontrak EducationEntryInput). */
function jakartaYear(now = new Date()): number {
  return new Date(now.getTime() + 7 * 3_600_000).getUTCFullYear();
}

/** Urutan tersimpan server: tahun tamat menurun, entri tanpa tahun di atas, tahun sama mengikuti urutan kiriman. */
function sortEducation(entries: S["EducationEntry"][]): S["EducationEntry"][] {
  const rank = (e: S["EducationEntry"]) => e.graduation_year ?? Number.MAX_SAFE_INTEGER;
  return [...entries].sort((a, b) => rank(b) - rank(a));
}

function validateLists(body: Record<string, unknown>, errors: FieldErrors): void {
  for (const [list, legacy] of Object.entries(LEGACY_FIELDS)) {
    if (!(list in body)) continue;
    for (const key of legacy)
      if (key in body)
        errors[key] = [`Field lama ini tidak dapat dikirim bersama ${list}. Kirim ${list} saja.`];
  }
  if ("professions" in body) {
    const list = body.professions;
    if (!Array.isArray(list) || list.length > MAX_PROFESSIONS)
      errors.professions = [`Maksimal ${MAX_PROFESSIONS} profesi.`];
    else {
      list.forEach((v, i) => {
        const e = textError(v, "Profesi", 1, 100);
        if (e) errors[`professions.${i}`] = [e];
      });
      const keys = list.map((v) => String(v).trim().toLowerCase());
      if (new Set(keys).size !== keys.length) errors.professions = ["Profesi tidak boleh ganda."];
    }
  }
  if ("education" in body) {
    const list = body.education;
    if (!Array.isArray(list) || list.length > MAX_LIST)
      errors.education = [`Maksimal ${MAX_LIST} riwayat pendidikan.`];
    else
      list.forEach((raw, i) => {
        const entry = (raw ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(entry))
          if (!["institution", "major", "level", "graduation_year"].includes(key))
            errors[`education.${i}`] = ["Field tidak dikenal."];
        const inst = textError(entry.institution, "Universitas/instansi", 1, 120);
        if (inst) errors[`education.${i}.institution`] = [inst];
        if (entry.major !== undefined) {
          const major = nullableText(entry.major, "Jurusan", 1, 120);
          if (major) errors[`education.${i}.major`] = [major];
        }
        if (
          entry.level !== undefined &&
          entry.level !== null &&
          !EDUCATION_LEVELS.includes(entry.level as S["EducationLevel"])
        )
          errors[`education.${i}.level`] = ["Strata tidak dikenal."];
        if (
          entry.graduation_year !== undefined &&
          entry.graduation_year !== null &&
          !isInt(entry.graduation_year, 1950, jakartaYear())
        )
          errors[`education.${i}.graduation_year`] = ["Tahun tamat tidak boleh melewati tahun ini."];
      });
  }
  if ("social_links" in body) {
    const list = body.social_links;
    if (!Array.isArray(list) || list.length > MAX_LIST)
      errors.social_links = [`Maksimal ${MAX_LIST} tautan.`];
    else {
      const seen = new Set<string>();
      list.forEach((raw, i) => {
        const link = (raw ?? {}) as Record<string, unknown>;
        if (!SOCIAL_PLATFORMS.includes(link.platform as S["SocialPlatform"]))
          errors[`social_links.${i}.platform`] = ["Platform tidak dikenal."];
        const v = link.value;
        if (typeof v !== "string" || v.length > 200 || !SOCIAL_HANDLE.test(v))
          errors[`social_links.${i}.value`] = ["Isi nama pengguna atau tautan https:// yang valid."];
        else if (link.platform === "website" && !v.startsWith("https://"))
          errors[`social_links.${i}.value`] = ["Situs web harus berupa tautan https://"];
        else {
          const key = `${String(link.platform)}:${normalizeHandle(v).toLowerCase()}`;
          if (seen.has(key)) errors[`social_links.${i}.value`] = ["Tautan ini sudah ada."];
          seen.add(key);
        }
      });
    }
  }
}

/** Label yang sama dengan master aktif (atau master nonaktif yang sudah terpasang) ditautkan ke master itu. */
function resolveProfessions(labels: string[], m: MemberState): ProfessionEntry[] {
  const attached = new Set(m.professions.map((e) => e.profession_id).filter((id) => id !== null));
  return labels.map((raw) => {
    const label = raw.trim();
    const master = sameLabel("professions", label);
    return master && (master.active || attached.has(master.id))
      ? { profession_id: master.id, label: null }
      : { profession_id: null, label };
  });
}

/** Field lama social_<platform>: ganti tautan pertama platform itu, tambah di akhir, atau hapus (null). */
function applyLegacySocial(m: MemberState, platform: S["SocialPlatform"], value: string | null): void {
  const index = m.social_links.findIndex((l) => l.platform === platform);
  if (value === null) {
    if (index >= 0) m.social_links = m.social_links.filter((_, i) => i !== index);
    return;
  }
  const first = m.social_links[index];
  if (first)
    m.social_links = m.social_links
      .filter((l) => l === first || l.platform !== platform || l.value.toLowerCase() !== value.toLowerCase())
      .map((l) => (l === first ? { ...l, value } : l));
  else if (m.social_links.length < MAX_LIST) m.social_links = [...m.social_links, { platform, value }];
}

function unknownKeys(body: Record<string, unknown>, allowed: Set<string>, errors: FieldErrors): void {
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue;
    errors[key] =
      key === "member_number"
        ? ["Nomor anggota dihitung server dan tidak dapat dikirim (AC F05-6)."]
        : ["Field ini tidak dapat diubah di sini."];
  }
}

/** Validasi AdminMemberUpdate seperti server (kontrak adminUpdateMember). */
function validateUpdate(body: Record<string, unknown>, m: MemberState): FieldErrors {
  const errors: FieldErrors = {};
  unknownKeys(body, UPDATE_KEYS, errors);
  const reason = textError(body.reason, "Alasan", 3, 500);
  if (reason) errors.reason = [reason];
  if (Object.keys(body).filter((k) => k !== "reason").length === 0)
    errors._ = ["Tidak ada perubahan yang dikirim."];
  if ("full_name" in body) {
    const e = textError(body.full_name, "Nama lengkap", 2, 120);
    if (e) errors.full_name = [e];
  }
  if ("gender" in body && body.gender !== "male" && body.gender !== "female")
    errors.gender = ["Jenis kelamin tidak valid."];
  // Kernel server menolak angkatan setelah tahun berjalan (tahun Jakarta - 1996, PRD 3.5).
  if ("cohort" in body && !isInt(body.cohort, 1, serverLatestCohort()))
    errors.cohort = [`Angkatan harus 1 sampai ${serverLatestCohort()}.`];
  if ("class_in" in body && !isInt(body.class_in, 1, 6)) errors.class_in = ["Kelas masuk harus 1 sampai 6."];
  if ("class_out" in body && !isInt(body.class_out, 1, 6))
    errors.class_out = ["Kelas keluar harus 1 sampai 6."];
  const classIn = isInt(body.class_in, 1, 6) ? body.class_in : m.class_in;
  const classOut = isInt(body.class_out, 1, 6) ? body.class_out : m.class_out;
  if (!errors.class_out && classOut < classIn)
    errors.class_out = ["Kelas keluar tidak boleh lebih rendah dari kelas masuk."];
  if ("city" in body) {
    const e = nullableText(body.city, "Kota", 1, 80);
    if (e) errors.city = [e];
  }
  if ("phone" in body && body.phone !== null) {
    if (typeof body.phone !== "string" || body.phone.length > 24 || !PHONE.test(body.phone))
      errors.phone = ["Nomor telepon tidak valid. Contoh: +62 812-3456-7890."];
  }
  if ("bio" in body && body.bio !== null && (typeof body.bio !== "string" || body.bio.length > 500))
    errors.bio = ["Bio maksimal 500 karakter."];
  validateLists(body, errors);
  if ("last_education_institution" in body) {
    const e = nullableText(body.last_education_institution, "Institusi pendidikan", 1, 120);
    if (e) errors.last_education_institution = [e];
  }
  if ("last_education_city" in body) {
    const e = nullableText(body.last_education_city, "Kota pendidikan", 1, 80);
    if (e) errors.last_education_city = [e];
  }
  for (const key of SOCIAL_KEYS) {
    if (!(key in body) || body[key] === null) continue;
    const v = body[key];
    if (typeof v !== "string" || v.length > 200 || !SOCIAL_HANDLE.test(v))
      errors[key] = ["Isi nama pengguna atau tautan https:// yang valid."];
  }
  if ("profession_id" in body && body.profession_id !== null && !errors.profession_id) {
    const id = body.profession_id;
    const master = typeof id === "string" ? masters.get(id) : undefined;
    const current = primaryProfession(m)?.id ?? null;
    if (!master || master.kind !== "professions") errors.profession_id = ["Profesi tidak ditemukan."];
    else if (!master.active && current !== id)
      errors.profession_id = ["Profesi ini sudah nonaktif dan tidak dapat dipilih (AC F10-4)."];
    else if (
      current !== id &&
      m.professions.filter((e) => e.profession_id !== current).length >= MAX_PROFESSIONS
    )
      errors.profession_id = ["Daftar profesi sudah penuh (maksimal 5)."];
  }
  if ("skill_ids" in body) {
    const ids = body.skill_ids;
    if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length)
      errors.skill_ids = ["Pilih paling banyak 10 keahlian berbeda."];
    else
      for (const id of ids) {
        const master = typeof id === "string" ? masters.get(id) : undefined;
        if (!master || master.kind !== "skills") {
          errors.skill_ids = ["Keahlian tidak ditemukan."];
          break;
        }
        if (!master.active && !m.skill_ids.includes(id as string)) {
          errors.skill_ids = [
            `Keahlian "${master.label}" sudah nonaktif dan tidak dapat dipilih (AC F10-4).`,
          ];
          break;
        }
      }
  }
  if ("remove_avatar" in body && typeof body.remove_avatar !== "boolean")
    errors.remove_avatar = ["Nilai tidak valid."];
  return errors;
}

function nextEventId(): string {
  eventSeq += 1;
  return mockId("9", eventSeq);
}

function linkedToCaller(m: MemberState): boolean {
  return m.linked_admin?.admin_id === mockAdminRef().admin_id;
}

function conflictOfInterest(): Response {
  return error(
    403,
    "FORBIDDEN",
    "Akun alumni ini tertaut ke akun admin Anda. Mintalah pengurus lain untuk tindakan ini.",
  );
}

function versionConflict(m: MemberState): Response {
  return error(409, "VERSION_CONFLICT", "Data anggota sudah diubah admin lain. Muat ulang data terbaru.", {
    current: present(m),
  });
}

/**
 * Prasyarat tindakan gagal dengan keadaan terkini, bentuk MembershipKernel server (preconditionFailed): 400
 * VALIDATION_ERROR TANPA field_errors, dengan `current` {suspended_at, account_status, version}.
 */
function preconditionFailed(m: MemberState, message: string): Response {
  return error(400, "VALIDATION_ERROR", message, {
    current: {
      suspended_at: m.suspension?.suspended_at ?? null,
      account_status: m.account_status,
      version: String(m.version),
    },
  });
}

function requireAll(req: MockRequest, permissions: Permission[]): Response | null {
  for (const p of permissions) {
    const denied = requirePermission(req, p);
    if (denied) return denied;
  }
  return null;
}

/** Putar ulang hasil pertama untuk Idempotency-Key yang sama (payload berbeda -> 409 IDEMPOTENCY_CONFLICT). */
function replayOf(
  req: MockRequest,
  scope: string,
): { key: string | null; payload: string; hit: Response | null } {
  const key = req.headers.get("Idempotency-Key");
  const payload = JSON.stringify([scope, req.params, req.body]);
  const replay = key ? replays.get(key) : undefined;
  if (!replay) return { key, payload, hit: null };
  if (replay.payload !== payload)
    return {
      key,
      payload,
      hit: error(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah dipakai untuk permintaan lain."),
    };
  return { key, payload, hit: json(replay.status, replay.body) };
}

function remember(key: string | null, payload: string, status: number, body: unknown): void {
  if (key) replays.set(key, { payload, status, body });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Urutan dan filter daftar                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

function numberKey(m: MemberState): number[] | null {
  const n = memberNumber(m);
  return n ? n.split(".").map(Number) : null;
}

function compareNullableIso(a: string | null, b: string | null, dir: 1 | -1): number {
  // expires_at null (belum paid) diletakkan di akhir untuk kedua arah (kontrak AdminMemberSort).
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b) * dir;
}

function sorter(sort: S["AdminMemberSort"]): (a: MemberState, b: MemberState) => number {
  return (a, b) => {
    let c = 0;
    switch (sort) {
      case "registered_asc":
        c = a.registered_at.localeCompare(b.registered_at);
        break;
      case "name_asc":
        c = a.full_name.localeCompare(b.full_name, "id");
        break;
      case "name_desc":
        c = b.full_name.localeCompare(a.full_name, "id");
        break;
      case "cohort_asc":
        c = a.cohort - b.cohort;
        break;
      case "cohort_desc":
        c = b.cohort - a.cohort;
        break;
      case "member_number_asc": {
        const ka = numberKey(a);
        const kb = numberKey(b);
        if (!ka || !kb) c = ka ? -1 : kb ? 1 : 0;
        else for (let i = 0; i < 4 && c === 0; i += 1) c = (ka[i] ?? 0) - (kb[i] ?? 0);
        break;
      }
      case "expires_at_asc":
        c = compareNullableIso(a.expires_at, b.expires_at, 1);
        break;
      case "expires_at_desc":
        c = compareNullableIso(a.expires_at, b.expires_at, -1);
        break;
      default:
        c = b.registered_at.localeCompare(a.registered_at);
    }
    // Setiap urutan diakhiri user_id agar keyset stabil.
    return c !== 0 ? c : a.user_id.localeCompare(b.user_id);
  };
}

const EFFECTIVE_STATUSES: EffectiveStatus[] = [
  "pending_otp",
  "unverified",
  "verified",
  "expiring",
  "expired",
  "suspended",
  "disabled",
  "deletion_pending",
];
const MEMBER_SORTS: S["AdminMemberSort"][] = [
  "registered_desc",
  "registered_asc",
  "name_asc",
  "name_desc",
  "cohort_asc",
  "cohort_desc",
  "member_number_asc",
  "expires_at_asc",
  "expires_at_desc",
];

function bool(value: string | null): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Master                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

function kindOf(req: MockRequest): MasterKind | null {
  const k = req.params.kind;
  return k === "professions" || k === "skills" ? k : null;
}

function sameLabel(kind: MasterKind, label: string, exceptId?: string): MasterState | undefined {
  const needle = label.trim().toLowerCase();
  return [...masters.values()].find(
    (m) => m.kind === kind && m.id !== exceptId && m.label.toLowerCase() === needle,
  );
}

function duplicateLabel(kind: MasterKind): Response {
  return error(409, "VALIDATION_ERROR", "Label sudah ada.", {
    field_errors: {
      label: [
        kind === "professions"
          ? "Profesi dengan label ini sudah ada (termasuk yang nonaktif). Aktifkan kembali profesi lama."
          : "Keahlian dengan label ini sudah ada (termasuk yang nonaktif). Aktifkan kembali keahlian lama.",
      ],
    },
  });
}

function masterSorter(sort: string | null): (a: MasterItem, b: MasterItem) => number {
  return (a, b) => {
    let c = 0;
    if (sort === "label_asc") c = a.label.localeCompare(b.label, "id");
    else if (sort === "label_desc") c = b.label.localeCompare(a.label, "id");
    else if (sort === "usage_desc") c = b.usage_count - a.usage_count || a.label.localeCompare(b.label, "id");
    else c = a.sort_order - b.sort_order || a.label.localeCompare(b.label, "id");
    return c !== 0 ? c : a.id.localeCompare(b.id);
  };
}

const MASTER_CREATE_KEYS = new Set(["label", "active", "sort_order"]);

function validateMasterBody(body: Record<string, unknown>, requireLabel: boolean): FieldErrors {
  const errors: FieldErrors = {};
  unknownKeys(body, MASTER_CREATE_KEYS, errors);
  if (requireLabel || "label" in body) {
    const e = textError(body.label, "Label", 1, 100);
    if (e) errors.label = [e];
    else if ((body.label as string).trim().length > 100) errors.label = ["Label maksimal 100 karakter."];
  }
  if ("active" in body && typeof body.active !== "boolean") errors.active = ["Nilai tidak valid."];
  if ("sort_order" in body && !isInt(body.sort_order, -32768, 32767))
    errors.sort_order = ["Urutan harus bilangan bulat -32768 sampai 32767."];
  if (!requireLabel && Object.keys(body).length === 0) errors._ = ["Tidak ada perubahan yang dikirim."];
  return errors;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Rute                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

function notFound(): Response {
  return error(404, "NOT_FOUND", "Data tidak ditemukan.");
}

function findMember(req: MockRequest): MemberState | undefined {
  const m = members.get(req.params.userId ?? "");
  return m && m.account_status !== "deleted" ? m : undefined;
}

const memberRoutes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/members",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "members.read");
      if (denied) return denied;
      const p = req.url.searchParams;
      const fieldErrors: FieldErrors = {};
      const q = (p.get("q") ?? "").trim().toLowerCase();
      const cohortRaw = p.get("cohort");
      const cohort = cohortRaw === null ? null : Number(cohortRaw);
      if (cohort !== null && !isInt(cohort, 1, 99)) fieldErrors.cohort = ["Angkatan harus 1 sampai 99."];
      const status = p.get("effective_status");
      if (status !== null && !EFFECTIVE_STATUSES.includes(status as EffectiveStatus))
        fieldErrors.effective_status = ["Status tidak dikenal."];
      const sort = (p.get("sort") ?? "registered_desc") as S["AdminMemberSort"];
      if (!MEMBER_SORTS.includes(sort)) fieldErrors.sort = ["Urutan tidak dikenal."];
      const professionFilter = p.get("profession_id");
      const skillFilter = p.get("skill_id");
      for (const [key, v] of [
        ["profession_id", professionFilter],
        ["skill_id", skillFilter],
      ] as const)
        if (v !== null && !UUID.test(v)) fieldErrors[key] = ["ID tidak valid."];
      if (Object.keys(fieldErrors).length > 0) return validationError(fieldErrors);
      const city = (p.get("city") ?? "").trim().toLowerCase();
      const gender = p.get("gender");
      const linked = bool(p.get("has_linked_admin"));
      const items = [...members.values()]
        .filter((m) => m.account_status !== "deleted")
        .filter((m) => cohort === null || m.cohort === cohort)
        .filter((m) => status === null || effectiveStatus(m) === status)
        .filter((m) => !city || (m.city ?? "").toLowerCase() === city)
        .filter((m) => !gender || m.gender === gender)
        // Profesi boleh lebih dari satu: cocok bila salah satunya tertaut master ini.
        .filter((m) => !professionFilter || m.professions.some((e) => e.profession_id === professionFilter))
        .filter((m) => !skillFilter || m.skill_ids.includes(skillFilter))
        .filter((m) => linked === undefined || (m.linked_admin !== null) === linked)
        // Nama/email/kota sebagian tanpa beda huruf besar, atau awalan nomor anggota.
        .filter(
          (m) =>
            !q ||
            m.full_name.toLowerCase().includes(q) ||
            m.email.toLowerCase().includes(q) ||
            (m.city ?? "").toLowerCase().includes(q) ||
            (memberNumber(m) ?? "").startsWith(q),
        )
        .sort(sorter(sort))
        .map(summaryOf);
      return json(200, paginate(items, req.url) satisfies S["AdminMemberPage"]);
    },
  },
  {
    method: "GET",
    path: "/admin/members/{userId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "members.read");
      if (denied) return denied;
      const m = findMember(req);
      return m ? json(200, present(m)) : notFound();
    },
  },
  {
    method: "PATCH",
    path: "/admin/members/{userId}",
    handler: (req) => {
      log(req);
      const denied = requireAll(req, ["members.read", "members.manage"]);
      if (denied) return denied;
      const m = findMember(req);
      if (!m) return notFound();
      if (linkedToCaller(m)) return conflictOfInterest();
      const body = req.body ?? {};
      const fieldErrors = validateUpdate(body, m);
      if (Object.keys(fieldErrors).length > 0) return validationError(fieldErrors);
      if (req.headers.get("If-Match") !== String(m.version)) return versionConflict(m);
      // Bentuk server (AdminMembersService.update): galat akar `_` tanpa `current`.
      if (m.account_status === "deletion_pending")
        return validationError(
          { _: ["Akun sedang dalam proses penghapusan dan tidak dapat diubah."] },
          "Akun sedang dalam proses penghapusan dan tidak dapat diubah.",
        );

      const before = memberNumber(m);
      const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : null);
      if ("full_name" in body) m.full_name = str("full_name")!;
      if ("gender" in body) m.gender = body.gender as Gender;
      if ("cohort" in body) m.cohort = body.cohort as number;
      if ("class_in" in body) m.class_in = body.class_in as number;
      if ("class_out" in body) m.class_out = body.class_out as number;
      if ("city" in body) m.city = str("city");
      if ("phone" in body) m.phone = str("phone");
      if ("bio" in body) m.bio = str("bio") || null;
      // Daftar pengganti seluruhnya; institusi teratas berganti -> kota lulusan lama dikosongkan (seperti server).
      if ("professions" in body) m.professions = resolveProfessions(body.professions as string[], m);
      if ("education" in body) {
        const next = sortEducation(
          (body.education as Record<string, unknown>[]).map((e) => ({
            institution: String(e.institution).trim(),
            major: typeof e.major === "string" ? e.major.trim() : null,
            level: (e.level as S["EducationLevel"] | null | undefined) ?? null,
            graduation_year: (e.graduation_year as number | null | undefined) ?? null,
          })),
        );
        if (next[0]?.institution !== m.education[0]?.institution) m.last_education_city = null;
        m.education = next;
      }
      if ("social_links" in body)
        m.social_links = (body.social_links as { platform: S["SocialPlatform"]; value: string }[]).map(
          (l) => ({
            platform: l.platform,
            value: normalizeHandle(l.value),
          }),
        );
      // Field lama aplikasi 1.0.0: mengubah satu entri padanannya.
      if ("last_education_institution" in body) {
        const inst = str("last_education_institution");
        const [top, ...rest] = m.education;
        if (inst === null) m.education = rest;
        else if (top) m.education = [{ ...top, institution: inst }, ...rest];
        else m.education = [{ institution: inst, major: null, level: null, graduation_year: null }];
      }
      if ("last_education_city" in body) m.last_education_city = str("last_education_city");
      for (const key of SOCIAL_KEYS)
        if (key in body) {
          const v = str(key);
          applyLegacySocial(m, LEGACY_PLATFORM[key], v ? normalizeHandle(v) : null);
        }
      if ("profession_id" in body) {
        const id = (body.profession_id as string | null) ?? null;
        const current = primaryProfession(m)?.id ?? null;
        if (id !== current) {
          const label = id ? (masters.get(id)?.label.toLowerCase() ?? "") : "";
          // Ketikan sendiri berlabel sama dengan master baru digantikan entri bertaut master.
          const rest = m.professions.filter(
            (e) => e.profession_id !== current && !(e.label !== null && e.label.toLowerCase() === label),
          );
          m.professions = id ? [{ profession_id: id, label: null }, ...rest] : rest;
        }
      }
      if ("skill_ids" in body) m.skill_ids = [...(body.skill_ids as string[])];
      if (body.remove_avatar === true) m.avatar_file_id = null;
      const after = memberNumber(m);
      if (before !== after)
        // Satu transaksi: nomor baru dengan N tetap, histori number_correction, audit, QR baru (AC F05-6).
        m.events.push({
          id: nextEventId(),
          kind: "number_correction",
          created_at: new Date().toISOString(),
          actor: mockAdminRef(),
          payment_id: null,
          reason: (body.reason as string).trim(),
          reason_redacted: false,
          before_starts_at: null,
          after_starts_at: null,
          before_expires_at: null,
          after_expires_at: null,
          before_member_number: before,
          after_member_number: after,
        });
      m.version += 1;
      return json(200, present(m));
    },
  },
  {
    method: "POST",
    path: "/admin/members/{userId}/suspend",
    handler: (req) => {
      log(req);
      const denied = requireAll(req, ["members.read", "moderation.read", "moderation.resolve"]);
      if (denied) return denied;
      const m = findMember(req);
      if (!m) return notFound();
      if (linkedToCaller(m)) return conflictOfInterest();
      const { key, payload, hit } = replayOf(req, "suspend");
      if (hit) return hit;
      const body = req.body ?? {};
      const fieldErrors: FieldErrors = {};
      unknownKeys(body, new Set(["reason", "member_message", "confirm"]), fieldErrors);
      const reason = textError(body.reason, "Alasan internal", 3, 1000);
      if (reason) fieldErrors.reason = [reason];
      const message = textError(body.member_message, "Pesan untuk anggota", 3, 500);
      if (message) fieldErrors.member_message = [message];
      if (body.confirm !== true) fieldErrors.confirm = ["Konfirmasi tindakan wajib."];
      if (Object.keys(fieldErrors).length > 0) return validationError(fieldErrors);
      if (req.headers.get("If-Match") !== String(m.version)) return versionConflict(m);
      // Prasyarat MembershipKernel.suspend (urutan dan bentuk sama dengan server).
      if (m.account_status === "deletion_pending")
        return preconditionFailed(m, "Akun sedang dalam proses penghapusan dan tidak dapat dibatasi.");
      if (m.suspension) return preconditionFailed(m, "Anggota sudah dalam status dibatasi.");
      const at = new Date().toISOString();
      // Satu transaksi: kolom suspend, histori, audit, notifikasi; tanggal periode tidak diubah (PRD 4.2).
      m.suspension = {
        suspended_at: at,
        reason: (body.reason as string).trim(),
        member_message: (body.member_message as string).trim(),
        suspended_by: mockAdminRef(),
      };
      m.events.push(moderationEvent("suspend", at, (body.reason as string).trim(), mockAdminRef()));
      m.moderation = { ...m.moderation, last_action_at: at };
      // Setelah commit seluruh sesi umum dicabut (session.revoked account_suspended, AC F12-4).
      m.sessions = 0;
      m.version += 1;
      const result = present(m);
      remember(key, payload, 200, result);
      return json(200, result);
    },
  },
  {
    method: "POST",
    path: "/admin/members/{userId}/unsuspend",
    handler: (req) => {
      log(req);
      const denied = requireAll(req, ["members.read", "moderation.read", "moderation.resolve"]);
      if (denied) return denied;
      const m = findMember(req);
      if (!m) return notFound();
      if (linkedToCaller(m)) return conflictOfInterest();
      const { key, payload, hit } = replayOf(req, "unsuspend");
      if (hit) return hit;
      const body = req.body ?? {};
      const fieldErrors: FieldErrors = {};
      unknownKeys(body, new Set(["reason", "member_message", "confirm"]), fieldErrors);
      const reason = textError(body.reason, "Alasan", 3, 1000);
      if (reason) fieldErrors.reason = [reason];
      if ("member_message" in body) {
        const message = textError(body.member_message, "Pesan untuk anggota", 3, 500);
        if (message) fieldErrors.member_message = [message];
      }
      if (body.confirm !== true) fieldErrors.confirm = ["Konfirmasi tindakan wajib."];
      if (Object.keys(fieldErrors).length > 0) return validationError(fieldErrors);
      if (req.headers.get("If-Match") !== String(m.version)) return versionConflict(m);
      if (!m.suspension) return preconditionFailed(m, "Anggota tidak sedang dibatasi.");
      const at = new Date().toISOString();
      // Satu transaksi: kolom suspend dikosongkan, histori, banding aktif ditutup sebagai dikabulkan (AC F12-5).
      m.suspension = null;
      m.events.push(moderationEvent("unsuspend", at, (body.reason as string).trim(), mockAdminRef()));
      const closed = m.openAppeals;
      m.openAppeals = 0;
      m.moderation = {
        ...m.moderation,
        open_report_count: Math.max(0, m.moderation.open_report_count - closed),
        last_action_at: at,
      };
      m.version += 1;
      const result = present(m);
      remember(key, payload, 200, result);
      return json(200, result);
    },
  },
  {
    method: "POST",
    path: "/admin/members/{userId}/password-reset",
    handler: (req) => {
      log(req);
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      // Hanya Super Admin (x-kapdh-access role super_admin); admin dengan izin apa pun ditolak.
      if (mockAdminRole() !== "super_admin")
        return error(403, "FORBIDDEN", "Hanya Super Admin yang dapat memulai pemulihan sandi alumni.");
      const reauth = requireReauth(req);
      if (reauth) return reauth;
      const m = findMember(req);
      if (!m) return notFound();
      const { key, payload, hit } = replayOf(req, "password-reset");
      if (hit) return hit;
      const body = req.body ?? {};
      const fieldErrors: FieldErrors = {};
      unknownKeys(body, new Set(["reason", "confirm"]), fieldErrors);
      const reason = textError(body.reason, "Alasan", 3, 500);
      if (reason) fieldErrors.reason = [reason];
      if (body.confirm !== true) fieldErrors.confirm = ["Konfirmasi tindakan wajib."];
      if (Object.keys(fieldErrors).length > 0) return validationError(fieldErrors);
      if (linkedToCaller(m))
        return error(
          403,
          "FORBIDDEN",
          "Akun alumni Anda sendiri memakai alur lupa sandi mandiri di aplikasi.",
        );
      // Bentuk server (MemberPasswordResetService): galat akar `_` tanpa `current`.
      if (m.account_status !== "active")
        return validationError(
          { _: ["Pemulihan sandi hanya untuk akun aktif yang emailnya sudah terverifikasi."] },
          "Pemulihan sandi hanya untuk akun aktif yang emailnya sudah terverifikasi.",
        );
      const now = Date.now();
      // Batas pengiriman OTP per email (kunci `otp:<email>` yang sama dengan modul auth, PRD 2.5).
      const sends = (otpSends.get(m.email) ?? []).filter((t) => t > now - HOUR_MS);
      if (sends.length >= OTP_SENDS_PER_HOUR)
        return error(429, "RATE_LIMITED", "Terlalu banyak permintaan kode untuk akun ini. Coba lagi nanti.", {
          retry_after_seconds: Math.max(1, Math.ceil(((sends[0] ?? now) + HOUR_MS - now) / 1000)),
        });
      otpSends.set(m.email, [...sends, now]);
      const result: S["AdminMemberPasswordResetResult"] = {
        initiated_at: new Date(now).toISOString(),
        sessions_revoked: m.sessions,
        challenge_expires_at: new Date(now + OTP_TTL_MS).toISOString(),
      };
      // Seluruh sesi dicabut setelah commit; kode hanya dikirim ke email terverifikasi (AC F16-4).
      m.sessions = 0;
      remember(key, payload, 202, result);
      return json(202, result);
    },
  },
  {
    method: "GET",
    path: "/admin/members/{userId}/membership-events",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "members.read");
      if (denied) return denied;
      const m = findMember(req);
      if (!m) return notFound();
      const kind = req.url.searchParams.get("kind");
      const canModeration = mockHasPermission("moderation.read");
      if (kind === "warn" && !canModeration)
        return error(403, "FORBIDDEN", "Peringatan moderasi hanya untuk pemegang izin moderasi.");
      const items = m.events
        .filter((e) => canModeration || e.kind !== "warn")
        .filter((e) => !kind || e.kind === kind)
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .map(presentEvent);
      return json(200, paginate(items, req.url) satisfies S["AdminMembershipEventPage"]);
    },
  },
  {
    method: "GET",
    path: "/admin/masters/{kind}",
    handler: (req) => {
      log(req);
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      // permissions_any: cukup members.read ATAU master.manage (filter daftar anggota dan halaman master).
      if (!mockHasPermission("members.read") && !mockHasPermission("master.manage"))
        return error(403, "FORBIDDEN", "Anda tidak memiliki izin untuk tindakan ini.");
      const kind = kindOf(req);
      if (!kind) return validationError({ kind: ["Jenis master tidak dikenal."] });
      const p = req.url.searchParams;
      const q = (p.get("q") ?? "").trim().toLowerCase();
      const active = bool(p.get("active"));
      const items = [...masters.values()]
        .filter((m) => m.kind === kind)
        .filter((m) => active === undefined || m.active === active)
        .filter((m) => !q || m.label.toLowerCase().includes(q))
        .map(presentMaster)
        .sort(masterSorter(p.get("sort")));
      return json(200, paginate(items, req.url) satisfies S["AdminMasterPage"]);
    },
  },
  {
    method: "POST",
    path: "/admin/masters/{kind}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "master.manage");
      if (denied) return denied;
      const kind = kindOf(req);
      if (!kind) return validationError({ kind: ["Jenis master tidak dikenal."] });
      const body = req.body ?? {};
      const fieldErrors = validateMasterBody(body, true);
      if (Object.keys(fieldErrors).length > 0) return validationError(fieldErrors);
      const label = (body.label as string).trim();
      if (sameLabel(kind, label)) return duplicateLabel(kind);
      masterSeq += 1;
      const at = new Date().toISOString();
      const master: MasterState = {
        id: mockId(kind === "professions" ? "6" : "7", masterSeq),
        kind,
        label,
        active: body.active === undefined ? true : (body.active as boolean),
        sort_order: body.sort_order === undefined ? 0 : (body.sort_order as number),
        version: 1,
        created_at: at,
        updated_at: at,
      };
      masters.set(master.id, master);
      return json(201, presentMaster(master));
    },
  },
  {
    method: "GET",
    path: "/admin/masters/{kind}/{masterId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "master.manage");
      if (denied) return denied;
      const master = masters.get(req.params.masterId ?? "");
      return master && master.kind === kindOf(req) ? json(200, presentMaster(master)) : notFound();
    },
  },
  {
    method: "PATCH",
    path: "/admin/masters/{kind}/{masterId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "master.manage");
      if (denied) return denied;
      const kind = kindOf(req);
      const master = masters.get(req.params.masterId ?? "");
      if (!kind || !master || master.kind !== kind) return notFound();
      const body = req.body ?? {};
      const fieldErrors = validateMasterBody(body, false);
      if (Object.keys(fieldErrors).length > 0) return validationError(fieldErrors);
      if (req.headers.get("If-Match") !== String(master.version))
        return error(409, "VERSION_CONFLICT", "Master sudah diubah admin lain. Muat ulang data terbaru.", {
          current: presentMaster(master),
        });
      if (typeof body.label === "string" && sameLabel(kind, body.label, master.id))
        return duplicateLabel(kind);
      if (typeof body.label === "string") master.label = body.label.trim();
      if (typeof body.active === "boolean") master.active = body.active;
      if (typeof body.sort_order === "number") master.sort_order = body.sort_order;
      master.version += 1;
      master.updated_at = new Date().toISOString();
      return json(200, presentMaster(master));
    },
  },
  {
    method: "DELETE",
    path: "/admin/masters/{kind}/{masterId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "master.manage");
      if (denied) return denied;
      const kind = kindOf(req);
      const master = masters.get(req.params.masterId ?? "");
      if (!kind || !master || master.kind !== kind) return notFound();
      if (req.headers.get("If-Match") !== String(master.version))
        return error(409, "VERSION_CONFLICT", "Master sudah diubah admin lain. Muat ulang data terbaru.", {
          current: presentMaster(master),
        });
      const used = usageCount(master);
      if (used > 0)
        // FK RESTRICT: master terpakai tidak dihapus, dinonaktifkan sebagai gantinya (AC F10-4).
        return error(
          409,
          "VALIDATION_ERROR",
          `Master ini dipakai ${used} alumni sehingga tidak dapat dihapus. Nonaktifkan sebagai gantinya.`,
          { current: presentMaster(master) },
        );
      masters.delete(master.id);
      return noContent();
    },
  },
];

export const routes: MockRoute[] = memberRoutes.map(controlled);
