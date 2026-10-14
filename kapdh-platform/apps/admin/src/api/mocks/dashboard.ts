import type { Permission } from "@kapdh/contracts";
import { mockHasPermission, requireAdmin } from "./auth";
import { peekEventStatsForMocks } from "./events";
import { error, json, type MockRequest, type MockRoute, type S } from "./http";
import { moderationCounts } from "./moderation";
import { notificationJobCounts } from "./notifications";
import { paymentRequests, routes as paymentRoutes } from "./payments";

/**
 * Tiruan dasbor pengurus (kontrak admin-dashboard C7, F-15, AC F15-1, guideline hlm. 11-12):
 * - setiap bagian HANYA disertakan bila pemanggil memiliki izinnya (bagian tanpa izin dihilangkan, bukan null/nol);
 * - hitungan antrean pembayaran diambil dari ringkasan tiruan pembayaran (GET /admin/payments/summary) sehingga sama
 *   dengan pill menu dan antrean; transaksi lunas = payment paid tiruan pembayaran ditambah riwayat contoh lama;
 * - hitungan moderasi dan job memakai fungsi bersama area masing-masing (aturan visibilitas dan definisi yang sama);
 * - bagian event (Tiket Terjual, Penjualan Tiket, Event mendatang) dibentuk dari tiruan area Event sehingga tautan
 *   /events/$eventId membuka event yang sama (satu sumber event di dev:mock);
 * - /admin/dashboard/badges: reports_open dan failed_jobs saja (pill pembayaran bersumber dari ringkasan pembayaran).
 * Data contoh bukan bukti AC (PRD 7.3).
 */
const DAY = 24 * 60 * 60_000;

export interface DashboardRequestLog {
  path: string;
  background: boolean;
}

/** Log permintaan dasbor (uji: header latar pada polling, AC F02-5). */
export const dashboardRequests: DashboardRequestLog[] = [];

/** Simulasi server dasbor bermasalah (5xx) untuk uji keadaan galat dan data usang (PRD 4.5). */
let failing = false;

export function reset(): void {
  dashboardRequests.length = 0;
  failing = false;
}

/** Kendali server tiruan dasbor untuk uji dan dev:mock. */
export const mockDashboard = {
  setFailing(value: boolean): void {
    failing = value;
  },
  /**
   * Riwayat transaksi contoh lama yang ikut dijumlah kartu Total Transaksi bersama payment paid tiruan pembayaran,
   * agar uji menurunkan total dari sumbernya alih-alih menyalin nominal fixture. Hanya baca.
   */
  historicalTransactions(): S["DashboardTransaction"][] {
    return historicalTransactions();
  },
};

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Daftar alumni terbaru (guideline hlm. 12 tabel "Pengguna"). */
function latestMembers(): S["DashboardMember"][] {
  return [
    {
      user_id: "0199e000-0000-7000-8000-0000000000c3",
      full_name: "Bayu Musthafa Arief",
      member_number: "09.02.01.5",
      effective_status: "verified",
      linked_admin: true,
      registered_at: iso(-2 * DAY),
    },
    {
      user_id: "0199e000-0000-7000-8000-0000000000c1",
      full_name: "ridwan",
      member_number: "06.02.01.4",
      effective_status: "verified",
      linked_admin: false,
      registered_at: iso(-3 * DAY),
    },
    {
      user_id: "0199e000-0000-7000-8000-0000000000c2",
      full_name: "Arya Kamandanu",
      member_number: "10.02.01.3",
      effective_status: "expiring",
      linked_admin: false,
      registered_at: iso(-5 * DAY),
    },
    {
      user_id: "0199e000-0000-7000-8000-0000000000c4",
      full_name: "Ahmad Zulhadi",
      member_number: "05.03.01.2",
      effective_status: "verified",
      linked_admin: true,
      registered_at: iso(-8 * DAY),
    },
    {
      user_id: "0199e000-0000-7000-8000-0000000000c5",
      full_name: "Sari Dewi",
      member_number: "11.01.02.8",
      effective_status: "suspended",
      linked_admin: false,
      registered_at: iso(-12 * DAY),
    },
    {
      user_id: "0199e000-0000-7000-8000-0000000000c6",
      full_name: "super core",
      member_number: null,
      effective_status: "unverified",
      linked_admin: false,
      registered_at: iso(-13 * DAY),
    },
  ];
}

