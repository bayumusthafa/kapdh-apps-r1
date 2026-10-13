import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "../../core/db/types.js";
import { formatDateWib } from "../../core/membership/format.js";
import type { NotificationService } from "../../core/notifications-kernel/notification.service.js";

/** Kejadian keamanan akun alumni yang wajib diberitahukan (kategori `security`, tidak dapat dimatikan; §4.7). */
export type SecurityEvent = "password_changed" | "password_reset" | "logout_all";

const TIME_WIB = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Contoh: `13 Oktober 2026 pukul 09.00 WIB` (PRD 2.1: pengguna melihat waktu Asia/Jakarta). */
export function formatDateTimeWib(instant: Date): string {
  return `${formatDateWib(instant)} pukul ${TIME_WIB.format(instant)} WIB`;
}

const NOTICES: Readonly<Record<SecurityEvent, { title: string; body: (at: string) => string }>> = {
  password_changed: {
    title: "Sandi akun diganti",
    body: (at) =>
      `Sandi akun KAPDH Anda diganti pada ${at} dan perangkat lain telah dikeluarkan. Bila bukan Anda, ` +
      "segera pulihkan akun lewat Lupa Sandi dan hubungi pengurus.",
  },
  password_reset: {
    title: "Sandi akun dipulihkan",
    body: (at) =>
      `Sandi akun KAPDH Anda diatur ulang dengan kode pemulihan pada ${at} dan semua perangkat telah ` +
      "dikeluarkan. Bila bukan Anda, segera hubungi pengurus.",
  },
  logout_all: {
    title: "Keluar dari semua perangkat",
    body: (at) =>
      `Semua sesi akun KAPDH Anda diakhiri pada ${at}. Bila bukan Anda, segera ganti sandi lewat Lupa Sandi.`,
  },
};

/**
 * Notifikasi keamanan (AC F02-4, F02-6; ARCHITECTURE §4.7) di dalam transaksi perubahan: baris inbox + outbox
 * `notification.created` (email/push oleh worker; kategori security wajib). Isi tidak memuat sandi, kode, token, IP,
 * atau perangkat (N-14). Setiap kejadian unik (dedup per kejadian, bukan per pengguna).
 */
export async function notifySecurityEvent(
  notifications: NotificationService,
  tx: DbOrTx,
  userId: string,
  event: SecurityEvent,
  at: Date,
): Promise<void> {
  const notice = NOTICES[event];
  await notifications.notify(tx, {
    userId,
    category: "security",
    title: notice.title,
    body: notice.body(formatDateTimeWib(at)),
    route: "/account/sessions",
    data: { event },
    dedupKey: `security.${event}:${uuidv7()}`,
  });
}
