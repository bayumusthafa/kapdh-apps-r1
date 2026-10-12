import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Pengaturan aplikasi (F-15, AC F15-3: versi minimum, maintenance, dukungan). Area governance. */
export const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  beforeLoad: guard("/settings"),
  component: lazyRouteComponent(() => import("./SettingsPage"), "SettingsPage"),
});

export const settingsRoutes = [settingsRoute] as const;
