import { screen } from "@testing-library/react";
import { paymentRequests } from "../../api/mocks";
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
  // Potongan kode halaman dimuat lazy; impor pertama di worker uji dapat lebih lama dari batas bawaan 1 detik
  // saat suite berjalan paralel.
  await screen.findByRole(
    "heading",
    { level: 1, name: opts.title ?? "Verifikasi Pembayaran" },
    { timeout: 10_000 },
  );
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
