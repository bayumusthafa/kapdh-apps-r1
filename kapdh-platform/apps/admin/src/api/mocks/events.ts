import { mockAdminRef, mockHasPermission, requirePermission } from "./auth";
import {
  error,
  json,
  type MockFile,
  type MockRequest,
  type MockRoute,
  noContent,
  paginate,
  readMultipart,
  type S,
} from "./http";

/**
 * Tiruan Manajemen Event & Tiket dan check-in (F-09, F-15, AC F09-5..F09-7, F15-2, F15-4) mengikuti kontrak
 * admin-events final (C5), ditambah kategori event pada admin-content (/admin/content/event-categories, izin
 * events.manage, guideline p14 "Manajemen Kategori"). Data contoh bukan bukti lulus acceptance criteria (PRD 7.3).
 *
 * Aturan server yang ditiru:
 * - Proyeksi baca kursi (aturan tag Events): hold `awaiting_payment` yang `hold_expires_at`-nya lewat tampil
 *   `expired` dan tidak dihitung dalam `held_quantity`, `seats_available`, `min_seats_total` maupun statistik.
 * - `version` event naik hanya pada perubahan oleh pengurus (edit, status, batal), bukan oleh reservasi anggota.
 * - adminUpdateEvent: done/cancelled -> 400; kuota di bawah held+paid -> 409 VALIDATION_ERROR dengan
 *   `field_errors.seats_total` dan `current` (AC F15-2); If-Match berbeda -> 409 VERSION_CONFLICT (AC F15-4).
 * - adminSetEventStatus: replay key, lalu status sama = 200 tanpa If-Match, lalu If-Match, lalu transisi.
 * - adminCancelEvent (AC F09-7, D6): tiket aktif dibatalkan, payment tanpa bukti dibatalkan, payment berbukti tetap
 *   di antrean, tiket paid berbayar mendapat refund pending (tenggat 7 hari kerja), penghitung kursi menjadi 0.
 * - adminCancelTicket: `refund=true` memerlukan payments.decide dan bukan akun alumni tertaut pemanggil (403
 *   sebelum perubahan apa pun); tiket awaiting_review -> 409 PAYMENT_STATE_CONFLICT.
 * - adminCheckInTicket: pemeriksaan berurutan dengan penolakan 409 berisi `current` AdminCheckinRejectionDetail
 *   (AC F09-6); scan kedua -> TICKET_ALREADY_CHECKED_IN dengan waktu dan petugas sebelumnya (AC F09-5).
 */
type EventStatus = S["EventStatus"];
type TicketStatus = S["TicketStatus"];
type Actor = S["AdminEventActor"];
type Detail = S["AdminEventDetail"];
type Ticket = S["AdminEventTicket"];
type Category = S["AdminContentCategory"];
type RejectionReason = S["AdminCheckinRejectionReason"];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Asia/Jakarta UTC+7 tanpa DST: hari kerja dihitung pada tanggal WIB (D6). */
const WIB_OFFSET_MS = 7 * HOUR;
/** app_settings events.checkin_before_hours (D5). */
const CHECKIN_BEFORE_MS = 2 * HOUR;
/** Tenggat refund paling lambat 7 hari kerja sejak pembatalan (D6). */
const REFUND_BUSINESS_DAYS = 7;
const COVER_MAX_BYTES = 5 * 1024 * 1024;

/** Id data contoh untuk uji dan dev:mock. */
export const MOCK_EVENT_IDS = {
  /** Reuni Akbar: open, check-in sedang berlangsung, berbayar, memiliki tiket berbagai status. */
  reuni: "0199e100-0000-7000-8000-0000000000e1",
  /** Seminar AI: open, gratis, mulai 10 hari lagi (check-in terlalu awal), memiliki tiket. */
  seminar: "0199e100-0000-7000-8000-0000000000e2",
  /** Mancing Bareng: draft tanpa tiket (dapat diterbitkan dan dihapus). */
  mancing: "0199e100-0000-7000-8000-0000000000e3",
  /** Kajian Subuh: closed, check-in dibuka dalam 24 jam (terdaftar di pemindai, belum buka). */
  kajian: "0199e100-0000-7000-8000-0000000000e4",
  /** Jalan Sehat: done (sudah lewat). */
  jalan: "0199e100-0000-7000-8000-0000000000e5",
  /** Pramuka Bersama: dibatalkan pengurus (riwayat tetap ada). */
  pramuka: "0199e100-0000-7000-8000-0000000000e6",
} as const;

/** Isi QR tiket contoh (tickets.qr_code opaque 128-bit) untuk uji pemindai. */
export const MOCK_TICKET_QR = {
  /** Reuni, paid, belum check-in. */
  paid: "KAPDH-T-7f3a9c2e5b8d4f10a6c1e9b7d2f4a801",
  /** Reuni, paid, pemegang kedua (belum check-in). */
  paid2: "KAPDH-T-1b2c3d4e5f60718293a4b5c6d7e8f902",
  /** Reuni, paid dan sudah check-in oleh petugas lain. */
  checkedIn: "KAPDH-T-a0b1c2d3e4f5061728394a5b6c7d8e03",
  /** Reuni, awaiting_review. */
  review: "KAPDH-T-0f1e2d3c4b5a69788796a5b4c3d2e104",
  /** Reuni, awaiting_payment dengan hold aktif. */
  awaitingPayment: "KAPDH-T-5a5a5a5a5b5b5b5b5c5c5c5c5d5d5d05",
  /** Reuni, awaiting_payment yang hold-nya sudah lewat (proyeksi baca: expired). */
  holdExpired: "KAPDH-T-6e6e6e6e6f6f6f6f707070707171710e",
  /** Reuni, cancelled. */
  cancelled: "KAPDH-T-c4c4c4c4c5c5c5c5c6c6c6c6c7c7c707",
  /** Reuni, paid, pemegang disuspend (PRD 2.2). */
  ineligible: "KAPDH-T-9d9d9d9d9e9e9e9e9f9f9f9fa0a0a008",
  /** Seminar (event lain, belum dalam jendela). */
  seminar: "KAPDH-T-b1b1b1b1b2b2b2b2b3b3b3b3b4b4b409",
  /** Kajian (closed, jendela belum dibuka). */
  kajian: "KAPDH-T-d8d8d8d8d9d9d9d9dadadadadbdbdb10",
  /** Pramuka (event dibatalkan). */
  pramuka: "KAPDH-T-e2e2e2e2e3e3e3e3e4e4e4e4e5e5e511",
} as const;

/** Tiket contoh yang dirujuk uji. */
export const MOCK_TICKET_IDS = {
  paid: "0199e100-0000-7000-8000-0000000001a1",
  linked: "0199e100-0000-7000-8000-0000000001a9",
  review: "0199e100-0000-7000-8000-0000000001a4",
  awaitingPayment: "0199e100-0000-7000-8000-0000000001a5",
  deleted: "0199e100-0000-7000-8000-0000000001aa",
} as const;

/** Akun alumni tertaut admin tiruan yang sedang masuk (`admins.linked_alumni_user_id`, konflik kepentingan PRD 2.3). */
export const MOCK_LINKED_ALUMNI_ID = "0199e100-0000-7000-8000-00000000a1ad";

const CATEGORY_IDS = {
  reuni: "0199e100-0000-7000-8000-0000000000c1",
  seminar: "0199e100-0000-7000-8000-0000000000c2",
  tour: "0199e100-0000-7000-8000-0000000000c3",
  kemerdekaan: "0199e100-0000-7000-8000-0000000000c4",
  kajian: "0199e100-0000-7000-8000-0000000000c5",
} as const;
export const MOCK_EVENT_CATEGORY_IDS = CATEGORY_IDS;

const OTHER_ADMIN: Actor = {
  admin_id: "0199e000-0000-7000-8000-0000000000b2",
  display_name: "Rahmat Hidayat",
};

interface EventRec {
  id: string;
  title: string;
  description: string | null;
  category_id: string | null;
  location_name: string | null;
  location_address: string | null;
  location_url: string | null;
  cover_file_id: string | null;
  timezone: string;
  starts_at: string;
  ends_at: string;
  registration_opens_at: string;
  registration_closes_at: string;
  checkin_opens_at: string | null;
  checkin_closes_at: string | null;
  status: EventStatus;
  price: string;
  seats_total: number;
  version: number;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_by: Actor | null;
}

interface TicketRec {
  id: string;
  event_id: string;
  qr_code: string;
  status: TicketStatus;
  total: string;
  holder: S["AdminEventTicketHolder"];
  holder_eligible: boolean;
  hold_expires_at: string | null;
  checked_in_at: string | null;
  checked_in_by: Actor | null;
  cancelled_at: string | null;
  cancelled_by: S["TicketCancelledBy"] | null;
  cancel_reason: string | null;
  payment: S["AdminTicketPayment"] | null;
  refunds: S["TicketRefundInfo"][];
  created_at: string;
  version: number;
}

interface CoverRec {
  media: S["AdminEventCoverMedia"];
  attached: boolean;
}

