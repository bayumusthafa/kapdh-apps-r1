import { type AdminRole, type Permission, PERMISSION_VALUES } from "@kapdh/contracts";
import { mockCurrentIdentity, requireAdmin, requirePermission, requireReauth } from "./auth";
import { error, json, type MockRequest, type MockRoute, noContent, paginate, type S } from "./http";

/**
 * Tiruan Manajemen Admin (kontrak admin-admins C7, F-16, AC F16-1..F16-3, guideline hlm. 15). Aturan server yang
 * ditiru: izin admins.manage di setiap operasi; perubahan wajib X-Reauth-Token; If-Match untuk PATCH/DELETE/kirim
 * ulang/pemulihan (usang = 409 VERSION_CONFLICT dengan `current`); Super Admin aktif terakhir tidak dapat
 * diturunkan/dinonaktifkan/dipulihkan (409 VALIDATION_ERROR `role`/`status` + `current`, AC F16-2); admins.manage
 * tidak dapat ditugaskan; izin wajib beserta prasyaratnya; bentrok email/tautan alumni = 409; Idempotency-Key
 * memutar ulang hasil pertama. Token undangan tidak pernah ada di respons. Data contoh bukan bukti AC (PRD 7.3).
 */
type Detail = S["AdminAccountDetail"];
type Candidate = S["AdminCandidate"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_MS = 72 * 3_600_000;

export const MOCK_ADMIN_IDS = {
  bayu: "0199e000-0000-7000-8000-0000000000ad",
  ahmad: "0199e000-0000-7000-8000-0000000000b2",
  rina: "0199e000-0000-7000-8000-0000000000b3",
  dedi: "0199e000-0000-7000-8000-0000000000b4",
  hasan: "0199e000-0000-7000-8000-0000000000b5",
} as const;

export const MOCK_CANDIDATE_IDS = {
  ridwan: "0199e000-0000-7000-8000-0000000000c1",
  arya: "0199e000-0000-7000-8000-0000000000c2",
  bayu: "0199e000-0000-7000-8000-0000000000c3",
  ahmad: "0199e000-0000-7000-8000-0000000000c4",
  sari: "0199e000-0000-7000-8000-0000000000c5",
  nur: "0199e000-0000-7000-8000-0000000000c6",
} as const;

/** Katalog izin tetap (kontrak adminListPermissions). */
export const PERMISSION_CATALOG: S["AdminPermissionInfo"][] = [
  ["payments.read", "Lihat pembayaran", "Melihat antrean dan bukti pembayaran.", "payments", []],
  ["payments.decide", "Putuskan pembayaran", "Menyetujui atau menolak pembayaran.", "payments", ["payments.read"]],
  ["members.read", "Lihat anggota", "Melihat data anggota.", "members", []],
  ["members.manage", "Kelola anggota", "Mengubah data administratif anggota.", "members", ["members.read"]],
  ["content.manage", "Kelola konten", "Mengelola berita, banner dan halaman.", "content", []],
  ["master.manage", "Kelola master profesi dan keahlian", "Mengelola daftar profesi dan keahlian.", "members", []],
  ["events.manage", "Kelola event dan tiket", "Mengelola event, kuota dan tiket.", "events", []],
  ["events.checkin", "Check-in tiket", "Memindai tiket saat acara.", "events", []],
  ["moderation.read", "Lihat laporan", "Membaca laporan dan bukti moderasi.", "moderation", []],
  ["moderation.resolve", "Putuskan laporan", "Mengabaikan, memperingatkan atau men-suspend.", "moderation", ["moderation.read"]],
  ["audit.read", "Lihat audit", "Menelusuri jejak audit.", "audit", []],
  ["audit.export", "Ekspor audit", "Mengekspor audit ke CSV.", "audit", ["audit.read"]],
  ["settings.manage", "Kelola metode bayar dan pengaturan", "Metode bayar, biaya dan pengaturan aplikasi.", "settings", []],
  ["admins.manage", "Kelola admin dan izin", "Hanya melekat pada Super Admin.", "admins", []],
  ["notifications.manage", "Kelola pengiriman notifikasi", "Memantau dan mengulang pengiriman.", "notifications", []],
].map(([permission, label, description, group, requires]) => ({
  permission: permission as Permission,
  label: label as string,
  description: description as string,
  group: group as S["AdminPermissionGroup"],
  requires: requires as Permission[],
  assignable: permission !== "admins.manage",
}));

const ROLES: S["AdminRoleInfo"][] = [
  {
    role: "super_admin",
    label: "Super Admin",
    description: "Semua izin, mengelola admin dan izin; perubahan sensitif dengan MFA dan reautentikasi.",
  },
  { role: "admin", label: "Admin", description: "Hanya izin yang ditugaskan." },
];

interface Record_ {
  detail: Detail;
  /** Email akun alumni tertaut (untuk kandidat already_admin). */
  linkedUserId: string | null;
}

export interface AdminRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  ifMatch: string | null;
  reauth: boolean;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
}

