import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Pemantauan pengiriman notifikasi (F-13, notifications.manage, PRD 4.5). Area governance. */
export const notificationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/notifications",
  beforeLoad: guard("/notifications"),
  component: lazyRouteComponent(() => import("./NotificationsPage"), "NotificationsPage"),
});

export const notificationsRoutes = [notificationsRoute] as const;
