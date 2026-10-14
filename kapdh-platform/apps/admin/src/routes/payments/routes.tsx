import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Tab /payments sesuai guidelines hlm. 17 (Verifikasi | Kelola Metode | Biaya) + Penyesuaian (PRD 3.4). */
export const PAYMENT_TABS = ["verify", "methods", "fees", "adjustments"] as const;
export type PaymentTab = (typeof PAYMENT_TABS)[number];

export interface PaymentsSearch {
  tab?: PaymentTab;
  /** Payment yang dibuka di panel keputusan (tautan dari tab Penyesuaian). */
  payment?: string;
  /** Penyesuaian yang dibuka di panel penyesuaian (tautan dari detail pembayaran). */
  adjustment?: string;
  /**
   * Filter awal antrean verifikasi dengan nama yang sama dengan filter adminListPayments, untuk tautan "Lewat batas
   * review" dasbor `/payments?stage=awaiting_review&overdue=true` (kontrak admin-dashboard: jumlahnya sama dengan
   * kartu dasbor dan ringkasan pembayaran).
   */
  stage?: "awaiting_review";
  overdue?: boolean;
  /**
   * Buka dialog "Catat iuran" (rencana cadangan D13, adminRecordPayment): `true` tanpa alumni terpilih (tautan dari
   * Pengaturan), atau user_id alumni (tautan dari detail anggota). Parameter dihapus setelah dialog dibuka.
   */
  record?: true | string;
}

/** `?overdue=true|false` (parser URL router menghasilkan boolean; string juga diterima). */
function parseBool(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nilai URL yang tidak dikenal diabaikan (bukan galat): tab bawaan, tanpa pilihan. */
export function validatePaymentsSearch(search: Record<string, unknown>): PaymentsSearch {
  const out: PaymentsSearch = {};
  if (PAYMENT_TABS.includes(search.tab as PaymentTab)) out.tab = search.tab as PaymentTab;
  if (typeof search.payment === "string" && UUID.test(search.payment)) out.payment = search.payment;
  if (typeof search.adjustment === "string" && UUID.test(search.adjustment))
    out.adjustment = search.adjustment;
  if (search.stage === "awaiting_review") out.stage = "awaiting_review";
  const overdue = parseBool(search.overdue);
  if (overdue !== undefined) out.overdue = overdue;
  if (parseBool(search.record) === true) out.record = true;
  else if (typeof search.record === "string" && UUID.test(search.record)) out.record = search.record;
  return out;
}

/** Verifikasi Pembayaran (F-03, F-04, F-15, D6). Area payments. */
export const paymentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/payments",
  validateSearch: validatePaymentsSearch,
  beforeLoad: guard("/payments"),
  component: lazyRouteComponent(() => import("./PaymentsPage"), "PaymentsPage"),
});

export const paymentsRoutes = [paymentsRoute] as const;
