import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Audit dan ekspor (F-17, audit.read/audit.export). Area governance. */
export const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/audit",
  beforeLoad: guard("/audit"),
  component: lazyRouteComponent(() => import("./AuditPage"), "AuditPage"),
});

export const auditRoutes = [auditRoute] as const;