/** Log permintaan manajemen admin (uji: reautentikasi, If-Match, Idempotency-Key, body). */
export const adminRequests: AdminRequestLog[] = [];

let admins = new Map<string, Record_>();
let candidates: Candidate[] = [];
const replays = new Map<string, { payload: string; status: number; body: unknown }>();
let seq = 0;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const DAY = 86_400_000;

function linked(userId: string, fullName: string, memberNumber: string | null): S["AdminLinkedAlumni"] {
  return { user_id: userId, full_name: fullName, member_number: memberNumber, avatar_url: null };
}

function detail(partial: Partial<Detail> & Pick<Detail, "id" | "display_name" | "email" | "role" | "status">): Detail {
  return {
    permissions: [],
    linked_alumni: null,
    mfa_enrolled: partial.status === "active",
    last_login_at: null,
    created_at: iso(-60 * DAY),
    invite_expires_at: null,
    activated_at: partial.status === "active" ? iso(-59 * DAY) : null,
    disabled_at: null,
    version: "1",
    invited_by: { admin_id: MOCK_ADMIN_IDS.bayu, display_name: "Bayu Musthafa" },
    permissions_version: 1,
    active_session_count: partial.status === "active" ? 1 : 0,
    updated_at: iso(-30 * DAY),
    ...partial,
  };
}

function fixtures(): Map<string, Record_> {
  const list: Record_[] = [
    {
      linkedUserId: MOCK_CANDIDATE_IDS.bayu,
      detail: detail({
        id: MOCK_ADMIN_IDS.bayu,
        display_name: "Bayu Musthafa",
        email: "admin@kapdh.test",
        role: "super_admin",
        status: "active",
        permissions: [...PERMISSION_VALUES],
        linked_alumni: linked(MOCK_CANDIDATE_IDS.bayu, "Bayu Musthafa Arief", "09.02.01.5"),
        last_login_at: iso(-2 * 3_600_000),
        invited_by: null,
        active_session_count: 2,
      }),
    },
    {
      linkedUserId: MOCK_CANDIDATE_IDS.ahmad,
      detail: detail({
        id: MOCK_ADMIN_IDS.ahmad,
        display_name: "Ahmad Zulhadi",
        email: "dofodim269@airhemp.com",
        role: "admin",
        status: "active",
        permissions: ["payments.read", "payments.decide", "content.manage", "events.manage"],
        linked_alumni: linked(MOCK_CANDIDATE_IDS.ahmad, "Ahmad Zulhadi", "05.03.01.2"),
        last_login_at: iso(-1 * DAY),
        created_at: iso(-40 * DAY),
      }),
    },
    {
      linkedUserId: null,
      detail: detail({
        id: MOCK_ADMIN_IDS.rina,
        display_name: "Rina Kartika",
        email: "rina@kapdh.test",
        role: "admin",
        status: "invited",
        permissions: ["members.read"],
        mfa_enrolled: false,
        invite_expires_at: iso(2 * DAY),
        created_at: iso(-1 * DAY),
      }),
    },
    {
      linkedUserId: null,
      detail: detail({
        id: MOCK_ADMIN_IDS.dedi,
        display_name: "Dedi Pratama",
        email: "dedi@kapdh.test",
        role: "admin",
        status: "disabled",
        permissions: ["audit.read"],
        mfa_enrolled: true,
        activated_at: iso(-50 * DAY),
        disabled_at: iso(-5 * DAY),
        last_login_at: iso(-6 * DAY),
        created_at: iso(-55 * DAY),
      }),
    },
    {
      linkedUserId: null,
      detail: detail({
        id: MOCK_ADMIN_IDS.hasan,
        display_name: "Hasan Basri",
        email: "hasan.salah@kapdh.test",
        role: "admin",
        status: "disabled",
        permissions: ["events.checkin"],
        mfa_enrolled: false,
        activated_at: null,
        disabled_at: iso(-3 * DAY),
        created_at: iso(-10 * DAY),
      }),
    },
  ];
  return new Map(list.map((r) => [r.detail.id, r]));
}

