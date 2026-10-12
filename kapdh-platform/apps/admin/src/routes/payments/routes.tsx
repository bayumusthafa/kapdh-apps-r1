import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Tab /payments sesuai guidelines hlm. 17 (Verifikasi | Kelola Metode | Biaya) + Penyesuaian (PRD 3.4). */
export const PAYMENT_TABS = ["verify", "methods", "fees", "adjustments"] as const;
export type PaymentTab = (typeof PAYMENT_TABS)[number];

export interface PaymentsSearch {
  tab?: PaymentTab;
}

/** Verifikasi Pembayaran (F-03, F-04, F-15). Area payments. */
export const paymentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/payments",
  validateSearch: (search: Record<string, unknown>): PaymentsSearch =>
    PAYMENT_TABS.includes(search.tab as PaymentTab) ? { tab: search.tab as PaymentTab } : {},
  beforeLoad: guard("/payments"),
  component: lazyRouteComponent(() => import("./PaymentsPage"), "PaymentsPage"),
});

export const paymentsRoutes = [paymentsRoute] as const;
