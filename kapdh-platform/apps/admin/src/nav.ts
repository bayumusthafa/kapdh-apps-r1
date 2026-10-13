import type { Permission } from "@kapdh/contracts";
import {
  Bell,
  CalendarDays,
  CreditCard,
  Flag,
  LayoutDashboard,
  type LucideIcon,
  Newspaper,
  ScrollText,
  Settings,
  UserCog,
  Users,
} from "lucide-react";
import { type GuardedPath, ROUTE_ACCESS } from "./auth/access";
import type { Access } from "./auth/session";

/**
 * Menu samping web admin. Urutan dan nama grup mengikuti guidelines hlm. 12 (Dashboard, Manajemen Konten,
 * Manajemen Event & Tiket, Manajemen Admin, Manajemen Users, Verifikasi Pembayaran) ditambah menu F-15 yang
 * diwajibkan PRD 3.15 (moderasi, audit, notifikasi, pengaturan). Izin setiap tautan diambil dari ROUTE_ACCESS
 * sehingga menu dan penjaga rute tidak pernah berbeda. Menu tersembunyi bukan pengganti cek izin API (PRD 2.3).
 */
type StaticGuardedPath = Exclude<GuardedPath, `${string}$${string}`>;

export interface NavLinkItem {
  to: StaticGuardedPath;
  label: string;
}

export type NavBadge = "pending_payments" | "reports_open" | "failed_jobs";

/** Teks pembaca layar di belakang angka lencana (status tidak hanya lewat warna/angka, N-11). */
export const NAV_BADGE_LABEL: Record<NavBadge, string> = {
  pending_payments: "pembayaran menunggu",
  reports_open: "laporan terbuka",
  failed_jobs: "job gagal",
};

export interface NavSection {
  id: string;
  label: string;
  icon: LucideIcon;
  links: NavLinkItem[];
  /**
   * Penanda angka emas: pembayaran menunggu (prototipe screen_8), laporan moderasi terbuka dan job gagal yang dapat
   * ditindak (GET /admin/dashboard/badges, F-15).
   */
  badge?: NavBadge;
}

export const NAV_SECTIONS: NavSection[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, links: [{ to: "/", label: "Dashboard" }] },
  {
    id: "content",
    label: "Manajemen Konten",
    icon: Newspaper,
    links: [{ to: "/content", label: "Berita, Banner & Halaman" }],
  },
  {
    id: "events",
    label: "Manajemen Event & Tiket",
    icon: CalendarDays,
    links: [
      { to: "/events", label: "Daftar Event" },
      { to: "/events/checkin", label: "Check-in Tiket" },
    ],
  },
  {
    id: "admins",
    label: "Manajemen Admin",
    icon: UserCog,
    links: [{ to: "/admins", label: "Daftar Admin" }],
  },
  {
    id: "members",
    label: "Manajemen Users",
    icon: Users,
    links: [
      { to: "/members", label: "Data Alumni" },
      { to: "/members/masters", label: "Skill & Profesi" },
    ],
  },
  {
    id: "payments",
    label: "Verifikasi Pembayaran",
    icon: CreditCard,
    badge: "pending_payments",
    links: [{ to: "/payments", label: "Verifikasi Pembayaran" }],
  },
  {
    id: "moderation",
    label: "Moderasi",
    icon: Flag,
    badge: "reports_open",
    links: [{ to: "/moderation", label: "Laporan Moderasi" }],
  },
  { id: "audit", label: "Audit", icon: ScrollText, links: [{ to: "/audit", label: "Audit" }] },
  {
    id: "notifications",
    label: "Notifikasi",
    icon: Bell,
    badge: "failed_jobs",
    links: [{ to: "/notifications", label: "Pengiriman" }],
  },
  {
    id: "settings",
    label: "Pengaturan",
    icon: Settings,
    links: [{ to: "/settings", label: "Pengaturan Aplikasi" }],
  },
];

/** Tautan akun sendiri (kartu pengguna di bawah menu). */
export const ACCOUNT_LINK: NavLinkItem = { to: "/account", label: "Akun saya" };

export function allows(access: Access, permissions: readonly Permission[]): boolean {
  return access === "any" || access.some((p) => permissions.includes(p));
}

export interface VisibleSection extends NavSection {
  /** Tautan yang boleh dibuka admin ini (minimal satu). */
  links: NavLinkItem[];
  /** Tujuan tautan grup: tautan pertama yang diizinkan. */
  to: StaticGuardedPath;
}

/** Grup menu yang terlihat untuk izin efektif admin (AC F15-1). */
export function visibleNav(permissions: readonly Permission[]): VisibleSection[] {
  const out: VisibleSection[] = [];
  for (const section of NAV_SECTIONS) {
    const links = section.links.filter((l) => allows(ROUTE_ACCESS[l.to], permissions));
    if (links.length > 0) out.push({ ...section, links, to: links[0]!.to });
  }
  return out;
}

/** Semua izin yang membuka setidaknya satu tautan menu. */
export function navPermissions(): Set<Permission> {
  const set = new Set<Permission>();
  for (const s of NAV_SECTIONS)
    for (const l of s.links) {
      const access = ROUTE_ACCESS[l.to];
      if (access !== "any") access.forEach((p) => set.add(p));
    }
  return set;
}
