import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Dasbor (F-15). Area governance. */
export const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: guard("/"),
  component: lazyRouteComponent(() => import("./DashboardPage"), "DashboardPage"),
});

export const dashboardRoutes = [dashboardRoute] as const;
