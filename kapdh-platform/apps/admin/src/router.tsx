import { createMemoryHistory, createRouter, type RouterHistory } from "@tanstack/react-router";
import type { RouterContext } from "./auth/guards";
import { PageSkeleton } from "./components/ui/States";
import { accountRoutes } from "./routes/account/routes";
import { adminsRoutes } from "./routes/admins/routes";
import { auditRoutes } from "./routes/audit/routes";
import { authRoutes } from "./routes/auth/routes";
import { contentRoutes } from "./routes/content/routes";
import { dashboardRoutes } from "./routes/dashboard/routes";
import { eventsRoutes } from "./routes/events/routes";
import { membersRoutes } from "./routes/members/routes";
import { moderationRoutes } from "./routes/moderation/routes";
import { notificationsRoutes } from "./routes/notifications/routes";
import { paymentsRoutes } from "./routes/payments/routes";
import { settingsRoutes } from "./routes/settings/routes";
import { appRoute, RouteErrorPage, rootRoute } from "./routes/__root";

/**
 * Pohon rute web admin (ARCHITECTURE §7). Semua rute sudah terdaftar sejak fondasi; setiap area mengekspor
 * daftarnya dari src/routes/<area>/routes.tsx dan memuat halamannya secara lazy (code splitting per area).
 */
export const routeTree = rootRoute.addChildren([
  ...authRoutes,
  appRoute.addChildren([
    ...dashboardRoutes,
    ...paymentsRoutes,
    ...membersRoutes,
    ...contentRoutes,
    ...eventsRoutes,
    ...moderationRoutes,
    ...adminsRoutes,
    ...auditRoutes,
    ...notificationsRoutes,
    ...settingsRoutes,
    ...accountRoutes,
  ]),
]);

export function createAppRouter(opts: { history?: RouterHistory; initialPath?: string } = {}) {
  return createRouter({
    routeTree,
    history:
      opts.history ??
      (opts.initialPath ? createMemoryHistory({ initialEntries: [opts.initialPath] }) : undefined),
    // Konteks diisi oleh <RouterProvider context={{ auth }}> di App.
    context: { auth: undefined! } as RouterContext,
    defaultPreload: "intent",
    defaultPendingComponent: PageSkeleton,
    defaultPendingMs: 150,
    defaultErrorComponent: RouteErrorPage,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
