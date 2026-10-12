import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Manajemen Users (F-15, F-16 reset alumni, F-10 master profesi/keahlian). Area members. */
export const membersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/members",
  beforeLoad: guard("/members"),
  component: lazyRouteComponent(() => import("./MembersPages"), "MembersPage"),
});

export const memberDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/members/$userId",
  beforeLoad: guard("/members/$userId"),
  component: lazyRouteComponent(() => import("./MembersPages"), "MemberDetailPage"),
});

export const mastersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/members/masters",
  beforeLoad: guard("/members/masters"),
  component: lazyRouteComponent(() => import("./MembersPages"), "MastersPage"),
});

export const membersRoutes = [membersRoute, memberDetailRoute, mastersRoute] as const;