function candidateFixtures(): Candidate[] {
  const c = (
    user_id: string,
    full_name: string,
    member_number: string | null,
    email: string,
    profession: string | null,
    effective_status: S["EffectiveStatus"],
    reason: S["AdminCandidateIneligibleReason"] | null,
  ): Candidate => ({
    user_id,
    full_name,
    member_number,
    email,
    profession,
    avatar_url: null,
    effective_status,
    eligible: reason === null,
    ineligible_reason: reason,
  });
  return [
    c(MOCK_CANDIDATE_IDS.ridwan, "ridwan", "06.02.01.4", "info.kapdh@gmail.com", "Wiraswasta", "verified", null),
    c(MOCK_CANDIDATE_IDS.arya, "Arya Kamandanu", "10.02.01.3", "jawejob788@fidhost.com", null, "verified", null),
    c(MOCK_CANDIDATE_IDS.bayu, "Bayu Musthafa Arief", "09.02.01.5", "waladsyuhada@gmail.com", "Guru", "verified", "already_admin"),
    c(MOCK_CANDIDATE_IDS.ahmad, "Ahmad Zulhadi", "05.03.01.2", "ahmad.z@gmail.com", null, "expiring", "already_admin"),
    c(MOCK_CANDIDATE_IDS.sari, "Sari Dewi", "11.01.02.8", "sari.dewi@gmail.com", "Perawat", "suspended", "suspended"),
    c(MOCK_CANDIDATE_IDS.nur, "Nur Aini", null, "nur.aini@gmail.com", null, "pending_otp", "account_inactive"),
  ];
}

export function reset(): void {
  admins = fixtures();
  candidates = candidateFixtures();
  replays.clear();
  seq = 0;
  adminRequests.length = 0;
}
reset();

function log(req: MockRequest): void {
  adminRequests.push({
    method: req.method,
    path: req.path,
    query: Object.fromEntries(req.url.searchParams.entries()),
    ifMatch: req.headers.get("If-Match"),
    reauth: req.headers.has("X-Reauth-Token"),
    idempotencyKey: req.headers.get("Idempotency-Key"),
    body: req.body,
  });
}

/** Izin efektif untuk tampilan: super_admin = seluruh izin, urutan katalog. */
function effective(d: Detail): Detail {
  const perms =
    d.role === "super_admin"
      ? [...PERMISSION_VALUES]
      : PERMISSION_VALUES.filter((p) => d.permissions.includes(p));
  return { ...d, permissions: perms };
}

function summary(d: Detail): S["AdminAccount"] {
  const e = effective(d);
  return {
    id: e.id,
    display_name: e.display_name,
    email: e.email,
    role: e.role,
    status: e.status,
    permissions: e.permissions,
    linked_alumni: e.linked_alumni,
    mfa_enrolled: e.mfa_enrolled,
    last_login_at: e.last_login_at,
    created_at: e.created_at,
    invite_expires_at: e.invite_expires_at,
    activated_at: e.activated_at,
    disabled_at: e.disabled_at,
    version: e.version,
  };
}

function bump(d: Detail, permissionsChanged: boolean): Detail {
  return {
    ...d,
    version: String(Number(d.version) + 1),
    permissions_version: permissionsChanged ? d.permissions_version + 1 : d.permissions_version,
    updated_at: new Date().toISOString(),
  };
}

function guard(req: MockRequest, opts: { reauth?: boolean } = {}): Response | null {
  log(req);
  const denied = requirePermission(req, "admins.manage");
  if (denied) return denied;
  if (opts.reauth) return requireReauth(req);
  return null;
}

/** Replay Idempotency-Key: payload sama = hasil pertama; payload berbeda = 409 IDEMPOTENCY_CONFLICT. */
function replay(req: MockRequest): { response: Response | null; remember: (status: number, body: unknown) => void } {
  const key = req.headers.get("Idempotency-Key");
  const payload = JSON.stringify([req.method, req.path, req.body]);
  const prior = key ? replays.get(key) : undefined;
  if (prior) {
    if (prior.payload !== payload)
      return {
        response: error(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah dipakai untuk permintaan lain."),
        remember: () => undefined,
      };
    return { response: json(prior.status, prior.body), remember: () => undefined };
  }
  return {
    response: null,
    remember: (status, body) => {
      if (key) replays.set(key, { payload, status, body });
    },
  };
}

function find(req: MockRequest): { record: Record_ } | { response: Response } {
  const id = req.params.adminId ?? "";
  if (!UUID.test(id))
    return {
      response: error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
        field_errors: { adminId: ["Id admin tidak valid."] },
      }),
    };
  const record = admins.get(id);
  return record ? { record } : { response: error(404, "NOT_FOUND", "Admin tidak ditemukan.") };
}

