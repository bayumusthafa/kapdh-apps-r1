import {
  createRootRouteWithContext,
  createRoute,
  type ErrorComponentProps,
  Link,
  Outlet,
  useRouter,
} from "@tanstack/react-router";
import { type RouterContext, isForbiddenRouteError, requireAccess, requireSession } from "../auth/guards";
import { type GuardedPath, ROUTE_ACCESS } from "../auth/access";
import { useAuth } from "../auth/session";
import { AppShell } from "../components/layout/AppShell";
import { buttonClass } from "../components/ui/Button";
import { useDocumentTitle } from "../components/ui/PageHeader";
import { ErrorState, ForbiddenState, NotFoundState } from "../components/ui/States";

/**
 * Akar pohon rute web admin (TanStack Router berbasis kode, ARCHITECTURE §7).
 * - `rootRoute`: konteks router berisi sesi admin; halaman 404 untuk URL yang tidak dikenal.
 * - `appRoute`: layout terautentikasi (AppShell). `beforeLoad` mengarahkan ke /login?redirect=<path> bila belum
 *   masuk. Rute area mendaftarkan diri sebagai anak `appRoute` di src/routes/<area>/routes.tsx dan memakai
 *   `guard(path)` untuk penjaga izin dari ROUTE_ACCESS.
 */
export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: requireSession,
  component: AppShell,
  errorComponent: RouteErrorPage,
  notFoundComponent: NotFoundPage,
});

/** `beforeLoad` izin untuk path terdaftar di ROUTE_ACCESS (AC F15-1). */
export function guard(path: GuardedPath) {
  return requireAccess(ROUTE_ACCESS[path]);
}

/** Galat rute: izin ditolak (dari beforeLoad) atau galat lain dengan tombol coba lagi. */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  useDocumentTitle(isForbiddenRouteError(error) ? "Akses ditolak" : "Terjadi kesalahan");
  if (isForbiddenRouteError(error))
    return (
      <section className="rounded-lg border border-divider bg-surface">
        <h1 className="sr-only">Akses ditolak</h1>
        <ForbiddenState />
      </section>
    );
  return (
    <section className="rounded-lg border border-divider bg-surface">
      <h1 className="sr-only">Terjadi kesalahan</h1>
      <ErrorState
        error={error}
        title="Halaman gagal dimuat"
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </section>
  );
}

export function NotFoundPage() {
  const auth = useAuth();
  useDocumentTitle("Halaman tidak ditemukan");
  const authed = auth.state.status === "authenticated";
  return (
    <section className="mx-auto flex w-full max-w-xl flex-col rounded-lg border border-divider bg-surface p-2 my-6">
      <h1 className="sr-only">Halaman tidak ditemukan</h1>
      <NotFoundState
        description="Alamat yang Anda buka tidak tersedia di web admin."
        action={
          <Link to={authed ? "/" : "/login"} className={buttonClass({ variant: "outline", size: "sm" })}>
            {authed ? "Kembali ke Dashboard" : "Ke halaman masuk"}
          </Link>
        }
      />
    </section>
  );
}