interface CategoryRec {
  id: string;
  slug: string;
  label: string;
  sort_order: number;
  active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

let categories = new Map<string, CategoryRec>();
let events = new Map<string, EventRec>();
let tickets = new Map<string, TicketRec>();
let covers = new Map<string, CoverRec>();
/** Idempotency-Key per operasi: sidik jari payload dan respons pertama (ARCHITECTURE §4.2). */
let idempotency = new Map<string, { fingerprint: string; status: number; body: unknown }>();
let seq = 0;
/** Kegagalan jaringan buatan untuk POST /admin/checkin (uji "status belum diketahui"). */
let failCheckins = 0;

export interface EventRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  background: boolean;
  idempotencyKey: string | null;
  ifMatch: string | null;
  body: Record<string, unknown> | null;
}

/** Log permintaan ke endpoint event tiruan, untuk uji (If-Match, Idempotency-Key, filter). */
export const eventRequests: EventRequestLog[] = [];

function log(req: MockRequest): void {
  eventRequests.push({
    method: req.method,
    path: req.path,
    query: Object.fromEntries(req.url.searchParams.entries()),
    background: req.headers.get("X-Background-Request") === "1",
    idempotencyKey: req.headers.get("Idempotency-Key"),
    ifMatch: req.headers.get("If-Match"),
    body: req.body,
  });
}