function members(): S["DashboardMembers"] {
  const latest = latestMembers();
  const count = (s: S["EffectiveStatus"]) => latest.filter((m) => m.effective_status === s).length;
  const status_counts: S["DashboardMemberStatusCounts"] = {
    unverified: count("unverified"),
    verified: count("verified"),
    expiring: count("expiring"),
    expired: count("expired"),
    suspended: count("suspended"),
  };
  return {
    total_alumni: latest.length,
    // Kartu "Pengguna Aktif" = verified + expiring, tidak suspended.
    active_count: status_counts.verified + status_counts.expiring,
    status_counts,
    latest_members: latest,
  };
}

/**
 * Bagian event dasbor dibentuk dari tiruan area Event (mocks/events.ts), bukan data contoh sendiri: setiap baris
 * ditautkan ke /events/$eventId yang dijawab tiruan itu, sehingga id, judul dan hitungan kursi harus sama.
 */
function events(): S["DashboardEvents"] {
  const all = peekEventStatsForMocks();
  return {
    // Kartu "Tiket Terjual" = tiket paid di semua event.
    tickets_sold_count: all.reduce((n, e) => n + e.paid_quantity, 0),
    // Penjualan Tiket (guideline hlm. 12): event selain draft, urut starts_at menurun, maksimal 10.
    ticket_sales: all
      .filter((e) => e.status !== "draft")
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at) || a.id.localeCompare(b.id))
      .slice(0, 10)
      .map((e) => ({
        event_id: e.id,
        title: e.title,
        status: e.status,
        starts_at: e.starts_at,
        timezone: e.timezone,
        seats_total: e.seats_total,
        sold_count: e.paid_quantity,
        held_count: e.held_quantity,
        seats_available: e.seats_available,
        awaiting_review_count: e.awaiting_review_quantity,
      })),
  };
}

/** Event open/closed yang mulai dalam 30 hari ke depan, urut starts_at naik, maksimal 10 (kontrak AdminDashboard). */
function upcomingEvents(): S["DashboardUpcomingEvent"][] {
  const now = Date.now();
  return peekEventStatsForMocks()
    .filter((e) => e.status === "open" || e.status === "closed")
    .filter((e) => Date.parse(e.starts_at) > now && Date.parse(e.starts_at) <= now + 30 * DAY)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id))
    .slice(0, 10)
    .map((e) => ({
      event_id: e.id,
      title: e.title,
      status: e.status,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      timezone: e.timezone,
      location_name: e.location_name,
      seats_total: e.seats_total,
      sold_count: e.paid_quantity,
      held_count: e.held_quantity,
      checked_in_count: e.checked_in_count,
    }));
}

/** Riwayat transaksi lama (sebelum data antrean tiruan pembayaran); bentuk DashboardTransaction. */
function historicalTransactions(): S["DashboardTransaction"][] {
  const bayu = {
    user_id: "0199e000-0000-7000-8000-0000000000c3",
    full_name: "Bayu Musthafa Arief",
    member_number: "09.02.01.5",
  };
  return [
    {
      payment_id: "0199e000-0000-7000-8000-0000000004a1",
      type: "ticket",
      event_title: "Mancing Bareng Alumni",
      member: bayu,
      amount: "15224.00",
      paid_at: iso(-5 * DAY),
    },
    {
      payment_id: "0199e000-0000-7000-8000-0000000004a2",
      type: "registration",
      event_title: null,
      member: bayu,
      amount: "70000.00",
      paid_at: iso(-5 * DAY - 60 * 60_000),
    },
    {
      payment_id: "0199e000-0000-7000-8000-0000000004a3",
      type: "renewal",
      event_title: null,
      member: {
        user_id: "0199e000-0000-7000-8000-0000000000c1",
        full_name: "ridwan",
        member_number: "06.02.01.4",
      },
      amount: "10000.00",
      paid_at: iso(-6 * DAY),
    },
    {
      // Akun pemilik sudah dihapus: identitas anonim, jumlah dan tanggal tetap (AC F14-4).
      payment_id: "0199e000-0000-7000-8000-0000000004a4",
      type: "registration",
      event_title: null,
      member: { user_id: null, full_name: null, member_number: null },
      amount: "200000.00",
      paid_at: iso(-20 * DAY),
    },
  ];
}

