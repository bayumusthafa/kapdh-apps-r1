import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { MOCK_CREDENTIALS, paymentRequests } from "../../api/mocks";
import { renderApp, signIn, type User } from "../../test/utils";
import type { PaymentTab } from "./routes";

/**
 * Utilitas uji area pembayaran (mode mock). Bukti mock bukan bukti AC (PRD 7.3); uji membuktikan perilaku UI
 * terhadap kontrak final C3.
 */
export async function openPayments(
  user: User,
  opts: { tab?: PaymentTab; title?: string; search?: string } = {},
): Promise<void> {
  const params = new URLSearchParams(opts.search ?? "");
  if (opts.tab) params.set("tab", opts.tab);
  const query = params.toString();
  renderApp(query ? `/payments?${query}` : "/payments");
  await signIn(user);
  await screen.findByRole("heading", { level: 1, name: opts.title ?? "Verifikasi Pembayaran" });
}

/** Isi dialog reautentikasi (sandi + TOTP) yang dibuka tindakan sensitif (AC F15-3). */
export async function confirmReauth(user: User, reason?: RegExp): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: "Konfirmasi identitas" });
  if (reason) expect(dialog).toHaveAccessibleDescription(reason);
  await user.type(within(dialog).getByLabelText(/^Sandi/), MOCK_CREDENTIALS.password);
  await user.type(within(dialog).getByLabelText(/^Kode autentikator/), MOCK_CREDENTIALS.totp);
  await user.click(within(dialog).getByRole("button", { name: "Konfirmasi" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Konfirmasi identitas" })).toBeNull());
}

/** Permintaan ke server tiruan pembayaran dengan metode dan path tertentu. */
export function requestsTo(method: string, path: string | RegExp) {
  return paymentRequests.filter(
    (r) => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path)),
  );
}

/** Data contoh server tiruan (src/api/mocks/payments.ts). */
export const IDS = {
  siti: "0199e000-0000-7000-8000-0000000000a1",
  ahmad: "0199e000-0000-7000-8000-0000000000a2",
  rizky: "0199e000-0000-7000-8000-0000000000a4",
  deleted: "0199e000-0000-7000-8000-0000000000a6",
  hasan: "0199e000-0000-7000-8000-0000000000a7",
  dewi: "0199e000-0000-7000-8000-0000000000a8",
  fajar: "0199e000-0000-7000-8000-0000000001a1",
  laila: "0199e000-0000-7000-8000-0000000001a2",
  yusuf: "0199e000-0000-7000-8000-0000000001a3",
  gita: "0199e000-0000-7000-8000-0000000001a4",
  lailaRefund: "0199e000-0000-7000-8000-000000000501",
  fajarRefund: "0199e000-0000-7000-8000-000000000502",
  yusufCorrection: "0199e000-0000-7000-8000-000000000503",
  gitaRefundDone: "0199e000-0000-7000-8000-000000000504",
  methodInUse: "0199e000-0000-7000-8000-000000000001",
  methodEwallet: "0199e000-0000-7000-8000-000000000002",
  methodInactive: "0199e000-0000-7000-8000-000000000003",
} as const;
