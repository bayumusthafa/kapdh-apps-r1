import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Akun admin sendiri: ganti sandi, sesi aktif, backup code (F-02, F-16). Area governance. */
export const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/account",
  beforeLoad: guard("/account"),
  component: lazyRouteComponent(() => import("./AccountPage"), "AccountPage"),
});

export const accountRoutes = [accountRoute] as const;
