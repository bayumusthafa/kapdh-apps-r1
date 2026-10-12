import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Manajemen Admin (F-16, admins.manage, AC F16-1..F16-3). Area governance. */
export const adminsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admins",
  beforeLoad: guard("/admins"),
  component: lazyRouteComponent(() => import("./AdminsPages"), "AdminsPage"),
});

export const adminDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admins/$adminId",
  beforeLoad: guard("/admins/$adminId"),
  component: lazyRouteComponent(() => import("./AdminsPages"), "AdminDetailPage"),
});

export const adminsRoutes = [adminsRoute, adminDetailRoute] as const;
