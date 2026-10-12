import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { App, AppProviders } from "../App";
import { MOCK_CREDENTIALS } from "../api/mocks";
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