function nowMs(): number {
  return Date.now();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function nextId(prefix: string): string {
  seq += 1;
  return `0199e1ff-0000-7000-8000-${prefix}${seq.toString(16).padStart(12 - prefix.length, "0")}`;
}

/** Money "60000.00" dijumlah/dikurangi lewat BigInt sen, tanpa floating point (ARCHITECTURE §2 butir 5). */
function cents(m: string): bigint {
  const [int = "0", frac = ""] = m.split(".");
  return BigInt(int) * 100n + BigInt(frac.padEnd(2, "0").slice(0, 2));
}

function money(c: bigint): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

function addBusinessDays(fromMs: number, days: number): string {
  let local = fromMs + WIB_OFFSET_MS;
  let added = 0;
  while (added < days) {
    local += DAY;
    const dow = new Date(local).getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return iso(local - WIB_OFFSET_MS);
}

// ---------------------------------------------------------------------------------------------------------------
// Proyeksi baca
// ---------------------------------------------------------------------------------------------------------------

/** Status tiket menurut proyeksi baca: hold yang lewat tampil expired walau belum dilepas job (tag Events). */
function projectedStatus(t: TicketRec, now = nowMs()): TicketStatus {
  if (t.status === "awaiting_payment" && t.hold_expires_at && Date.parse(t.hold_expires_at) <= now)
    return "expired";
  return t.status;
}

function ticketsOf(eventId: string): TicketRec[] {
  return [...tickets.values()].filter((t) => t.event_id === eventId);
}

function seatCounts(e: EventRec, now = nowMs()) {
  let held = 0;
  let paid = 0;
  let checkedIn = 0;
  for (const t of ticketsOf(e.id)) {
    const s = projectedStatus(t, now);
    if (s === "awaiting_payment" || s === "awaiting_review") held += 1;
    if (s === "paid") paid += 1;
    if (t.checked_in_at) checkedIn += 1;
  }
  return { held, paid, checkedIn, available: Math.max(0, e.seats_total - held - paid) };
}

function checkinWindow(e: EventRec): { opens: string; closes: string } {
  return {
    opens: e.checkin_opens_at ?? iso(Date.parse(e.starts_at) - CHECKIN_BEFORE_MS),
    closes: e.checkin_closes_at ?? e.ends_at,
  };
}

function categoryRef(id: string | null): S["EventCategoryRef"] | null {
  const c = id ? categories.get(id) : undefined;
  return c ? { id: c.id, slug: c.slug, label: c.label } : null;
}

function coverUrl(fileId: string | null): string | null {
  return fileId ? (covers.get(fileId)?.media.url ?? null) : null;
}

function allowedActions(e: EventRec, hasTickets: boolean, now = nowMs()): S["AdminEventAction"][] {
  const out: S["AdminEventAction"][] = [];
  const editable = e.status === "draft" || e.status === "open" || e.status === "closed";
  const endsLater = Date.parse(e.ends_at) > now;
  const regOpen = Date.parse(e.registration_closes_at) > now;
  if (editable) out.push("edit");
  if (e.status === "draft" && endsLater && regOpen) out.push("publish");
  if (e.status === "open") out.push("close");
  if (e.status === "closed" && endsLater && regOpen) out.push("reopen");
  if (e.status === "open" || e.status === "closed") out.push("cancel");
  if (!hasTickets) out.push("delete");
  return out;
}

function summary(e: EventRec, now = nowMs()): S["AdminEventSummary"] {
  const c = seatCounts(e, now);
  return {
    id: e.id,
    title: e.title,
    cover_url: coverUrl(e.cover_file_id),
    category: categoryRef(e.category_id),
    location_name: e.location_name,
    timezone: e.timezone,
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    registration_opens_at: e.registration_opens_at,
    registration_closes_at: e.registration_closes_at,
    status: e.status,
    price: e.price,
    seats_total: e.seats_total,
    // Event dibatalkan: semua tiket aktif sudah cancelled sehingga held dan paid bernilai 0 (adminCancelEvent).
    seats_available: c.available,
    held_quantity: c.held,
    paid_quantity: c.paid,
    has_tickets: ticketsOf(e.id).length > 0,
    version: String(e.version),
    updated_at: e.updated_at,
  };
}

function detail(e: EventRec, now = nowMs()): Detail {
  const s = summary(e, now);
  const c = seatCounts(e, now);
  const w = checkinWindow(e);
  return {
    ...s,
    description: e.description,
    location_address: e.location_address,
    location_url: e.location_url,
    cover_file_id: e.cover_file_id,
    checkin_opens_at: e.checkin_opens_at,
    checkin_closes_at: e.checkin_closes_at,
    effective_checkin_opens_at: w.opens,
    effective_checkin_closes_at: w.closes,
    checked_in_count: c.checkedIn,
    min_seats_total: Math.max(1, s.held_quantity + s.paid_quantity),
    cancelled_at: e.cancelled_at,
    cancel_reason: e.cancel_reason,
    created_by: e.created_by,
    created_at: e.created_at,
    allowed_actions: allowedActions(e, s.has_tickets, now),
  };
}

function canRefund(t: TicketRec, e: EventRec, now = nowMs()): boolean {
  return (
    projectedStatus(t, now) === "paid" &&
    cents(t.total) > 0n &&
    t.checked_in_at === null &&
    e.status !== "cancelled" &&
    mockHasPermission("payments.decide") &&
    t.holder.user_id !== MOCK_LINKED_ALUMNI_ID
  );
}

function ticketView(t: TicketRec, now = nowMs()): Ticket {
  const e = events.get(t.event_id)!;
  const status = projectedStatus(t, now);
  const payment = t.payment
    ? {
        ...t.payment,
        // Payment hold kedaluwarsa tampil dibatalkan sistem menurut proyeksi baca.
        status:
          status === "expired" && t.payment.status === "pending" && t.payment.submitted_at === null
            ? ("cancelled" as const)
            : t.payment.status,
      }
    : null;
  const reviewDue = payment?.review_due_at ? Date.parse(payment.review_due_at) : null;
  return {
    id: t.id,
    event_id: t.event_id,
    status,
    total: t.total,
    holder: t.holder,
    holder_eligible: t.holder_eligible,
    hold_expires_at: t.hold_expires_at,
    checked_in_at: t.checked_in_at,
    checked_in_by: t.checked_in_by,
    cancelled_at: t.cancelled_at,
    cancelled_by: t.cancelled_by,
    cancel_reason: t.cancel_reason,
    payment,
    refunds: [...t.refunds].sort(
      (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
    ),
    review_overdue:
      payment !== null &&
      payment.status === "pending" &&
      payment.submitted_at !== null &&
      reviewDue !== null &&
      now > reviewDue,
    can_refund: canRefund(t, e, now),
    created_at: t.created_at,
    version: String(t.version),
  };
}

function categoryView(c: CategoryRec): Category {
  return {
    id: c.id,
    kind: "event",
    slug: c.slug,
    label: c.label,
    sort_order: c.sort_order,
    active: c.active,
    usage_count: [...events.values()].filter((e) => e.category_id === c.id).length,
    version: String(c.version),
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Data contoh
// ---------------------------------------------------------------------------------------------------------------

function holder(
  userId: string | null,
  fullName: string | null,
  memberNumber: string | null,
  cohort: number | null,
): S["AdminEventTicketHolder"] {
  return {
    user_id: userId,
    full_name: fullName,
    member_number: memberNumber,
    cohort,
    cohort_code: cohort === null ? null : `KAPDH ${cohort}`,
    avatar_url: null,
  };
}

function placeholderCover(label: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="${color}"/><text x="320" y="190" font-family="Poppins, sans-serif" font-size="34" text-anchor="middle" fill="#fff">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function seedCover(id: string, label: string, color: string): string {
  covers.set(id, {
    attached: true,
    media: {
      file_id: id,
      url: placeholderCover(label, color),
      mime: "image/png",
      bytes: 48_213,
      width: 640,
      height: 360,
    },
  });
  return id;
}

interface TicketSeed {
  id?: string;
  qr: string;
  status: TicketStatus;
  holder: S["AdminEventTicketHolder"];
  eligible?: boolean;
  hold?: number | null;
  checkedIn?: { at: number; by: Actor };
  cancelled?: { at: number; by: S["TicketCancelledBy"]; reason: string };
  payment?: {
    status: S["TicketPaymentStatus"];
    submitted?: number | null;
    decided?: number | null;
    due?: number;
  };
  createdAt: number;
}

function addTicket(e: EventRec, seed: TicketSeed): void {
  const id = seed.id ?? nextId("71");
  const paidEvent = cents(e.price) > 0n;
  tickets.set(id, {
    id,
    event_id: e.id,
    qr_code: seed.qr,
    status: seed.status,
    total: e.price,
    holder: seed.holder,
    holder_eligible: seed.eligible ?? true,
    hold_expires_at: seed.hold == null ? null : iso(seed.hold),
    checked_in_at: seed.checkedIn ? iso(seed.checkedIn.at) : null,
    checked_in_by: seed.checkedIn?.by ?? null,
    cancelled_at: seed.cancelled ? iso(seed.cancelled.at) : null,
    cancelled_by: seed.cancelled?.by ?? null,
    cancel_reason: seed.cancelled?.reason ?? null,
    payment:
      paidEvent && seed.payment
        ? {
            id: nextId("7a"),
            status: seed.payment.status,
            amount: e.price,
            proof_version: seed.payment.submitted == null ? 0 : 1,
            submitted_at: seed.payment.submitted == null ? null : iso(seed.payment.submitted),
            decided_at: seed.payment.decided == null ? null : iso(seed.payment.decided),
            review_due_at:
              seed.payment.status === "pending" && seed.payment.submitted != null
                ? iso(seed.payment.due ?? seed.payment.submitted + 2 * DAY)
                : null,
          }
        : null,
    refunds: [],
    created_at: iso(seed.createdAt),
    version: 1,
  });
}

function event(rec: Omit<EventRec, "version" | "updated_at"> & { version?: number }): EventRec {
  const e: EventRec = { ...rec, version: rec.version ?? 1, updated_at: rec.created_at };
  events.set(e.id, e);
  return e;
}

export function reset(): void {
  categories = new Map();
  events = new Map();
  tickets = new Map();
  covers = new Map();
  idempotency = new Map();
  eventRequests.length = 0;
  failCheckins = 0;
  seq = 0;
  const t0 = nowMs();
  // Menit bulat agar data contoh mudah dibaca di dev:mock; hold dan jendela tetap relatif terhadap waktu nyata.
  const now = Math.floor(t0 / 60_000) * 60_000;
  const created = iso(now - 60 * DAY);

  const cats: [keyof typeof CATEGORY_IDS, string, number, boolean][] = [
    ["reuni", "Reuni", 1, true],
    ["seminar", "Seminar", 2, true],
    ["tour", "Tour", 3, true],
    ["kemerdekaan", "Hari Kemerdekaan", 4, true],
    ["kajian", "Kajian", 5, false],
  ];
  for (const [key, label, order, active] of cats)
    categories.set(CATEGORY_IDS[key], {
      id: CATEGORY_IDS[key],
      slug: key === "kemerdekaan" ? "hari-kemerdekaan" : key,
      label,
      sort_order: order,
      active,
      version: 1,
      created_at: created,
      updated_at: created,
    });

  const creator = mockAdminRef();
  const base = {
    description: null,
    location_address: null,
    location_url: null,
    checkin_opens_at: null,
    checkin_closes_at: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: created,
    created_by: creator,
    timezone: "Asia/Jakarta",
  };

  const reuni = event({
    ...base,
    id: MOCK_EVENT_IDS.reuni,
    title: "Reuni Akbar KAPDH 2026",
    description: "Silaturahmi akbar seluruh angkatan di Pondok Darel Hikmah.",
    category_id: CATEGORY_IDS.reuni,
    location_name: "Pondok Darel Hikmah",
    location_address: "Jl. Pesantren No. 1, Pekanbaru",
    location_url: "https://maps.google.com/?q=Pondok+Darel+Hikmah",
    cover_file_id: seedCover("0199e100-0000-7000-8000-0000000000f1", "Reuni Akbar", "#1A4B17"),
    starts_at: iso(now + HOUR),
    ends_at: iso(now + 6 * HOUR),
    registration_opens_at: iso(now - 30 * DAY),
    registration_closes_at: iso(now + HOUR),
    status: "open",
    price: "60000.00",
    seats_total: 1000,
    version: 3,
  });
  const officer = OTHER_ADMIN;
  const reuniTickets: TicketSeed[] = [
    {
      id: MOCK_TICKET_IDS.paid,
      qr: MOCK_TICKET_QR.paid,
      status: "paid",
      holder: holder("0199e100-0000-7000-8000-00000000a101", "Siti Rahmawati", "29.01.02.15", 29),
      payment: { status: "paid", submitted: now - 9 * DAY, decided: now - 8 * DAY },
      createdAt: now - 10 * DAY,
    },
    {
      qr: MOCK_TICKET_QR.paid2,
      status: "paid",
      holder: holder("0199e100-0000-7000-8000-00000000a102", "Ahmad Fauzi", "31.02.01.22", 31),
      payment: { status: "paid", submitted: now - 7 * DAY, decided: now - 6 * DAY },
      createdAt: now - 8 * DAY,
    },
    {
      qr: MOCK_TICKET_QR.checkedIn,
      status: "paid",
      holder: holder("0199e100-0000-7000-8000-00000000a103", "Nurul Hidayah", "27.01.01.8", 27),
      payment: { status: "paid", submitted: now - 6 * DAY, decided: now - 5 * DAY },
      checkedIn: { at: now - 20 * 60_000, by: officer },
      createdAt: now - 7 * DAY,
    },
    {
      id: MOCK_TICKET_IDS.review,
      qr: MOCK_TICKET_QR.review,
      status: "awaiting_review",
      holder: holder("0199e100-0000-7000-8000-00000000a104", "Dewi Lestari", "30.01.02.11", 30),
      payment: { status: "pending", submitted: now - 3 * DAY, due: now - HOUR },
      createdAt: now - 3 * DAY - HOUR,
    },
    {
      id: MOCK_TICKET_IDS.awaitingPayment,
      qr: MOCK_TICKET_QR.awaitingPayment,
      status: "awaiting_payment",
      holder: holder("0199e100-0000-7000-8000-00000000a105", "Hasan Basri", "32.01.01.40", 32),
      hold: now + 50 * 60_000,
      payment: { status: "pending" },
      createdAt: now - 2 * HOUR,
    },
    {
      qr: MOCK_TICKET_QR.holdExpired,
      status: "awaiting_payment",
      holder: holder("0199e100-0000-7000-8000-00000000a106", "Rina Marlina", "33.02.02.3", 33),
      hold: now - 2 * HOUR,
      payment: { status: "pending" },
      createdAt: now - 26 * HOUR,
    },
    {
      qr: MOCK_TICKET_QR.cancelled,
      status: "cancelled",
      holder: holder("0199e100-0000-7000-8000-00000000a107", "Fajar Nugroho", "28.01.01.19", 28),
      cancelled: { at: now - 4 * DAY, by: "self", reason: "Berhalangan hadir." },
      payment: { status: "cancelled" },
      createdAt: now - 12 * DAY,
    },
    {
      qr: MOCK_TICKET_QR.ineligible,
      status: "paid",
      eligible: false,
      holder: holder("0199e100-0000-7000-8000-00000000a108", "Yusuf Maulana", "26.01.02.5", 26),
      payment: { status: "paid", submitted: now - 15 * DAY, decided: now - 14 * DAY },
      createdAt: now - 16 * DAY,
    },
    {
      id: MOCK_TICKET_IDS.linked,
      qr: "KAPDH-T-1a1a1a1a1b1b1b1b1c1c1c1c1d1d1d12",
      status: "paid",
      holder: holder(MOCK_LINKED_ALUMNI_ID, "Bayu Musthafa", "25.01.01.2", 25),
      payment: { status: "paid", submitted: now - 20 * DAY, decided: now - 19 * DAY },
      createdAt: now - 21 * DAY,
    },
    {
      id: MOCK_TICKET_IDS.deleted,
      qr: "KAPDH-T-2b2b2b2b2c2c2c2c2d2d2d2d2e2e2e13",
      status: "paid",
      eligible: false,
      // Akun pemegang dihapus: data pemegang anonim (AC F14-4).
      holder: holder(null, null, null, null),
      payment: { status: "paid", submitted: now - 25 * DAY, decided: now - 24 * DAY },
      createdAt: now - 26 * DAY,
    },
  ];
  for (const t of reuniTickets) addTicket(reuni, t);

  const seminar = event({
    ...base,
    id: MOCK_EVENT_IDS.seminar,
    title: "Seminar AI untuk Alumni",
    description: "Pengenalan kecerdasan buatan untuk dunia kerja.",
    category_id: CATEGORY_IDS.seminar,
    location_name: "Aula Gedung Serbaguna",
    cover_file_id: seedCover("0199e100-0000-7000-8000-0000000000f2", "Seminar AI", "#2E7D32"),
    starts_at: iso(now + 10 * DAY),
    ends_at: iso(now + 10 * DAY + 3 * HOUR),
    registration_opens_at: iso(now - 5 * DAY),
    registration_closes_at: iso(now + 9 * DAY),
    status: "open",
    price: "0.00",
    seats_total: 100,
  });
  addTicket(seminar, {
    qr: MOCK_TICKET_QR.seminar,
    status: "paid",
    holder: holder("0199e100-0000-7000-8000-00000000a101", "Siti Rahmawati", "29.01.02.15", 29),
    createdAt: now - 4 * DAY,
  });

  event({
    ...base,
    id: MOCK_EVENT_IDS.mancing,
    title: "Mancing Bareng Alumni",
    category_id: CATEGORY_IDS.tour,
    location_name: "Kolam Pemancingan Lubuk Indah",
    cover_file_id: null,
    starts_at: iso(now + 30 * DAY),
    ends_at: iso(now + 30 * DAY + 5 * HOUR),
    registration_opens_at: iso(now + DAY),
    registration_closes_at: iso(now + 28 * DAY),
    status: "draft",
    price: "25000.00",
    seats_total: 100,
  });

  const kajian = event({
    ...base,
    id: MOCK_EVENT_IDS.kajian,
    title: "Kajian Subuh Bersama",
    category_id: CATEGORY_IDS.kajian,
    location_name: "Masjid Darel Hikmah",
    cover_file_id: null,
    starts_at: iso(now + 20 * HOUR),
    ends_at: iso(now + 22 * HOUR),
    registration_opens_at: iso(now - 7 * DAY),
    registration_closes_at: iso(now + 12 * HOUR),
    status: "closed",
    price: "0.00",
    seats_total: 50,
    version: 2,
  });
  addTicket(kajian, {
    qr: MOCK_TICKET_QR.kajian,
    status: "paid",
    holder: holder("0199e100-0000-7000-8000-00000000a102", "Ahmad Fauzi", "31.02.01.22", 31),
    createdAt: now - 2 * DAY,
  });

  const jalan = event({
    ...base,
    id: MOCK_EVENT_IDS.jalan,
    title: "Jalan Sehat Kemerdekaan",
    category_id: CATEGORY_IDS.kemerdekaan,
    location_name: "Lapangan Pondok",
    cover_file_id: seedCover("0199e100-0000-7000-8000-0000000000f3", "Jalan Sehat", "#C9A227"),
    starts_at: iso(now - 57 * DAY),
    ends_at: iso(now - 57 * DAY + 4 * HOUR),
    registration_opens_at: iso(now - 80 * DAY),
    registration_closes_at: iso(now - 58 * DAY),
    status: "done",
    price: "0.00",
    seats_total: 140,
    version: 4,
  });
  addTicket(jalan, {
    qr: "KAPDH-T-3c3c3c3c3d3d3d3d3e3e3e3e3f3f3f14",
    status: "paid",
    holder: holder("0199e100-0000-7000-8000-00000000a103", "Nurul Hidayah", "27.01.01.8", 27),
    checkedIn: { at: now - 57 * DAY, by: officer },
    createdAt: now - 70 * DAY,
  });

  const pramuka = event({
    ...base,
    id: MOCK_EVENT_IDS.pramuka,
    title: "Pramuka Bersama",
    category_id: CATEGORY_IDS.seminar,
    location_name: "Lapangan Pramuka",
    cover_file_id: null,
    starts_at: iso(now + 5 * DAY),
    ends_at: iso(now + 5 * DAY + 4 * HOUR),
    registration_opens_at: iso(now - 20 * DAY),
    registration_closes_at: iso(now + 4 * DAY),
    status: "cancelled",
    price: "35000.00",
    seats_total: 100,
    cancelled_at: iso(now - 2 * DAY),
    cancel_reason: "Lokasi tidak tersedia karena renovasi.",
    version: 5,
  });
  addTicket(pramuka, {
    qr: MOCK_TICKET_QR.pramuka,
    status: "cancelled",
    holder: holder("0199e100-0000-7000-8000-00000000a104", "Dewi Lestari", "30.01.02.11", 30),
    cancelled: { at: now - 2 * DAY, by: "admin", reason: "Lokasi tidak tersedia karena renovasi." },
    payment: { status: "paid", submitted: now - 10 * DAY, decided: now - 9 * DAY },
    createdAt: now - 11 * DAY,
  });
  const pramukaTicket = ticketsOf(pramuka.id)[0]!;
  pramukaTicket.refunds.push({
    id: nextId("7f"),
    status: "pending",
    amount: pramuka.price,
    due_at: addBusinessDays(now - 2 * DAY, REFUND_BUSINESS_DAYS),
    completed_at: null,
    cancelled_at: null,
    created_at: iso(now - 2 * DAY),
  });
}
reset();

/** Kendali server tiruan untuk uji dan dev:mock. */
export const mockEvents = {
  /** Pengurus lain mengubah event (versi naik), untuk uji konflik versi (AC F15-4). */
  editElsewhere(eventId: string, patch: Partial<Pick<EventRec, "title" | "seats_total" | "location_name">>) {
    const e = events.get(eventId);
    if (!e) throw new Error(`Event ${eventId} tidak ada`);
    Object.assign(e, patch, { version: e.version + 1, updated_at: iso(nowMs()) });
  },
  /** Anggota memesan `count` kursi baru (hold aktif) tanpa mengubah versi event, untuk uji AC F15-2. */
  addHolds(eventId: string, count: number) {
    const e = events.get(eventId);
    if (!e) throw new Error(`Event ${eventId} tidak ada`);
    for (let i = 0; i < count; i += 1)
      addTicket(e, {
        qr: `KAPDH-T-hold-${eventId.slice(-4)}-${seq}-${i}`,
        status: "awaiting_payment",
        holder: holder(nextId("a9"), `Peserta Baru ${i + 1}`, null, 34),
        hold: nowMs() + 20 * HOUR,
        payment: { status: "pending" },
        createdAt: nowMs(),
      });
  },
  /** POST /admin/checkin gagal karena jaringan `times` kali berikutnya. */
  failCheckins(times = 1) {
    failCheckins = times;
  },
  /** Pengurus lain membatalkan event (semua tiket aktif cancelled), mis. saat petugas sedang memindai (AC F09-7). */
  cancelElsewhere(eventId: string, reason = "Dibatalkan pengurus lain.") {
    const e = events.get(eventId);
    if (!e) throw new Error(`Event ${eventId} tidak ada`);
    const now = nowMs();
    for (const t of ticketsOf(e.id))
      if (t.status === "awaiting_payment" || t.status === "awaiting_review" || t.status === "paid") {
        t.status = "cancelled";
        t.cancelled_at = iso(now);
        t.cancelled_by = "admin";
        t.cancel_reason = reason;
        t.version += 1;
      }
    Object.assign(e, {
      status: "cancelled",
      cancelled_at: iso(now),
      cancel_reason: reason,
      version: e.version + 1,
      updated_at: iso(now),
    });
  },
  /** Ubah jendela check-in khusus event (ms epoch), untuk uji too_early/too_late (D5). */
  setCheckinWindow(eventId: string, opensMs: number, closesMs: number) {
    const e = events.get(eventId);
    if (!e) throw new Error(`Event ${eventId} tidak ada`);
    Object.assign(e, { checkin_opens_at: iso(opensMs), checkin_closes_at: iso(closesMs) });
  },
  event(eventId: string): Detail | null {
    const e = events.get(eventId);
    return e ? detail(e) : null;
  },
  ticket(ticketId: string): Ticket | null {
    const t = tickets.get(ticketId);
    return t ? ticketView(t) : null;
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Validasi
// ---------------------------------------------------------------------------------------------------------------

type FieldErrors = Record<string, string[]>;

function validationError(fieldErrors: FieldErrors, status = 400, current?: unknown): Response {
  return error(status, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
    field_errors: fieldErrors,
    ...(current === undefined ? {} : { current }),
  });
}

const MONEY_RE = /^\d{1,12}\.\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type EditableKey =
  | "title"
  | "description"
  | "category_id"
  | "location_name"
  | "location_address"
  | "location_url"
  | "cover_file_id"
  | "timezone"
  | "starts_at"
  | "ends_at"
  | "registration_opens_at"
  | "registration_closes_at"
  | "checkin_opens_at"
  | "checkin_closes_at"
  | "price"
  | "seats_total";

const EDITABLE_KEYS: EditableKey[] = [
  "title",
  "description",
  "category_id",
  "location_name",
  "location_address",
  "location_url",
  "cover_file_id",
  "timezone",
  "starts_at",
  "ends_at",
  "registration_opens_at",
  "registration_closes_at",
  "checkin_opens_at",
  "checkin_closes_at",
  "price",
  "seats_total",
];

type EventFields = Pick<EventRec, EditableKey>;

function push(errors: FieldErrors, field: string, message: string): void {
  (errors[field] ??= []).push(message);
}

/**
 * Validasi bentuk field yang dikirim lalu aturan gabungan pada hasil akhir (kontrak adminCreateEvent: waktu,
 * check-in D5, https, zona IANA, kategori aktif, cover milik pemanggil).
 */
function validateEvent(
  body: Record<string, unknown>,
  merged: EventFields,
  changed: Set<EditableKey>,
  existingCategory: string | null,
  existingCover: string | null,
): FieldErrors {
  const errors: FieldErrors = {};
  const str = (k: EditableKey, max: number, nullable: boolean) => {
    if (!(k in body)) return;
    const v = body[k];
    if (v === null && nullable) return;
    if (typeof v !== "string") return push(errors, k, "Nilai tidak valid.");
    if (v.length > max) push(errors, k, `Maksimal ${max} karakter.`);
  };
  if ("title" in body) {
    const t = body.title;
    if (typeof t !== "string" || t.trim().length === 0) push(errors, "title", "Nama event wajib diisi.");
    else if (t.trim().length > 200) push(errors, "title", "Nama event maksimal 200 karakter.");
  }
  str("description", 5000, true);
  str("location_name", 200, true);
  str("location_address", 500, true);
  str("location_url", 500, true);
  str("timezone", 64, false);
  for (const k of [
    "starts_at",
    "ends_at",
    "registration_opens_at",
    "registration_closes_at",
    "checkin_opens_at",
    "checkin_closes_at",
  ] as const) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null && (k === "checkin_opens_at" || k === "checkin_closes_at")) continue;
    if (typeof v !== "string" || !ISO_RE.test(v) || Number.isNaN(Date.parse(v)))
      push(errors, k, "Tanggal dan jam tidak valid.");
  }
  if ("price" in body && (typeof body.price !== "string" || !MONEY_RE.test(body.price)))
    push(errors, "price", "Harga tidak valid.");
  if (
    "seats_total" in body &&
    (typeof body.seats_total !== "number" ||
      !Number.isInteger(body.seats_total) ||
      body.seats_total < 1 ||
      body.seats_total > 100_000)
  )
    push(errors, "seats_total", "Kuota harus bilangan bulat 1 sampai 100.000.");
  if (Object.keys(errors).length > 0) return errors;

  const t = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
  if (!(t(merged.ends_at) > t(merged.starts_at)))
    push(errors, "ends_at", "Waktu selesai harus setelah waktu mulai.");
  if (!(t(merged.registration_opens_at) < t(merged.registration_closes_at)))
    push(errors, "registration_closes_at", "Tutup pendaftaran harus setelah buka pendaftaran.");
  else if (t(merged.registration_closes_at) > t(merged.ends_at))
    push(errors, "registration_closes_at", "Tutup pendaftaran paling lambat saat event selesai.");
  const co = merged.checkin_opens_at;
  const cc = merged.checkin_closes_at;
  if ((co === null) !== (cc === null))
    push(
      errors,
      co === null ? "checkin_opens_at" : "checkin_closes_at",
      "Isi keduanya atau kosongkan keduanya.",
    );
  else if (co !== null && cc !== null && !(t(cc) > t(co)))
    push(errors, "checkin_closes_at", "Tutup check-in harus setelah buka check-in.");
  if (
    merged.location_url !== null &&
    changed.has("location_url") &&
    !/^https:\/\/\S+$/.test(merged.location_url)
  )
    push(errors, "location_url", "Tautan lokasi harus diawali https://.");
  if (changed.has("timezone") && !validTimeZone(merged.timezone))
    push(errors, "timezone", "Zona waktu tidak dikenal.");
  if (merged.category_id !== null && merged.category_id !== existingCategory) {
    const c = UUID_RE.test(merged.category_id) ? categories.get(merged.category_id) : undefined;
    if (!c || !c.active) push(errors, "category_id", "Pilih kategori event yang aktif.");
  }
  if (merged.cover_file_id !== null && merged.cover_file_id !== existingCover) {
    if (!covers.has(merged.cover_file_id))
      push(errors, "cover_file_id", "Gambar cover tidak ditemukan. Unggah ulang.");
  }
  return errors;
}

function readFields(
  body: Record<string, unknown>,
  base: EventFields,
): { merged: EventFields; changed: Set<EditableKey> } {
  const merged: EventFields = { ...base };
  const changed = new Set<EditableKey>();
  for (const k of EDITABLE_KEYS) {
    if (!(k in body)) continue;
    const v = body[k];
    if (k === "title" && typeof v === "string") (merged as Record<string, unknown>)[k] = v.trim();
    else (merged as Record<string, unknown>)[k] = v;
    if (base[k] !== merged[k]) changed.add(k);
  }
  return { merged, changed };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Idempotency-Key: payload sama mengembalikan respons pertama; payload berbeda -> 409 IDEMPOTENCY_CONFLICT. Respons
 * galat 4xx yang sudah pasti tidak disimpan (pengguna memperbaiki lalu mengirim ulang dengan key baru).
 */
async function idempotent(req: MockRequest, scope: string, run: () => Response): Promise<Response> {
  const key = req.headers.get("Idempotency-Key");
  if (!key) return run();
  const id = `${scope}:${key}`;
  const fingerprint = `${req.path}|${stableStringify(req.body)}`;
  const prior = idempotency.get(id);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      return error(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah dipakai untuk permintaan lain.");
    return json(prior.status, prior.body);
  }
  const res = run();
  if (res.status < 300) {
    const body: unknown = res.status === 204 ? undefined : await res.clone().json();
    idempotency.set(id, { fingerprint, status: res.status, body });
  }
  return res;
}

function versionConflict(current: unknown): Response {
  return error(
    409,
    "VERSION_CONFLICT",
    "Data sudah diubah orang lain. Muat ulang untuk melihat versi terbaru.",
    {
      current,
    },
  );
}

function ifMatchMismatch(req: MockRequest, version: number): boolean {
  const header = req.headers.get("If-Match");
  return header !== null && header.replace(/^W\//, "").replace(/"/g, "") !== String(version);
}

function missingIfMatch(req: MockRequest): Response | null {
  return req.headers.get("If-Match")
    ? null
    : error(400, "VALIDATION_ERROR", "Header If-Match wajib.", { field_errors: { "If-Match": ["Wajib."] } });
}

function findEvent(req: MockRequest): EventRec | Response {
  const id = req.params.eventId ?? "";
  if (!UUID_RE.test(id))
    return error(400, "VALIDATION_ERROR", "Id event tidak valid.", {
      field_errors: { eventId: ["Tidak valid."] },
    });
  const e = events.get(id);
  return e ?? error(404, "NOT_FOUND", "Event tidak ditemukan.");
}

/** Lepas fisik hold kedaluwarsa event (createEventReservation langkah 1): tiket expired, payment dibatalkan. */
function releaseExpiredHolds(e: EventRec, now: number): void {
  for (const t of ticketsOf(e.id)) {
    if (projectedStatus(t, now) !== "expired" || t.status !== "awaiting_payment") continue;
    t.status = "expired";
    t.version += 1;
    if (t.payment && t.payment.status === "pending")
      t.payment = { ...t.payment, status: "cancelled", review_due_at: null };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------------------------------------------

function checkinTicket(t: TicketRec): S["AdminCheckinTicket"] {
  const e = events.get(t.event_id)!;
  return {
    ticket_id: t.id,
    status: projectedStatus(t),
    event: { id: e.id, title: e.title, starts_at: e.starts_at, timezone: e.timezone },
    holder: {
      full_name: t.holder.full_name,
      member_number: t.holder.member_number,
      cohort_code: t.holder.cohort_code,
      avatar_url: t.holder.avatar_url,
    },
    checked_in_at: t.checked_in_at,
    checked_in_by: t.checked_in_by,
  };
}

const REJECTION: Record<RejectionReason, { code: S["ErrorCode"]; message: (t: TicketRec) => string }> = {
  other_event: {
    code: "VALIDATION_ERROR",
    message: (t) => `Tiket ini untuk event lain: ${events.get(t.event_id)?.title ?? "-"}.`,
  },
  event_cancelled: {
    code: "VALIDATION_ERROR",
    message: () => "Event dibatalkan; seluruh QR tiket tidak berlaku.",
  },
  ticket_cancelled: { code: "VALIDATION_ERROR", message: () => "Tiket sudah dibatalkan." },
  ticket_expired: {
    code: "RESERVATION_EXPIRED",
    message: () => "Tiket kedaluwarsa; reservasi tidak dibayar.",
  },
  ticket_awaiting_payment: {
    code: "PAYMENT_STATE_CONFLICT",
    message: () => "Tiket belum dibayar.",
  },
  ticket_awaiting_review: {
    code: "PAYMENT_STATE_CONFLICT",
    message: () => "Pembayaran tiket belum diverifikasi.",
  },
  already_checked_in: { code: "TICKET_ALREADY_CHECKED_IN", message: () => "Tiket ini sudah check-in." },
  holder_ineligible: { code: "VALIDATION_ERROR", message: () => "Pemegang tiket tidak memenuhi syarat." },
  too_early: { code: "VALIDATION_ERROR", message: () => "Jendela check-in belum dibuka." },
  too_late: { code: "VALIDATION_ERROR", message: () => "Jendela check-in sudah berakhir." },
};

/** Pemeriksaan 1-6 kontrak adminCheckInTicket; null = boleh check-in. */
function rejectionFor(t: TicketRec, eventId: string, now: number): RejectionReason | null {
  const e = events.get(t.event_id)!;
  if (t.event_id !== eventId) return "other_event";
  if (e.status === "cancelled") return "event_cancelled";
  const s = projectedStatus(t, now);
  if (s === "cancelled") return "ticket_cancelled";
  if (s === "expired") return "ticket_expired";
  if (s === "awaiting_payment") return "ticket_awaiting_payment";
  if (s === "awaiting_review") return "ticket_awaiting_review";
  if (t.checked_in_at) return "already_checked_in";
  if (!t.holder_eligible) return "holder_ineligible";
  const w = checkinWindow(e);
  if (now < Date.parse(w.opens)) return "too_early";
  if (e.status === "done" || now > Date.parse(w.closes)) return "too_late";
  return null;
}

function rejection(t: TicketRec, reason: RejectionReason): Response {
  const e = events.get(t.event_id)!;
  const w = checkinWindow(e);
  const r = REJECTION[reason];
  const current: S["AdminCheckinRejectionDetail"] = {
    rejection_reason: reason,
    ticket: checkinTicket(t),
    checkin_opens_at: w.opens,
    checkin_closes_at: w.closes,
  };
  return error(409, r.code, r.message(t), { current });
}

// ---------------------------------------------------------------------------------------------------------------
// Rute
// ---------------------------------------------------------------------------------------------------------------

const EVENT_SORTS: S["AdminEventSort"][] = [
  "starts_at_desc",
  "starts_at_asc",
  "created_at_desc",
  "title_asc",
  "registration_closes_at_asc",
];
const TICKET_SORTS: S["AdminEventTicketSort"][] = [
  "created_at_desc",
  "created_at_asc",
  "holder_name_asc",
  "checked_in_at_desc",
];
const EVENT_STATUSES: EventStatus[] = ["draft", "open", "closed", "done", "cancelled"];
const TICKET_STATUSES: TicketStatus[] = [
  "awaiting_payment",
  "awaiting_review",
  "paid",
  "expired",
  "cancelled",
];

function queryError(field: string): Response {
  return error(400, "VALIDATION_ERROR", "Parameter tidak valid.", {
    field_errors: { [field]: ["Tidak valid."] },
  });
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function validateCategoryBody(
  body: Record<string, unknown>,
  creating: boolean,
  selfId?: string,
): FieldErrors {
  const errors: FieldErrors = {};
  if (creating || "label" in body) {
    const l = body.label;
    if (typeof l !== "string" || l.trim().length === 0) push(errors, "label", "Nama kategori wajib diisi.");
    else if (l.trim().length > 60) push(errors, "label", "Nama kategori maksimal 60 karakter.");
  }
  if ("slug" in body && body.slug !== undefined) {
    const s = body.slug;
    if (typeof s !== "string" || (s !== "" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)))
      push(errors, "slug", "Slug hanya huruf kecil, angka dan tanda hubung.");
  }
  if ("sort_order" in body && (typeof body.sort_order !== "number" || !Number.isInteger(body.sort_order)))
    push(errors, "sort_order", "Urutan harus bilangan bulat.");
  if ("active" in body && typeof body.active !== "boolean") push(errors, "active", "Nilai tidak valid.");
  if (Object.keys(errors).length === 0) {
    const slug =
      typeof body.slug === "string" && body.slug !== ""
        ? body.slug
        : creating
          ? slugify(String(body.label))
          : undefined;
    if (slug !== undefined && [...categories.values()].some((c) => c.slug === slug && c.id !== selfId))
      push(errors, "slug", "Slug sudah dipakai kategori lain.");
  }
  return errors;
}

export const routes: MockRoute[] = [
  // ---------------- Kategori (ringkas untuk formulir/filter) ----------------
  {
    method: "GET",
    path: "/admin/event-categories",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const items: S["AdminEventCategory"][] = [...categories.values()]
        .sort((a, b) => a.sort_order - b.sort_order || cmp(a.label, b.label))
        .map((c) => ({ id: c.id, slug: c.slug, label: c.label, active: c.active, sort_order: c.sort_order }));
      return json(200, { items } satisfies S["AdminEventCategoryList"]);
    },
  },
  // ---------------- Manajemen Kategori event (admin-content, izin events.manage) ----------------
  {
    method: "GET",
    path: "/admin/content/event-categories",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const active = req.url.searchParams.get("active");
      const q = (req.url.searchParams.get("q") ?? "").trim().toLowerCase();
      const items = [...categories.values()]
        .filter((c) => (active === null ? true : String(c.active) === active))
        .filter((c) => !q || c.label.toLowerCase().includes(q) || c.slug.includes(q))
        .sort((a, b) => a.sort_order - b.sort_order || cmp(a.label, b.label))
        .map(categoryView);
      return json(200, paginate(items, req.url) satisfies S["AdminContentCategoryPage"]);
    },
  },
  {
    method: "POST",
    path: "/admin/content/event-categories",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      return idempotent(req, "category.create", () => {
        const body = req.body ?? {};
        const errors = validateCategoryBody(body, true);
        if (Object.keys(errors).length > 0)
          return errors.slug?.some((m) => m.includes("dipakai"))
            ? validationError(errors, 409)
            : validationError(errors);
        const now = iso(nowMs());
        const label = String(body.label).trim();
        const rec: CategoryRec = {
          id: nextId("c0"),
          slug: typeof body.slug === "string" && body.slug !== "" ? body.slug : slugify(label),
          label,
          sort_order: typeof body.sort_order === "number" ? body.sort_order : 0,
          active: typeof body.active === "boolean" ? body.active : true,
          version: 1,
          created_at: now,
          updated_at: now,
        };
        categories.set(rec.id, rec);
        return json(201, categoryView(rec));
      });
    },
  },
  {
    method: "PATCH",
    path: "/admin/content/event-categories/{categoryId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const c = categories.get(req.params.categoryId ?? "");
      if (!c) return error(404, "NOT_FOUND", "Kategori tidak ditemukan.");
      const missing = missingIfMatch(req);
      if (missing) return missing;
      if (ifMatchMismatch(req, c.version)) return versionConflict(categoryView(c));
      const body = req.body ?? {};
      const errors = validateCategoryBody(body, false, c.id);
      if (Object.keys(errors).length > 0)
        return errors.slug?.some((m) => m.includes("dipakai"))
          ? validationError(errors, 409)
          : validationError(errors);
      if (typeof body.label === "string") c.label = body.label.trim();
      if (typeof body.slug === "string" && body.slug !== "") c.slug = body.slug;
      if (typeof body.sort_order === "number") c.sort_order = body.sort_order;
      if (typeof body.active === "boolean") c.active = body.active;
      c.version += 1;
      c.updated_at = iso(nowMs());
      return json(200, categoryView(c));
    },
  },
  {
    method: "DELETE",
    path: "/admin/content/event-categories/{categoryId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const c = categories.get(req.params.categoryId ?? "");
      if (!c) return error(404, "NOT_FOUND", "Kategori tidak ditemukan.");
      const missing = missingIfMatch(req);
      if (missing) return missing;
      if (ifMatchMismatch(req, c.version)) return versionConflict(categoryView(c));
      if (categoryView(c).usage_count > 0)
        return error(409, "VALIDATION_ERROR", "Kategori masih dipakai event. Nonaktifkan saja.", {
          field_errors: { _: ["Kategori masih dipakai event. Nonaktifkan saja."] },
          current: categoryView(c),
        });
      categories.delete(c.id);
      return noContent();
    },
  },
  // ---------------- Cover event ----------------
  {
    method: "POST",
    path: "/admin/event-covers",
    handler: async (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const form = await readMultipart(req.raw);
      const file = form?.file;
      if (!file || typeof file === "string")
        return error(400, "VALIDATION_ERROR", "Berkas wajib dipilih.", {
          field_errors: { file: ["Wajib."] },
        });
      const f: MockFile = file;
      if (f.type !== "image/jpeg" && f.type !== "image/png")
        return error(415, "FILE_INVALID", "Tipe berkas tidak diterima.");
      if (f.size > COVER_MAX_BYTES) return error(413, "FILE_INVALID", "Gambar melebihi 5 MB.");
      if (f.size === 0) return error(422, "FILE_INVALID", "Berkas kosong atau rusak.");
      let binary = "";
      for (const b of f.bytes) binary += String.fromCharCode(b);
      const id = nextId("f0");
      const media: S["AdminEventCoverMedia"] = {
        file_id: id,
        url: `data:${f.type};base64,${btoa(binary)}`,
        mime: f.type,
        bytes: f.size,
        width: 1280,
        height: 720,
      };
      covers.set(id, { media, attached: false });
      return json(201, media);
    },
  },
  // ---------------- Event ----------------
  {
    method: "GET",
    path: "/admin/events",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const p = req.url.searchParams;
      const q = (p.get("q") ?? "").trim().toLowerCase();
      const status = p.get("status");
      const categoryId = p.get("category_id");
      const sort = (p.get("sort") ?? "starts_at_desc") as S["AdminEventSort"];
      const from = p.get("starts_from");
      const to = p.get("starts_to");
      if (status !== null && !EVENT_STATUSES.includes(status as EventStatus)) return queryError("status");
      if (categoryId !== null && !UUID_RE.test(categoryId)) return queryError("category_id");
      if (!EVENT_SORTS.includes(sort)) return queryError("sort");
      const now = nowMs();
      const items = [...events.values()]
        .filter(
          (e) => !q || e.title.toLowerCase().includes(q) || (e.location_name ?? "").toLowerCase().includes(q),
        )
        .filter((e) => status === null || e.status === status)
        .filter((e) => categoryId === null || e.category_id === categoryId)
        .filter((e) => from === null || Date.parse(e.starts_at) >= Date.parse(from))
        .filter((e) => to === null || Date.parse(e.starts_at) < Date.parse(to))
        .sort((a, b) => {
          const r =
            sort === "starts_at_asc"
              ? cmp(a.starts_at, b.starts_at)
              : sort === "created_at_desc"
                ? cmp(b.created_at, a.created_at)
                : sort === "title_asc"
                  ? a.title.localeCompare(b.title, "id")
                  : sort === "registration_closes_at_asc"
                    ? cmp(a.registration_closes_at, b.registration_closes_at)
                    : cmp(b.starts_at, a.starts_at);
          return r || cmp(a.id, b.id);
        })
        .map((e) => summary(e, now));
      return json(200, paginate(items, req.url) satisfies S["AdminEventPage"]);
    },
  },
  {
    method: "POST",
    path: "/admin/events",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      return idempotent(req, "event.create", () => {
        const body = req.body ?? {};
        const errors: FieldErrors = {};
        for (const k of [
          "title",
          "starts_at",
          "ends_at",
          "registration_opens_at",
          "registration_closes_at",
          "price",
          "seats_total",
        ])
          if (!(k in body)) push(errors, k, "Wajib diisi.");
        if (Object.keys(errors).length > 0) return validationError(errors);
        const empty: EventFields = {
          title: "",
          description: null,
          category_id: null,
          location_name: null,
          location_address: null,
          location_url: null,
          cover_file_id: null,
          timezone: "Asia/Jakarta",
          starts_at: "",
          ends_at: "",
          registration_opens_at: "",
          registration_closes_at: "",
          checkin_opens_at: null,
          checkin_closes_at: null,
          price: "0.00",
          seats_total: 1,
        };
        const { merged, changed } = readFields(body, empty);
        changed.add("timezone");
        const fieldErrors = validateEvent(body, merged, changed, null, null);
        if (Object.keys(fieldErrors).length > 0) return validationError(fieldErrors);
        const now = iso(nowMs());
        const rec: EventRec = {
          ...merged,
          id: nextId("e0"),
          status: "draft",
          version: 1,
          created_at: now,
          updated_at: now,
          cancelled_at: null,
          cancel_reason: null,
          created_by: mockAdminRef(),
        };
        if (rec.cover_file_id) covers.get(rec.cover_file_id)!.attached = true;
        events.set(rec.id, rec);
        return json(201, detail(rec));
      });
    },
  },
  {
    method: "GET",
    path: "/admin/events/{eventId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const e = findEvent(req);
      if (e instanceof Response) return e;
      return json(200, detail(e));
    },
  },
  {
    method: "PATCH",
    path: "/admin/events/{eventId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const e = findEvent(req);
      if (e instanceof Response) return e;
      const missing = missingIfMatch(req);
      if (missing) return missing;
      if (ifMatchMismatch(req, e.version)) return versionConflict(detail(e));
      if (e.status === "done" || e.status === "cancelled")
        return validationError({ _: ["Event yang sudah selesai atau dibatalkan tidak dapat diubah."] });
      const body = req.body ?? {};
      if (!EDITABLE_KEYS.some((k) => k in body)) return validationError({ _: ["Tidak ada perubahan."] });
      const { merged, changed } = readFields(body, e);
      const fieldErrors = validateEvent(body, merged, changed, e.category_id, e.cover_file_id);
      if (Object.keys(fieldErrors).length > 0) return validationError(fieldErrors);
      const now = nowMs();
      if (changed.has("seats_total") && merged.seats_total < e.seats_total) {
        // Kuota diturunkan: hold kedaluwarsa dilepas dulu dalam transaksi yang sama, lalu batas diperiksa (AC F15-2).
        releaseExpiredHolds(e, now);
        const c = seatCounts(e, now);
        if (merged.seats_total < c.held + c.paid)
          return validationError(
            {
              seats_total: [
                `Kuota tidak boleh di bawah ${c.held + c.paid} (kursi ditahan ${c.held} + terbayar ${c.paid}).`,
              ],
            },
            409,
            detail(e, now),
          );
      }
      if (changed.size === 0) return json(200, detail(e, now));
      if (merged.cover_file_id && changed.has("cover_file_id"))
        covers.get(merged.cover_file_id)!.attached = true;
      Object.assign(e, merged, { version: e.version + 1, updated_at: iso(now) });
      return json(200, detail(e, now));
    },
  },
  {
    method: "DELETE",
    path: "/admin/events/{eventId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const e = findEvent(req);
      if (e instanceof Response) return e;
      const missing = missingIfMatch(req);
      if (missing) return missing;
      if (ticketsOf(e.id).length > 0)
        return error(
          409,
          "VALIDATION_ERROR",
          "Event sudah memiliki tiket sehingga tidak dapat dihapus. Batalkan event.",
          {
            field_errors: { _: ["Event sudah memiliki tiket. Gunakan pembatalan event."] },
            current: detail(e),
          },
        );
      if (ifMatchMismatch(req, e.version)) return versionConflict(detail(e));
      events.delete(e.id);
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/admin/events/{eventId}/status",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const e = findEvent(req);
      if (e instanceof Response) return e;
      return idempotent(req, `event.status.${e.id}`, () => {
        const target = req.body?.status;
        if (target !== "open" && target !== "closed")
          return validationError({ status: ["Status harus open atau closed."] });
        const now = nowMs();
        if (e.status === target) return json(200, detail(e, now));
        const missing = missingIfMatch(req);
        if (missing) return missing;
        if (ifMatchMismatch(req, e.version)) return versionConflict(detail(e, now));
        const endsLater = Date.parse(e.ends_at) > now;
        const regOpen = Date.parse(e.registration_closes_at) > now;
        const ok =
          (e.status === "draft" && target === "open" && endsLater && regOpen) ||
          (e.status === "open" && target === "closed") ||
          (e.status === "closed" && target === "open" && endsLater && regOpen);
        if (!ok)
          return validationError({
            status: [
              e.status === "draft" || e.status === "closed"
                ? "Event tidak dapat dibuka: jendela pendaftaran atau acara sudah lewat."
                : "Perubahan status ini tidak diizinkan.",
            ],
          });
        e.status = target;
        e.version += 1;
        e.updated_at = iso(now);
        return json(200, detail(e, now));
      });
    },
  },
  {
    method: "POST",
    path: "/admin/events/{eventId}/cancel",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const e = findEvent(req);
      if (e instanceof Response) return e;
      return idempotent(req, `event.cancel.${e.id}`, () => {
        const reason = req.body?.reason;
        if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500)
          return validationError({ reason: ["Alasan wajib diisi, 3 sampai 500 karakter."] });
        if (e.status !== "open" && e.status !== "closed")
          return validationError({ _: ["Hanya event yang terbit (dibuka/ditutup) yang dapat dibatalkan."] });
        const missing = missingIfMatch(req);
        if (missing) return missing;
        if (ifMatchMismatch(req, e.version)) return versionConflict(detail(e));
        const now = nowMs();
        releaseExpiredHolds(e, now);
        let ticketsCancelled = 0;
        let paymentsCancelled = 0;
        let paymentsInReview = 0;
        let refunds = 0;
        let refundTotal = 0n;
        const active = ticketsOf(e.id)
          .filter(
            (t) => t.status === "awaiting_payment" || t.status === "awaiting_review" || t.status === "paid",
          )
          .sort((a, b) => cmp(a.id, b.id));
        for (const t of active) {
          const before = t.status;
          t.status = "cancelled";
          t.cancelled_at = iso(now);
          t.cancelled_by = "admin";
          t.cancel_reason = reason.trim();
          t.version += 1;
          ticketsCancelled += 1;
          if (before === "awaiting_payment" && t.payment?.status === "pending") {
            t.payment = { ...t.payment, status: "cancelled", review_due_at: null };
            paymentsCancelled += 1;
          } else if (before === "awaiting_review") paymentsInReview += 1;
          else if (before === "paid" && cents(t.total) > 0n) {
            t.refunds.push({
              id: nextId("7f"),
              status: "pending",
              amount: t.total,
              due_at: addBusinessDays(now, REFUND_BUSINESS_DAYS),
              completed_at: null,
              cancelled_at: null,
              created_at: iso(now),
            });
            refunds += 1;
            refundTotal += cents(t.total);
          }
        }
        e.status = "cancelled";
        e.cancelled_at = iso(now);
        e.cancel_reason = reason.trim();
        e.version += 1;
        e.updated_at = iso(now);
        const result: S["AdminEventCancelResult"] = {
          event: detail(e, now),
          tickets_cancelled: ticketsCancelled,
          payments_cancelled: paymentsCancelled,
          payments_in_review: paymentsInReview,
          refunds_created: refunds,
          refund_total: money(refundTotal),
        };
        return json(200, result);
      });
    },
  },
  {
    method: "GET",
    path: "/admin/events/{eventId}/stats",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const e = findEvent(req);
      if (e instanceof Response) return e;
      const now = nowMs();
      const counts = { awaiting_payment: 0, awaiting_review: 0, paid: 0, expired: 0, cancelled: 0 };
      let checkedIn = 0;
      let gross = 0n;
      let pending = 0n;
      let completed = 0n;
      for (const t of ticketsOf(e.id)) {
        counts[projectedStatus(t, now)] += 1;
        if (t.checked_in_at) checkedIn += 1;
        if (t.payment?.status === "paid") gross += cents(t.payment.amount);
        for (const r of t.refunds) {
          if (r.status === "pending") pending += cents(r.amount);
          if (r.status === "completed") completed += cents(r.amount);
        }
      }
      const s = summary(e, now);
      const stats: S["AdminEventStats"] = {
        event_id: e.id,
        status: e.status,
        seats_total: e.seats_total,
        seats_available: s.seats_available,
        awaiting_payment_count: counts.awaiting_payment,
        awaiting_review_count: counts.awaiting_review,
        paid_count: counts.paid,
        checked_in_count: checkedIn,
        expired_count: counts.expired,
        cancelled_count: counts.cancelled,
        gross_revenue: money(gross),
        refunds_pending_amount: money(pending),
        refunds_completed_amount: money(completed),
        net_revenue: money(gross - completed),
        generated_at: iso(now),
      };
      return json(200, stats);
    },
  },
  {
    method: "GET",
    path: "/admin/events/{eventId}/tickets",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const e = findEvent(req);
      if (e instanceof Response) return e;
      const p = req.url.searchParams;
      const status = p.get("status");
      const checkedIn = p.get("checked_in");
      const q = (p.get("q") ?? "").trim().toLowerCase();
      const sort = (p.get("sort") ?? "created_at_desc") as S["AdminEventTicketSort"];
      if (status !== null && !TICKET_STATUSES.includes(status as TicketStatus)) return queryError("status");
      if (checkedIn !== null && checkedIn !== "true" && checkedIn !== "false")
        return queryError("checked_in");
      if (!TICKET_SORTS.includes(sort)) return queryError("sort");
      const now = nowMs();
      const items = ticketsOf(e.id)
        .map((t) => ticketView(t, now))
        .filter((t) => status === null || t.status === status)
        .filter((t) => checkedIn === null || (t.checked_in_at !== null) === (checkedIn === "true"))
        .filter(
          (t) =>
            !q ||
            (t.holder.full_name ?? "").toLowerCase().includes(q) ||
            (t.holder.member_number ?? "").toLowerCase().includes(q),
        )
        .sort((a, b) => {
          const r =
            sort === "created_at_asc"
              ? cmp(a.created_at, b.created_at)
              : sort === "holder_name_asc"
                ? (a.holder.full_name ?? "￿").localeCompare(b.holder.full_name ?? "￿", "id")
                : sort === "checked_in_at_desc"
                  ? cmp(b.checked_in_at ?? "", a.checked_in_at ?? "")
                  : cmp(b.created_at, a.created_at);
          return r || cmp(a.id, b.id);
        });
      return json(200, paginate(items, req.url) satisfies S["AdminEventTicketPage"]);
    },
  },
  {
    method: "POST",
    path: "/admin/events/{eventId}/tickets/{ticketId}/cancel",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.manage");
      if (denied) return denied;
      const e = findEvent(req);
      if (e instanceof Response) return e;
      const t = tickets.get(req.params.ticketId ?? "");
      if (!t || t.event_id !== e.id) return error(404, "NOT_FOUND", "Tiket tidak ditemukan.");
      return idempotent(req, `ticket.cancel.${t.id}`, () => {
        const body = req.body ?? {};
        const reason = body.reason;
        const errors: FieldErrors = {};
        if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500)
          push(errors, "reason", "Alasan wajib diisi, 3 sampai 500 karakter.");
        if (typeof body.refund !== "boolean") push(errors, "refund", "Pilih refund atau tanpa refund.");
        if (Object.keys(errors).length > 0) return validationError(errors);
        const now = nowMs();
        // Refund adalah keputusan uang: izin dan konflik kepentingan diperiksa SEBELUM perubahan apa pun (PRD 2.3).
        if (body.refund === true) {
          if (!mockHasPermission("payments.decide"))
            return error(403, "FORBIDDEN", "Refund memerlukan izin memutus pembayaran (payments.decide).");
          if (t.holder.user_id === MOCK_LINKED_ALUMNI_ID)
            return error(
              403,
              "FORBIDDEN",
              "Refund untuk tiket akun alumni Anda sendiri harus diputus pengurus lain.",
            );
        }
        const missing = missingIfMatch(req);
        if (missing) return missing;
        const status = projectedStatus(t, now);
        if (status === "awaiting_review")
          return error(
            409,
            "PAYMENT_STATE_CONFLICT",
            "Bukti pembayaran sedang ditinjau. Putuskan pembayarannya lebih dahulu.",
            {
              current: ticketView(t, now),
            },
          );
        if (ifMatchMismatch(req, t.version)) return versionConflict(ticketView(t, now));
        if (
          e.status === "cancelled" ||
          t.checked_in_at !== null ||
          (status !== "awaiting_payment" && status !== "paid")
        )
          return error(409, "VERSION_CONFLICT", "Tiket tidak lagi dapat dibatalkan.", {
            current: ticketView(t, now),
          });
        if (body.refund === true && (status !== "paid" || cents(t.total) === 0n))
          return validationError({ refund: ["Refund hanya untuk tiket berbayar yang sudah lunas."] });
        t.status = "cancelled";
        t.cancelled_at = iso(now);
        t.cancelled_by = "admin";
        t.cancel_reason = (reason as string).trim();
        t.version += 1;
        if (status === "awaiting_payment" && t.payment?.status === "pending")
          t.payment = { ...t.payment, status: "cancelled", review_due_at: null };
        if (body.refund === true)
          t.refunds.push({
            id: nextId("7f"),
            status: "pending",
            amount: t.total,
            due_at: addBusinessDays(now, REFUND_BUSINESS_DAYS),
            completed_at: null,
            cancelled_at: null,
            created_at: iso(now),
          });
        return json(200, ticketView(t, now));
      });
    },
  },
  // ---------------- Check-in ----------------
  {
    method: "GET",
    path: "/admin/checkin/events",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "events.checkin");
      if (denied) return denied;
      const now = nowMs();
      const items: S["AdminCheckinEvent"][] = [...events.values()]
        .filter((e) => e.status === "open" || e.status === "closed")
        .map((e) => ({ e, w: checkinWindow(e) }))
        .filter(({ w }) => Date.parse(w.closes) > now && Date.parse(w.opens) <= now + DAY)
        .sort((a, b) => cmp(a.w.opens, b.w.opens) || cmp(a.e.id, b.e.id))
        .slice(0, 50)
        .map(({ e, w }) => {
          const c = seatCounts(e, now);
          return {
            id: e.id,
            title: e.title,
            starts_at: e.starts_at,
            ends_at: e.ends_at,
            timezone: e.timezone,
            location_name: e.location_name,
            status: e.status,
            checkin_opens_at: w.opens,
            checkin_closes_at: w.closes,
            checkin_open: now >= Date.parse(w.opens) && now <= Date.parse(w.closes),
            paid_count: c.paid,
            checked_in_count: c.checkedIn,
          };
        });
      return json(200, { items } satisfies S["AdminCheckinEventList"]);
    },
  },
  {
    method: "POST",
    path: "/admin/checkin",
    handler: (req) => {
      log(req);
      if (failCheckins > 0) {
        failCheckins -= 1;
        throw new TypeError("Failed to fetch");
      }
      const denied = requirePermission(req, "events.checkin");
      if (denied) return denied;
      return idempotent(req, "checkin", () => {
        const body = req.body ?? {};
        const eventId = body.event_id;
        const qr = body.qr_code;
        const errors: FieldErrors = {};
        if (typeof eventId !== "string" || !UUID_RE.test(eventId)) push(errors, "event_id", "Pilih event.");
        if (typeof qr !== "string" || qr.length < 1 || qr.length > 256)
          push(errors, "qr_code", "Kode tiket tidak valid.");
        if (Object.keys(errors).length > 0) return validationError(errors);
        if (!events.has(eventId as string)) return error(404, "NOT_FOUND", "Event tidak ditemukan.");
        const t = [...tickets.values()].find((x) => x.qr_code === qr);
        if (!t) return error(404, "NOT_FOUND", "QR bukan tiket KAPDH.");
        const now = nowMs();
        const reason = rejectionFor(t, eventId as string, now);
        if (reason) return rejection(t, reason);
        const by = mockAdminRef();
        t.checked_in_at = iso(now);
        t.checked_in_by = by;
        t.version += 1;
        const e = events.get(t.event_id)!;
        const c = seatCounts(e, now);
        const result: S["AdminCheckinResult"] = {
          ticket: checkinTicket(t),
          checked_in_at: t.checked_in_at,
          checked_in_by: by,
          event_checked_in_count: c.checkedIn,
          event_paid_count: c.paid,
        };
        return json(200, result);
      });
    },
  },
];
