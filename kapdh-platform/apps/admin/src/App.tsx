import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { ReauthProvider } from "./api/reauth";
import { AuthProvider, useAuth } from "./auth/session";
import { RestoringScreen } from "./components/layout/AuthLayout";
import { ToastProvider } from "./components/ui/Toast";
import type { AppRouter } from "./router";

/** QueryClient web admin: tidak refetch saat fokus jendela (hanya polling eksplisit, AC F02-5). */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          // Galat 4xx yang pasti (izin, validasi, tidak ditemukan) tidak diulang; jaringan/5xx sekali.
          const status = (error as { status?: number } | null)?.status ?? 0;
          return failureCount < 1 && (status === 0 || status >= 500);
        },
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

/** Penyedia global: Query → Toast → Auth (sesi) → Reauth (dialog konfirmasi identitas). */
export function AppProviders({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <ReauthProvider>{children}</ReauthProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

/**
 * Router dengan konteks sesi. Saat sesi dipulihkan dari cookie refresh ditampilkan layar memuat; setiap perubahan
 * sesi/izin menjalankan ulang penjaga rute (beforeLoad) sehingga logout/kedaluwarsa langsung ke /login dan
 * pencabutan izin langsung menutup halaman terkait (AC F16-3).
 */
export function AppRouterView({ router }: { router: AppRouter }) {
  const auth = useAuth();
  const status = auth.state.status;
  const permissionsKey = auth.profile ? `${auth.profile.role}:${auth.profile.permissions.join(",")}` : "";
  // Kunci sesi yang sudah dievaluasi router; null = router belum dipasang (muat pertama dijalankan RouterProvider).
  const evaluated = useRef<string | null>(null);
  const sessionKey = `${status}|${permissionsKey}`;

  useEffect(() => {
    if (status === "restoring") return;
    if (evaluated.current === null) {
      evaluated.current = sessionKey;
      return;
    }
    if (evaluated.current === sessionKey) return;
    evaluated.current = sessionKey;
    void router.invalidate();
  }, [status, sessionKey, router]);

  if (status === "restoring") return <RestoringScreen />;
  return <RouterProvider router={router} context={{ auth }} />;
}

export function App({ router, queryClient }: { router: AppRouter; queryClient: QueryClient }) {
  return (
    <AppProviders queryClient={queryClient}>
      <AppRouterView router={router} />
    </AppProviders>
  );
}
