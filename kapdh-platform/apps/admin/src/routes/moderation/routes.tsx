import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Moderasi laporan (F-12, moderation.read/resolve). Area governance. */
export const moderationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/moderation",
  beforeLoad: guard("/moderation"),
  component: lazyRouteComponent(() => import("./ModerationListPage"), "ModerationPage"),
});

export const reportRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/moderation/$reportId",
  beforeLoad: guard("/moderation/$reportId"),
  component: lazyRouteComponent(() => import("./ReportDetailPage"), "ReportDetailPage"),
});

export const moderationRoutes = [moderationRoute, reportRoute] as const;
