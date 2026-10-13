import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Tab halaman notifikasi: hasil pengiriman per kanal dan event outbox (F-13, PRD 5.1). */
export const NOTIFICATION_TABS = ["deliveries", "outbox"] as const;
export type NotificationTab = (typeof NOTIFICATION_TABS)[number];

export interface NotificationsSearch {
  tab?: NotificationTab;
  /**
   * Tautan "job gagal" dari dasbor: tampilkan pengiriman gagal yang dapat dikirim ulang sejak waktu ini
   * (DashboardJobs.failed_delivery_since), sehingga total daftar sama dengan angka dasbor.
   */
  since?: string;
}

export function validateNotificationsSearch(search: Record<string, unknown>): NotificationsSearch {
  const out: NotificationsSearch = {};
  if (NOTIFICATION_TABS.includes(search.tab as NotificationTab)) out.tab = search.tab as NotificationTab;
  if (typeof search.since === "string" && !Number.isNaN(Date.parse(search.since))) out.since = search.since;
  return out;
}

/** Pemantauan pengiriman notifikasi (F-13, notifications.manage, PRD 4.5). Area governance. */
export const notificationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/notifications",
  validateSearch: validateNotificationsSearch,
  beforeLoad: guard("/notifications"),
  component: lazyRouteComponent(() => import("./NotificationsPage"), "NotificationsPage"),
});

export const notificationsRoutes = [notificationsRoute] as const;
