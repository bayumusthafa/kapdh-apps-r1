import { screen, within } from "@testing-library/react";
import { expect } from "vitest";
import { MOCK_CREDENTIALS } from "../api/mocks";
import { renderApp, signIn, type User } from "./utils";

/**
 * Utilitas uji halaman governance (dashboard, admin, audit, moderasi, notifikasi, pengaturan, akun). Mode mock;
 * bukti mock bukan bukti AC (PRD 7.3).
 */

/**
 * Isi dialog reautentikasi (sandi + TOTP) lalu konfirmasi. Sejak keputusan PO 2026-10-15 (ADR-025) dialog ini hanya
 * muncul untuk tindakan kredensial: buat ulang backup code, kirim ulang undangan/koreksi email login/pemulihan admin,
 * reset sandi anggota.
 */
export async function confirmReauth(user: User, opts: { password?: string; code?: string } = {}) {
  const dialog = await screen.findByRole("dialog", { name: /Konfirmasi identitas/ });
  await user.type(within(dialog).getByLabelText(/^Sandi/), opts.password ?? MOCK_CREDENTIALS.password);
  await user.type(within(dialog).getByLabelText(/^Kode autentikator/), opts.code ?? MOCK_CREDENTIALS.totp);
  await user.click(within(dialog).getByRole("button", { name: "Konfirmasi" }));
}

/** Tidak ada dialog reautentikasi yang terbuka (perubahan non-kredensial, ADR-025). */
export function expectNoReauthDialog(): void {
  expect(screen.queryByRole("dialog", { name: /Konfirmasi identitas/ })).toBeNull();
}

/** Buka `path` dan masuk sebagai admin tiruan; tunggu judul h1 halaman. */
export async function openPage(user: User, path: string, title: string | RegExp) {
  const app = renderApp(path);
  await signIn(user);
  // Potongan kode area dimuat lazy; pemuatan pertama di suite paralel bisa lebih dari 1 detik.
  await screen.findByRole("heading", { level: 1, name: title }, { timeout: 5_000 });
  return app;
}

/** Bagian halaman (Card berlabel judul h2) untuk query di dalamnya. */
export async function section(name: string | RegExp): Promise<HTMLElement> {
  return screen.findByRole("region", { name });
}
