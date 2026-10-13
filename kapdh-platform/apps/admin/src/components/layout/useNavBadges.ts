import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";

/** Interval polling lencana menu laporan dan job gagal (sama dengan pill pembayaran). */
export const NAV_BADGES_POLL_MS = 60_000;

/**
 * Lencana menu "Moderasi" (laporan open/in_review) dan "Notifikasi" (job gagal yang dapat ditindak) dari GET
 * /admin/dashboard/badges (kontrak admin-dashboard, F-15). Field hanya ada bila izinnya dimiliki (AC F15-1) dan
 * hitungannya sama dengan antrean masing-masing. Polling memakai X-Background-Request hanya pada refetch berkala
 * sehingga tidak memperpanjang idle timeout (AC F02-5). Kunci query di bawah "admin-dashboard" agar ikut dimuat ulang
 * setelah keputusan moderasi atau kirim ulang.
 */
export function useNavBadges() {
  const auth = useAuth();
  const enabled = auth.can("moderation.read") || auth.can("notifications.manage");
  return useApiQuery({
    queryKey: ["admin-dashboard", "badges"],
    enabled,
    pollMs: NAV_BADGES_POLL_MS,
    staleTime: 30_000,
    request: ({ signal, headers }) => api.GET("/admin/dashboard/badges", { signal, headers }),
  });
}
