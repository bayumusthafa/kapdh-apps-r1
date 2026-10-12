import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { App, AppProviders } from "../App";
import { api, setAccessToken } from "../api/client";
import { MOCK_CREDENTIALS } from "../api/mocks";
import type { ToastTone } from "../components/ui/Toast";
import { createAppRouter } from "../router";

/** Utilitas uji web admin (mode mock). Bukti mock bukan bukti AC (PRD 7.3). */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

/** Render seluruh aplikasi (router + penyedia) mulai dari `path`. */
export function renderApp(path = "/login", queryClient = testQueryClient()) {
  const router = createAppRouter({ initialPath: path });
  const utils = render(<App router={router} queryClient={queryClient} />);
  return { ...utils, router, queryClient };
}

/** Render komponen dengan penyedia global (Query, Toast, Auth, Reauth) tanpa router. */
export function renderWithProviders(ui: ReactNode, queryClient = testQueryClient()) {
  return { ...render(<AppProviders queryClient={queryClient}>{ui}</AppProviders>), queryClient };
}

export type User = ReturnType<typeof userEvent.setup>;

/** Masuk lewat UI: email + kata sandi lalu TOTP atau backup code. */
export async function signIn(
  user: User,
  opts: { email?: string; code?: string; backup?: boolean } = {},
): Promise<HTMLElement> {
  await user.type(await screen.findByLabelText(/^Email/), opts.email ?? MOCK_CREDENTIALS.email);
  await user.type(screen.getByLabelText(/^Kata sandi/), MOCK_CREDENTIALS.password);
  await user.click(screen.getByRole("button", { name: "Masuk" }));
  if (opts.backup) {
    await user.click(await screen.findByRole("button", { name: /Pakai backup code/ }));
    await user.type(await screen.findByLabelText(/^Backup code/), opts.code ?? MOCK_CREDENTIALS.backupCode);
  } else {
    await user.type(await screen.findByLabelText(/^Kode autentikator/), opts.code ?? MOCK_CREDENTIALS.totp);
  }
  await user.click(screen.getByRole("button", { name: "Verifikasi" }));
  return screen.findByRole("navigation", { name: "Menu admin" });
}

/**
 * Toast yang sedang tampil (opsional per nada). Toast tidak memakai role per item: galat masuk wadah
 * aria-live="assertive", selain itu wadah aria-live="polite" yang selalu terpasang (lihat Toast.tsx).
 */
export function toasts(tone?: ToastTone): HTMLElement[] {
  const selector = tone ? `[data-toast="${tone}"]` : "[data-toast]";
  return Array.from(document.querySelectorAll<HTMLElement>(selector));
}

/** Tunggu toast bernada `tone` yang memuat `text`. */
export function findToast(tone: ToastTone, text: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const match = toasts(tone).find((el) =>
      typeof text === "string" ? el.textContent?.includes(text) : text.test(el.textContent ?? ""),
    );
    if (!match) throw new Error(`Toast ${tone} "${String(text)}" tidak ditemukan`);
    return match;
  });
}

/** Masuk lewat API (tanpa UI) sehingga AuthProvider memulihkan sesi dari "cookie" refresh tiruan saat dirender. */
export async function signInViaApi(): Promise<void> {
  const login = await api.POST("/admin/auth/login", {
    body: { email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password },
  });
  const mfa = await api.POST("/admin/auth/mfa", {
    body: { mfa_token: login.data!.mfa_token, totp_code: MOCK_CREDENTIALS.totp },
  });
  setAccessToken(mfa.data!.access_token, mfa.data!.access_expires_at);
}