function checkVersion(req: MockRequest, d: Detail): Response | null {
  const ifMatch = req.headers.get("If-Match");
  if (!ifMatch)
    return error(400, "VALIDATION_ERROR", "Header If-Match wajib diisi.", {
      field_errors: { "If-Match": ["Versi admin wajib dikirim."] },
    });
  if (ifMatch !== d.version)
    return error(409, "VERSION_CONFLICT", "Data admin sudah diubah. Muat ulang.", { current: effective(d) });
  return null;
}

/** Validasi himpunan izin (kontrak: assignable, tanpa ganda, prasyarat ikut). */
function permissionErrors(role: unknown, perms: unknown): string[] | null {
  if (!Array.isArray(perms)) return ["Daftar izin wajib dikirim."];
  if (new Set(perms).size !== perms.length) return ["Izin tidak boleh ganda."];
  if (role === "super_admin" && perms.length > 0)
    return ["Super Admin memiliki semua izin; kosongkan daftar izin."];
  for (const p of perms) {
    const info = PERMISSION_CATALOG.find((c) => c.permission === p);
    if (!info) return [`Izin ${String(p)} tidak dikenal.`];
    if (!info.assignable) return ["Izin Kelola admin dan izin hanya melekat pada Super Admin."];
    const missing = info.requires.filter((r) => !perms.includes(r));
    if (missing.length > 0) return [`Izin ${info.label} memerlukan ${missing.join(", ")}.`];
  }
  return null;
}

function otherActiveSuperAdmins(exceptId: string): number {
  return [...admins.values()].filter(
    (r) => r.detail.id !== exceptId && r.detail.role === "super_admin" && r.detail.status === "active",
  ).length;
}

function emailTaken(email: string, exceptId: string | null): boolean {
  return [...admins.values()].some((r) => r.detail.id !== exceptId && r.detail.email.toLowerCase() === email);
}

function invitationResult(d: Detail): S["AdminInvitationResult"] {
  return {
    admin: effective(d),
    invitation_expires_at: d.invite_expires_at ?? iso(INVITE_TTL_MS),
    invitation_sent_at: new Date().toISOString(),
  };
}

function bad(fieldErrors: Record<string, string[]>, status = 400, current?: Detail): Response {
  return error(status, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
    field_errors: fieldErrors,
    ...(current ? { current: effective(current) } : {}),
  });
}

/** Kendali server tiruan untuk uji dan dev:mock. */
export const mockAdmins = {
  get(id: string): Detail | undefined {
    const r = admins.get(id);
    return r ? effective(r.detail) : undefined;
  },
  /** Admin lain mengubah data admin ini (versi naik) sehingga formulir lama mendapat 409. */
  changeElsewhere(id: string, patch: Partial<Detail> = {}): void {
    const r = admins.get(id);
    if (r) r.detail = bump({ ...r.detail, ...patch }, true);
  },
  /** Jumlah identitas admin. */
  count(): number {
    return admins.size;
  },
};