/** Penjumlahan Money desimal tanpa floating point (ARCHITECTURE §2 butir 5). */
function sumMoney(values: string[]): string {
  const cents = values.reduce((acc, v) => {
    const [whole = "0", frac = "00"] = v.split(".");
    return acc + BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0").slice(0, 2));
  }, 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/**
 * Panggil handler GET tiruan pembayaran dengan sesi pemanggil yang sama, tanpa meninggalkan jejak di log uji area
 * pembayaran (permintaan internal tiruan, bukan permintaan klien).
 */
async function paymentsGet<T>(
  req: MockRequest,
  path: string,
  query: Record<string, string>,
): Promise<T | null> {
  const route = paymentRoutes.find((r) => r.method === "GET" && r.path === path);
  if (!route) return null;
  const url = new URL(`http://localhost/api/v1${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const logLength = paymentRequests.length;
  // Handler GET pembayaran mencatat log secara sinkron di awal; entri itu dibuang sebelum ada await sehingga
  // permintaan lain yang berjalan bersamaan tidak ikut terhapus.
  const pending = route.handler({ ...req, method: "GET", path, url, body: null, params: {} });
  paymentRequests.splice(logLength);
  const res = await pending;
  return res.ok ? ((await res.json()) as T) : null;
}

async function payments(req: MockRequest): Promise<S["DashboardPayments"] | null> {
  const summary = await paymentsGet<S["AdminPaymentSummary"]>(req, "/admin/payments/summary", {});
  const review = await paymentsGet<S["AdminPaymentPage"]>(req, "/admin/payments", {
    stage: "awaiting_review",
    limit: "100",
  });
  const paid = await paymentsGet<S["AdminPaymentPage"]>(req, "/admin/payments", {
    status: "paid",
    limit: "100",
  });
  if (!summary || !review || !paid) return null;
  const transactions: S["DashboardTransaction"][] = [
    ...paid.items.map((p) => ({
      payment_id: p.id,
      type: p.type,
      event_title: p.event_title,
      member: p.member
        ? { user_id: p.member.user_id, full_name: p.member.full_name, member_number: p.member.member_number }
        : { user_id: null, full_name: null, member_number: null },
      amount: p.amount,
      paid_at: p.decided_at ?? p.created_at,
    })),
    ...historicalTransactions(),
  ].sort((a, b) => b.paid_at.localeCompare(a.paid_at));
  const overdue = review.items.filter((p) => p.overdue);
  const submitted = review.items.map((p) => p.submitted_at).filter((v): v is string => v !== null);
  return {
    awaiting_review_count: summary.awaiting_review_count,
    awaiting_review_by_type: summary.awaiting_review_by_type,
    oldest_submitted_at: submitted.sort()[0] ?? null,
    overdue_count: summary.overdue_count,
    overdue_by_type: {
      registration: overdue.filter((p) => p.type === "registration").length,
      renewal: overdue.filter((p) => p.type === "renewal").length,
      ticket: overdue.filter((p) => p.type === "ticket").length,
    },
    awaiting_transfer_count: summary.awaiting_transfer_count,
    adjustments_pending_count: summary.adjustments_pending_count,
    adjustments_overdue_count: summary.adjustments_overdue_count,
    paid_total_amount: sumMoney(transactions.map((t) => t.amount)),
    paid_count: transactions.length,
    recent_transactions: transactions.slice(0, 10),
  };
}

const has = (p: Permission) => mockHasPermission(p);

function log(req: MockRequest): void {
  dashboardRequests.push({ path: req.path, background: req.headers.get("X-Background-Request") === "1" });
}

export const routes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/dashboard",
    handler: async (req) => {
      log(req);
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      if (failing) return error(500, "INTERNAL_ERROR", "Terjadi kesalahan pada server. Coba lagi.");
      // Bagian tanpa izin dihilangkan dari payload (AC F15-1); izin dibaca ulang setiap permintaan (AC F16-3).
      const body: S["AdminDashboard"] = { generated_at: new Date().toISOString() };
      if (has("payments.read")) {
        const p = await payments(req);
        if (p) body.payments = p;
      }
      if (has("members.read")) body.members = members();
      if (has("events.manage")) body.events = events();
      if (has("events.manage") || has("events.checkin")) body.upcoming_events = upcomingEvents();
      if (has("moderation.read")) {
        const c = moderationCounts();
        body.moderation = {
          open_count: c.open + c.in_review,
          urgent_count: c.urgent,
          overdue_count: c.overdue,
          oldest_open_created_at: c.oldest_open_created_at,
        };
      }
      if (has("notifications.manage"))
        body.jobs = { ...notificationJobCounts(), failed_account_deletion_count: 1 };
      return json(200, body);
    },
  },
  {
    method: "GET",
    path: "/admin/dashboard/badges",
    handler: (req) => {
      log(req);
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      const body: S["AdminNavBadges"] = {};
      if (has("moderation.read")) {
        const c = moderationCounts();
        body.reports_open = c.open + c.in_review;
      }
      if (has("notifications.manage")) {
        const j = notificationJobCounts();
        body.failed_jobs = j.failed_delivery_count + j.dead_outbox_count;
      }
      return json(200, body);
    },
  },
];
