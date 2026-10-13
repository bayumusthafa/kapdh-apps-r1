import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";

/** Interval polling jumlah pembayaran menunggu untuk penanda emas di menu (prototipe screen_8). */
export const PENDING_POLL_MS = 60_000;

/**
 * Jumlah pembayaran yang siap diputus (`awaiting_review_count` dari GET /admin/payments/summary): sumber tunggal
 * pill emas menu dan sama dengan total pilihan "Menunggu" di antrean (kontrak C3/C7; instruksi tanpa bukti tidak
 * dihitung). Polling memakai X-Background-Request hanya pada refetch berkala sehingga tidak memperpanjang idle
 * server (AC F02-5). Hanya berjalan bila admin memiliki payments.read (AC F15-1).
 */
export function usePendingPaymentsCount() {
  const auth = useAuth();
  const enabled = auth.can("payments.read");
  return useApiQuery({
    queryKey: ["admin-payments", "summary"],
    enabled,
    pollMs: PENDING_POLL_MS,
    staleTime: 30_000,
    request: ({ signal, headers }) => api.GET("/admin/payments/summary", { signal, headers }),
    select: (summary) => summary.awaiting_review_count,
  });
}
