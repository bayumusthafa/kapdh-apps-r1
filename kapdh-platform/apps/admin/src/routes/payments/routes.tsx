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
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nilai URL yang tidak dikenal diabaikan (bukan galat): tab bawaan, tanpa pilihan. */
export function validatePaymentsSearch(search: Record<string, unknown>): PaymentsSearch {
  const out: PaymentsSearch = {};
  if (PAYMENT_TABS.includes(search.tab as PaymentTab)) out.tab = search.tab as PaymentTab;
  if (typeof search.payment === "string" && UUID.test(search.payment)) out.payment = search.payment;
  if (typeof search.adjustment === "string" && UUID.test(search.adjustment)) out.adjustment = search.adjustment;
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
