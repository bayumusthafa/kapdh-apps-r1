import { Link, Navigate, Outlet } from "@tanstack/react-router";
import { useCallback } from "react";
import { useAuth } from "../auth/session";
import { useIdleTimeout } from "../auth/useIdleTimeout";
import { Button } from "../components/ui";
import { visibleNav } from "../nav";
import { RestoringScreen } from "./LoginPage";

export function AppLayout() {
  const auth = useAuth();
  const authed = auth.state.status === "authenticated";
  const idleSeconds = auth.state.status === "authenticated" ? auth.state.idleTimeoutSeconds : 1800;
  const onTimeout = useCallback(() => void auth.logout("idle"), [auth]);
  const idle = useIdleTimeout({
    timeoutMs: idleSeconds * 1000,
    warnBeforeMs: 2 * 60 * 1000,
    onTimeout,
    enabled: authed,
  });

  if (auth.state.status === "restoring") return <RestoringScreen />;
  if (auth.state.status !== "authenticated") return <Navigate to="/login" />;
  const { profile } = auth.state;

  return (
    <div className="flex min-h-screen flex-wrap">
      <nav
        aria-label="Menu admin"
        className="flex w-full flex-col gap-5 bg-surface-dark p-4 text-text-on-dark md:w-64"
      >
        <div className="px-2">
          <div className="font-heading text-lg font-bold text-accent">KAPDH</div>
          <div className="text-xs text-green-100">Web Manajemen Data Alumni</div>
        </div>
        <ul className="flex flex-col gap-1 text-sm">
          {visibleNav(profile.permissions).map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                className="flex min-h-11 items-center rounded-md px-3 text-green-100 hover:bg-green-800"
                activeProps={{ className: "bg-green-700 font-semibold text-white" }}
                activeOptions={{ exact: item.to === "/" }}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-auto flex flex-col gap-2 px-2 text-xs text-green-100">
          <span>
            {profile.display_name} ({profile.role === "super_admin" ? "Super Admin" : "Admin"})
          </span>
          <button
            type="button"
            onClick={() => void auth.logout("manual")}
            className="min-h-11 self-start font-semibold text-accent underline"
          >
            Keluar
          </button>
        </div>
      </nav>
      <main className="min-w-0 flex-[999_1_560px] p-6">
        <Outlet />
      </main>
      {idle.warning ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="idle-title"
          className="fixed inset-0 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="flex max-w-sm flex-col gap-4 rounded-xl bg-surface p-6 shadow-raised">
            <h2 id="idle-title" className="font-heading text-h3 font-semibold">
              Sesi akan berakhir
            </h2>
            <p className="text-sm">
              Tidak ada aktivitas. Anda akan keluar dalam {Math.ceil(idle.remainingMs / 1000)} detik.
            </p>
            <Button onClick={idle.stayActive}>Tetap masuk</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RequirePermission({
  permission,
  children,
}: {
  permission: Parameters<ReturnType<typeof useAuth>["can"]>[0];
  children: React.ReactNode;
}) {
  const auth = useAuth();
  if (!auth.can(permission)) {
    return (
      <section className="flex flex-col gap-2">
        <h1 className="font-heading text-h1 font-semibold">Akses ditolak</h1>
        <p className="text-sm text-text-muted">
          Akun Anda tidak memiliki izin untuk halaman ini. Hubungi Super Admin bila perlu.
        </p>
      </section>
    );
  }
  return <>{children}</>;
}
