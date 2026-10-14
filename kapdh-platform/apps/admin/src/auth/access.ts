import type { Permission } from "@kapdh/contracts";
import type { Access } from "./session";

/**
 * Izin minimum untuk membuka setiap rute web admin (ARCHITECTURE §7, PRD 2.3, AC F15-1). Sumber tunggal untuk
 * penjaga rute (`beforeLoad`), menu samping (nav.ts) dan uji. Salah satu izin dalam daftar cukup untuk membuka
 * halaman; tombol di dalam halaman memeriksa izin tindakan masing-masing (mis. payments.decide), dan API tetap
 * memeriksa setiap permintaan.
 */
export const ROUTE_ACCESS = {
  "/": "any",
  "/account": "any",
  "/payments": ["payments.read", "settings.manage"],
  "/members": ["members.read", "members.manage"],
  "/members/$userId": ["members.read", "members.manage"],
  "/members/masters": ["master.manage"],
  "/content": ["content.manage"],
  "/content/posts/new": ["content.manage"],
  "/content/posts/$postId": ["content.manage"],
  "/events": ["events.manage"],
  "/events/new": ["events.manage"],
  "/events/$eventId": ["events.manage"],
  "/events/checkin": ["events.checkin"],
  "/moderation": ["moderation.read", "moderation.resolve"],
  "/moderation/$reportId": ["moderation.read", "moderation.resolve"],
  "/admins": ["admins.manage"],
  "/admins/$adminId": ["admins.manage"],
  "/audit": ["audit.read", "audit.export"],
  "/notifications": ["notifications.manage"],
  "/settings": ["settings.manage"],
} as const satisfies Record<string, Access>;

export type GuardedPath = keyof typeof ROUTE_ACCESS;

export function accessFor(path: GuardedPath): Access {
  return ROUTE_ACCESS[path];
}

/**
 * Izin yang tidak membuka halaman sendiri; dipakai untuk tombol tindakan di halaman lain. Dicatat agar setiap
 * izin pada enum Permission memiliki permukaan UI yang jelas (diuji di nav.test.ts).
 */
export const IN_PAGE_PERMISSIONS: Partial<Record<Permission, string>> = {
  "payments.decide":
    "Tombol Setujui/Tolak dan Catat iuran (D13) pada /payments (antrean memerlukan payments.read).",
};
