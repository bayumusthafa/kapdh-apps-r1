import type { Permission } from "@kapdh/contracts";

export interface NavItem {
  to: string;
  label: string;
  /** Salah satu izin ini cukup untuk menampilkan menu. Menu tersembunyi bukan pengganti cek izin API (PRD 2.3). */
  anyOf: Permission[] | "any";
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", anyOf: "any" },
  { to: "/payments", label: "Verifikasi Pembayaran", anyOf: ["payments.read"] },
  { to: "/members", label: "Manajemen User", anyOf: ["members.read", "members.manage"] },
  { to: "/content", label: "Manajemen Konten", anyOf: ["content.manage"] },
  { to: "/events", label: "Event dan Tiket", anyOf: ["events.manage", "events.checkin"] },
  { to: "/settings", label: "Metode dan Biaya", anyOf: ["settings.manage"] },
  { to: "/admins", label: "Manajemen Admin", anyOf: ["admins.manage"] },
  { to: "/audit", label: "Audit", anyOf: ["audit.read"] },
];

export function visibleNav(permissions: readonly Permission[]): NavItem[] {
  return NAV_ITEMS.filter((item) => item.anyOf === "any" || item.anyOf.some((p) => permissions.includes(p)));
}
