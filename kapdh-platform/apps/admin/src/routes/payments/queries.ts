import { type QueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";

/**
 * Kunci query area pembayaran. Semua kunci antrean dan ringkasan berawalan "admin-payments" sehingga satu
 * invalidasi memperbarui antrean, ringkasan (pill emas menu, hitungan tab) sekaligus.
 */
export const PAYMENTS_KEY = ["admin-payments"] as const;
export const SUMMARY_KEY = ["admin-payments", "summary"] as const;
export const ADJUSTMENTS_KEY = ["admin-adjustments"] as const;
export const METHODS_KEY = ["admin-payment-methods"] as const;
export const FEES_KEY = ["admin-settings", "fees"] as const;

export function paymentDetailKey(paymentId: string) {
  return ["admin-payment", paymentId] as const;
}

export function adjustmentDetailKey(adjustmentId: string) {
  return ["admin-adjustment", adjustmentId] as const;
}

/** Ringkasan antrean (pill menu dan hitungan tab) diperbarui berkala tanpa memperpanjang idle (AC F02-5). */
export const SUMMARY_POLL_MS = 60_000;

/**
 * Ringkasan GET /admin/payments/summary: menunggu verifikasi dan penyesuaian pending. Kunci sama dengan pill
 * menu (usePendingPaymentsCount) sehingga cache dipakai bersama. Hanya untuk pemegang payments.read (AC F15-1).
 */
export function usePaymentSummary() {
  const auth = useAuth();
  return useApiQuery({
    queryKey: SUMMARY_KEY,
    enabled: auth.can("payments.read"),
    pollMs: SUMMARY_POLL_MS,
    staleTime: 30_000,
    request: ({ signal, headers }) => api.GET("/admin/payments/summary", { signal, headers }),
  });
}

/** Setelah perubahan penyesuaian: daftar, detail payment asal dan ringkasan dimuat ulang. */
export function invalidateAdjustments(queryClient: QueryClient, paymentId?: string): void {
  void queryClient.invalidateQueries({ queryKey: ADJUSTMENTS_KEY });
  void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY });
  if (paymentId) void queryClient.invalidateQueries({ queryKey: paymentDetailKey(paymentId) });
}