export const routes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/permissions",
    handler: (req) => {
      log(req);
      return requireAdmin(req) ?? json(200, { permissions: PERMISSION_CATALOG, roles: ROLES });
    },
  },
  {
    method: "GET",
    path: "/admin/admins",
    handler: (req) => {
      const denied = guard(req);
      if (denied) return denied;
      const p = req.url.searchParams;
      const q = (p.get("q") ?? "").trim().toLowerCase();
      const role = p.get("role");
      const status = p.get("status");
      const permission = p.get("permission");
      const sort = p.get("sort") ?? "display_name_asc";
      const all = [...admins.values()].map((r) => r.detail);
      const items = all
        .filter((d) => !q || d.display_name.toLowerCase().includes(q) || d.email.toLowerCase().includes(q))
        .filter((d) => !role || d.role === role)
        .filter((d) => !status || d.status === status)
        .filter(
          (d) => !permission || d.role === "super_admin" || d.permissions.includes(permission as Permission),
        )
        .sort((a, b) => {
          if (sort === "created_at_desc") return b.created_at.localeCompare(a.created_at);
          if (sort === "last_login_at_desc") return (b.last_login_at ?? "").localeCompare(a.last_login_at ?? "");
          return a.display_name.localeCompare(b.display_name, "id");
        })
        .map(summary);
      const page = paginate(items, req.url);
      const counts: S["AdminAccountCounts"] = {
        total: all.length,
        active: all.filter((d) => d.status === "active").length,
        invited: all.filter((d) => d.status === "invited").length,
        disabled: all.filter((d) => d.status === "disabled").length,
      };
      return json(200, { ...page, counts } satisfies S["AdminAccountPage"]);
    },
  },
  {
    method: "GET",
    path: "/admin/admins/candidates",
    handler: (req) => {
      const denied = guard(req);
      if (denied) return denied;
      const q = (req.url.searchParams.get("q") ?? "").trim().toLowerCase();
      const items = candidates.filter(
        (c) =>
          !q ||
          c.full_name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          (c.member_number ?? "").startsWith(q),
      );
      return json(200, paginate(items, req.url) satisfies S["AdminCandidatePage"]);
    },
  },
  {
    method: "POST",
    path: "/admin/admins",
    handler: (req) => {
      const denied = guard(req, { reauth: true });
      if (denied) return denied;
      const idem = replay(req);
      if (idem.response) return idem.response;
      const b = req.body ?? {};
      const fe: Record<string, string[]> = {};
      if (b.role !== "admin" && b.role !== "super_admin") fe.role = ["Pilih peran."];
      const permErr = permissionErrors(b.role, b.permissions);
      if (permErr) fe.permissions = permErr;
      let email = typeof b.email === "string" ? b.email.trim().toLowerCase() : null;
      let displayName = typeof b.display_name === "string" ? b.display_name.trim() : null;
      let linkedAlumni: S["AdminLinkedAlumni"] | null = null;
      const alumniId = b.alumni_user_id;
      if (alumniId !== undefined) {
        const cand = typeof alumniId === "string" ? candidates.find((c) => c.user_id === alumniId) : undefined;
        if (!cand) fe.alumni_user_id = ["Alumni tidak ditemukan."];
        else if (cand.ineligible_reason === "account_inactive")
          fe.alumni_user_id = ["Akun alumni belum aktif atau dinonaktifkan."];
        else if (cand.ineligible_reason === "suspended") fe.alumni_user_id = ["Alumni sedang dibatasi pengurus."];
        else if (cand.ineligible_reason !== "already_admin") {
          email ??= cand.email.toLowerCase();
          displayName ??= cand.full_name;
          linkedAlumni = linked(cand.user_id, cand.full_name, cand.member_number);
        }
        if (cand?.ineligible_reason === "already_admin" && Object.keys(fe).length === 0)
          return bad({ alumni_user_id: ["Alumni ini sudah tertaut ke identitas admin."] }, 409);
      } else {
        if (!email) fe.email = ["Email wajib diisi bila tidak memilih alumni."];
        if (!displayName) fe.display_name = ["Nama tampilan wajib diisi bila tidak memilih alumni."];
      }
      if (email && (email.length > 254 || !EMAIL.test(email))) fe.email = ["Format email tidak valid."];
      if (displayName !== null && (displayName.length < 1 || displayName.length > 120))
        fe.display_name = ["Nama tampilan 1-120 karakter."];
      if (Object.keys(fe).length > 0) return bad(fe);
      if (emailTaken(email!, null)) return bad({ email: ["Email login sudah dipakai identitas admin lain."] }, 409);
      seq += 1;
      const id = `0199e000-0000-7000-8000-${(0xe00 + seq).toString(16).padStart(12, "0")}`;
      const me = mockCurrentIdentity();
      const d = detail({
        id,
        display_name: displayName!,
        email: email!,
        role: b.role as AdminRole,
        status: "invited",
        permissions: b.role === "super_admin" ? [] : (b.permissions as Permission[]),
        linked_alumni: linkedAlumni,
        mfa_enrolled: false,
        invite_expires_at: iso(INVITE_TTL_MS),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        invited_by: { admin_id: me.admin_id, display_name: me.display_name },
        active_session_count: 0,
      });
      admins.set(id, { detail: d, linkedUserId: linkedAlumni?.user_id ?? null });
      if (linkedAlumni)
        candidates = candidates.map((c) =>
          c.user_id === linkedAlumni!.user_id ? { ...c, eligible: false, ineligible_reason: "already_admin" } : c,
        );
      const body = invitationResult(d);
      idem.remember(201, body);
      return json(201, body);
    },
  },
  {
    method: "GET",
    path: "/admin/admins/{adminId}",
    handler: (req) => {
      const denied = guard(req);
      if (denied) return denied;
      const found = find(req);
      return "response" in found ? found.response : json(200, effective(found.record.detail));
    },
  },
  {
    method: "PATCH",
    path: "/admin/admins/{adminId}",
    handler: (req) => {
      const denied = guard(req, { reauth: true });
      if (denied) return denied;
      const found = find(req);
      if ("response" in found) return found.response;
      const r = found.record;
      const d = r.detail;
      const b = req.body ?? {};
      const keys = Object.keys(b).filter((k) => b[k] !== undefined);
      if (keys.length === 0) return bad({ _: ["Tidak ada perubahan yang dikirim."] });
      const version = checkVersion(req, d);
      if (version) return version;
      const fe: Record<string, string[]> = {};
      if (b.display_name !== undefined && (typeof b.display_name !== "string" || !b.display_name.trim()))
        fe.display_name = ["Nama tampilan wajib diisi."];
      if (b.role !== undefined && b.role !== "admin" && b.role !== "super_admin") fe.role = ["Peran tidak dikenal."];
      const nextRole = (b.role ?? d.role) as AdminRole;
      if (b.role === "admin" && d.role === "super_admin" && b.permissions === undefined)
        fe.permissions = ["Sertakan izin saat mengubah peran menjadi Admin."];
      if (b.permissions !== undefined) {
        const pe = permissionErrors(nextRole, b.permissions);
        if (pe) fe.permissions = pe;
      }
      if (b.status !== undefined && b.status !== "active" && b.status !== "disabled") fe.status = ["Status tidak dikenal."];
      const reason = typeof b.reason === "string" ? b.reason.trim() : "";
      if (b.status === "disabled" && reason.length < 3) fe.reason = ["Alasan minimal 3 karakter wajib saat menonaktifkan."];
      if (b.email !== undefined && b.status !== undefined) fe.email = ["Email tidak dapat diubah bersama status."];
      const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : null;
      if (b.email !== undefined && (!email || !EMAIL.test(email))) fe.email = ["Format email tidak valid."];
      if (Object.keys(fe).length > 0) return bad(fe);

      // Transisi status (kontrak adminUpdateAdmin).
      if (b.status === "active" && !(d.status === "disabled" && d.activated_at && d.mfa_enrolled))
        return bad(
          {
            status: [
              d.activated_at
                ? "Admin tanpa TOTP terverifikasi dipulihkan lewat Pulihkan akun."
                : "Admin yang belum pernah aktif memakai Kirim ulang undangan.",
            ],
          },
          409,
          d,
        );
      if (b.status === "disabled" && d.status === "disabled") return bad({ status: ["Admin sudah nonaktif."] }, 409, d);
      if (email !== null && email !== d.email) {
        const neverActive = d.activated_at === null;
        if (!(d.status === "invited" || (d.status === "disabled" && neverActive)))
          return bad({ email: ["Email admin aktif diganti lewat Pulihkan akun (reset sandi dan MFA)."] }, 409, d);
        if (emailTaken(email, d.id)) return bad({ email: ["Email login sudah dipakai identitas admin lain."] }, 409);
      }
      // Penjaga Super Admin aktif terakhir (AC F16-2).
      const demote = d.role === "super_admin" && nextRole !== "super_admin";
      const disable = b.status === "disabled";
      if (d.role === "super_admin" && d.status === "active" && (demote || disable) && otherActiveSuperAdmins(d.id) === 0)
        return bad(
          { [demote ? "role" : "status"]: ["Minimal satu Super Admin aktif harus tetap ada (AC F16-2)."] },
          409,
          d,
        );

      const permsChanged = b.role !== undefined || b.permissions !== undefined || b.status !== undefined;
      let next: Detail = {
        ...d,
        display_name: typeof b.display_name === "string" ? b.display_name.trim() : d.display_name,
        role: nextRole,
        permissions:
          nextRole === "super_admin" ? [] : ((b.permissions as Permission[] | undefined) ?? d.permissions),
      };
      if (b.status === "disabled")
        next = {
          ...next,
          status: "disabled",
          disabled_at: new Date().toISOString(),
          invite_expires_at: null,
          active_session_count: 0,
        };
      if (b.status === "active") next = { ...next, status: "active", disabled_at: null };
      if (email !== null && email !== d.email)
        next = { ...next, email, invite_expires_at: d.status === "invited" ? iso(INVITE_TTL_MS) : d.invite_expires_at };
      r.detail = bump(next, permsChanged);
      return json(200, effective(r.detail));
    },
  },
  {
    method: "DELETE",
    path: "/admin/admins/{adminId}",
    handler: (req) => {
      const denied = guard(req, { reauth: true });
      if (denied) return denied;
      const found = find(req);
      if ("response" in found) return found.response;
      const d = found.record.detail;
      const version = checkVersion(req, d);
      if (version) return version;
      if (d.activated_at)
        return bad({ _: ["Identitas yang pernah aktif tidak dapat dihapus; nonaktifkan saja."] }, 409, d);
      admins.delete(d.id);
      if (found.record.linkedUserId)
        candidates = candidates.map((c) =>
          c.user_id === found.record.linkedUserId ? { ...c, eligible: true, ineligible_reason: null } : c,
        );
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/admin/admins/{adminId}/invitation",
    handler: (req) => {
      const denied = guard(req, { reauth: true });
      if (denied) return denied;
      const idem = replay(req);
      if (idem.response) return idem.response;
      const found = find(req);
      if ("response" in found) return found.response;
      const r = found.record;
      const version = checkVersion(req, r.detail);
      if (version) return version;
      const d = r.detail;
      if (!(d.status === "invited" || (d.status === "disabled" && !d.activated_at)))
        return bad({ _: ["Admin ini pernah aktif: aktifkan kembali atau pulihkan akun."] }, 409, d);
      r.detail = bump(
        { ...d, status: "invited", disabled_at: null, invite_expires_at: iso(INVITE_TTL_MS) },
        d.status !== "invited",
      );
      const body = invitationResult(r.detail);
      idem.remember(200, body);
      return json(200, body);
    },
  },
  {
    method: "POST",
    path: "/admin/admins/{adminId}/recovery",
    handler: (req) => {
      const denied = guard(req, { reauth: true });
      if (denied) return denied;
      const idem = replay(req);
      if (idem.response) return idem.response;
      const found = find(req);
      if ("response" in found) return found.response;
      const r = found.record;
      const d = r.detail;
      const b = req.body ?? {};
      const fe: Record<string, string[]> = {};
      const reason = typeof b.reason === "string" ? b.reason.trim() : "";
      if (reason.length < 3 || reason.length > 500) fe.reason = ["Alasan 3-500 karakter wajib diisi."];
      const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : null;
      if (b.email !== undefined && (!email || !EMAIL.test(email))) fe.email = ["Format email tidak valid."];
      if (Object.keys(fe).length > 0) return bad(fe);
      const version = checkVersion(req, d);
      if (version) return version;
      if (d.id === mockCurrentIdentity().admin_id)
        return bad({ _: ["Anda tidak dapat memulihkan akun sendiri; gunakan ganti sandi atau backup code."] }, 409, d);
      if (d.status === "invited" || !d.activated_at)
        return bad({ _: ["Admin ini belum pernah aktif; gunakan Kirim ulang undangan."] }, 409, d);
      if (d.role === "super_admin" && d.status === "active" && otherActiveSuperAdmins(d.id) === 0)
        return bad({ status: ["Minimal satu Super Admin aktif harus tetap ada (AC F16-2)."] }, 409, d);
      if (email && email !== d.email && emailTaken(email, d.id))
        return bad({ email: ["Email login sudah dipakai identitas admin lain."] }, 409);
      const revoked = d.active_session_count;
      r.detail = bump(
        {
          ...d,
          status: "invited",
          email: email ?? d.email,
          mfa_enrolled: false,
          disabled_at: null,
          invite_expires_at: iso(INVITE_TTL_MS),
          active_session_count: 0,
        },
        true,
      );
      const body: S["AdminRecoveryResult"] = {
        admin: effective(r.detail),
        invitation_expires_at: r.detail.invite_expires_at!,
        invitation_sent_at: new Date().toISOString(),
        revoked_session_count: revoked,
      };
      idem.remember(200, body);
      return json(200, body);
    },
  },
];
