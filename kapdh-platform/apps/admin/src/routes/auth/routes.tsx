import { createRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { safeRedirectPath } from "../../auth/guards";
import { rootRoute } from "../__root";
import { LoginPage } from "./LoginPage";
import { MfaPage } from "./MfaPage";

/** Parameter ?redirect= (path internal saja) untuk kembali ke halaman semula setelah masuk. */
export interface LoginSearch {
  redirect?: string;
}

function validateLoginSearch(search: Record<string, unknown>): LoginSearch {
  // Selalu tetapkan kunci redirect (undefined bila tidak aman) agar nilai mentah dari URL tidak ikut tergabung.
  return { redirect: safeRedirectPath(search.redirect) };
}

/** Rute masuk (F-02). Halaman masuk dan MFA dimuat langsung; layar yang jarang dipakai dipisah (lazy). */
export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: validateLoginSearch,
  beforeLoad: ({ context, search }) => {
    if (context.auth.snapshot().state.status === "authenticated")
      throw redirect({ href: safeRedirectPath(search.redirect) ?? "/" });
  },
  component: LoginPage,
});

export const mfaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login/mfa",
  validateSearch: validateLoginSearch,
  beforeLoad: ({ context, search }) => {
    const { state } = context.auth.snapshot();
    if (state.status === "authenticated") throw redirect({ href: safeRedirectPath(search.redirect) ?? "/" });
    if (state.status !== "mfa") throw redirect({ to: "/login", search });
    if (state.enrollmentRequired) throw redirect({ to: "/login/enroll", search });
  },
  component: MfaPage,
});

export const enrollRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login/enroll",
  validateSearch: validateLoginSearch,
  beforeLoad: ({ context, search }) => {
    const { state } = context.auth.snapshot();
    if (state.status === "authenticated") throw redirect({ href: safeRedirectPath(search.redirect) ?? "/" });
    if (state.status !== "mfa") throw redirect({ to: "/login", search });
  },
  component: lazyRouteComponent(() => import("./PendingAuthPages"), "EnrollPage"),
});

export const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: lazyRouteComponent(() => import("./PendingAuthPages"), "InvitePage"),
});

export const authRoutes = [loginRoute, mfaRoute, enrollRoute, inviteRoute] as const;
