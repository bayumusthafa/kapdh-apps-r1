import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";

/** Interval polling jumlah pembayaran menunggu untuk penanda emas di menu (prototipe screen_8). */
export const PENDING_POLL_MS = 60_000;

/**
 * Jumlah pembayaran berstatus pending (total dari GET /admin/payments?status=pending&limit=1). Polling memakai
 * X-Background-Request hanya pada refetch berkala sehingga tidak memperpanjang idle server (AC F02-5).
 * Hanya berjalan bila admin memiliki payments.read (AC F15-1).
 */
export function usePendingPaymentsCount() {
  const auth = useAuth();
  const enabled = auth.can("payments.read");
  return useApiQuery({
    queryKey: ["admin-payments", "pending-count"],
    enabled,
    pollMs: PENDING_POLL_MS,
    staleTime: 30_000,
    request: ({ signal, headers }) =>
      api.GET("/admin/payments", { params: { query: { status: "pending", limit: 1 } }, signal, headers }),
    select: (page) => page.total,
  });
}
