import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AppLayout, RequirePermission } from "./pages/AppLayout";
import { DashboardPage, NotBuiltPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { MfaPage } from "./pages/MfaPage";
import { PaymentsPage } from "./pages/PaymentsPage";

const rootRoute = createRootRoute({ component: Outlet });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage });
const mfaRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login/mfa", component: MfaPage });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppLayout });
const dashboardRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: DashboardPage });
const paymentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/payments",
  component: () => (
    <RequirePermission permission="payments.read">
      <PaymentsPage />
    </RequirePermission>
  ),
});
const later = (path: string, title: string) =>
  createRoute({ getParentRoute: () => appRoute, path, component: () => <NotBuiltPage title={title} /> });

const routeTree = rootRoute.addChildren([
  loginRoute,
  mfaRoute,
  appRoute.addChildren([
    dashboardRoute,
    paymentsRoute,
    later("/members", "Manajemen User"),
    later("/content", "Manajemen Konten"),
    later("/events", "Event dan Tiket"),
    later("/settings", "Metode dan Biaya"),
    later("/admins", "Manajemen Admin"),
    later("/audit", "Audit"),
  ]),
]);

export function createAppRouter() {
  return createRouter({ routeTree });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
