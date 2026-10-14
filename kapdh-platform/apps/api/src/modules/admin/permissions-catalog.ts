import type { components, Permission } from "@kapdh/contracts";
import { PERMISSION_VALUES } from "@kapdh/contracts";

type AdminPermissionInfo = components["schemas"]["AdminPermissionInfo"];
type AdminRoleInfo = components["schemas"]["AdminRoleInfo"];
export type AdminPermissionCatalog = components["schemas"]["AdminPermissionCatalog"];

/**
 * Katalog izin dan peran (F-16, ARCHITECTURE §4.5, kontrak adminListPermissions). Urutan dan label tetap; `requires`
 * adalah izin prasyarat yang wajib ikut ditugaskan; `admins.manage` tidak dapat ditugaskan ke peran `admin`
 * sehingga hanya melekat pada Super Admin (PRD 2.3).
 */
export const PERMISSION_CATALOG: readonly AdminPermissionInfo[] = [
  {
    permission: "payments.read",
    label: "Lihat pembayaran",
    description: "Melihat antrean, detail dan bukti pembayaran serta penyesuaian (F-04).",
    group: "payments",
    requires: [],
    assignable: true,
  },
  {
    permission: "payments.decide",
    label: "Putuskan pembayaran",
    description: "Menyetujui atau menolak bukti, membatalkan, mencatat iuran dan penyesuaian (F-04, D6).",
    group: "payments",
    requires: ["payments.read"],
    assignable: true,
  },
  {
    permission: "members.read",
    label: "Lihat anggota",
    description: "Melihat daftar, detail dan riwayat keanggotaan anggota (F-15).",
    group: "members",
    requires: [],
    assignable: true,
  },
  {
    permission: "members.manage",
    label: "Kelola anggota",
    description: "Mengubah data administratif anggota dengan audit (F-15).",
    group: "members",
    requires: ["members.read"],
    assignable: true,
  },
  {
    permission: "content.manage",
    label: "Kelola konten",
    description: "Mengelola berita, banner, halaman dan kategori (F-08).",
    group: "content",
    requires: [],
    assignable: true,
  },
  {
    permission: "master.manage",
    label: "Kelola master profesi dan keahlian",
    description: "Menambah, mengubah dan menonaktifkan master profesi dan keahlian (F-10).",
    group: "members",
    requires: [],
    assignable: true,
  },
  {
    permission: "events.manage",
    label: "Kelola event dan tiket",
    description: "Membuat, mengubah, membatalkan event serta melihat penjualan tiket (F-09).",
    group: "events",
    requires: [],
    assignable: true,
  },
  {
    permission: "events.checkin",
    label: "Check-in tiket",
    description: "Memindai dan mencatat check-in tiket di lokasi event (F-09).",
    group: "events",
    requires: [],
    assignable: true,
  },
  {
    permission: "moderation.read",
    label: "Lihat laporan",
    description: "Melihat antrean dan bukti laporan moderasi (F-12).",
    group: "moderation",
    requires: [],
    assignable: true,
  },
  {
    permission: "moderation.resolve",
    label: "Putuskan laporan",
    description: "Mengklaim dan memutus laporan moderasi beserta banding (F-12).",
    group: "moderation",
    requires: ["moderation.read"],
    assignable: true,
  },
  {
    permission: "audit.read",
    label: "Lihat audit",
    description: "Menelusuri entri audit perubahan penting (F-17).",
    group: "audit",
    requires: [],
    assignable: true,
  },
  {
    permission: "audit.export",
    label: "Ekspor audit",
    description: "Membuat dan mengunduh ekspor CSV audit (F-17).",
    group: "audit",
    requires: ["audit.read"],
    assignable: true,
  },
  {
    permission: "settings.manage",
    label: "Kelola metode bayar dan pengaturan",
    description: "Mengelola metode bayar, biaya iuran dan pengaturan aplikasi (F-15).",
    group: "settings",
    requires: [],
    assignable: true,
  },
  {
    permission: "admins.manage",
    label: "Kelola admin dan izin",
    description: "Mengundang admin, mengubah peran, izin dan status, serta memulihkan akun admin (F-16).",
    group: "admins",
    requires: [],
    assignable: false,
  },
  {
    permission: "notifications.manage",
    label: "Kelola pengiriman notifikasi",
    description: "Memantau dan mengirim ulang pengiriman notifikasi serta event outbox (F-13).",
    group: "notifications",
    requires: [],
    assignable: true,
  },
];

export const ROLE_CATALOG: readonly AdminRoleInfo[] = [
  {
    role: "super_admin",
    label: "Super Admin",
    description:
      "Memiliki semua izin, mengelola admin dan izin; perubahan sensitif wajib MFA dan reautentikasi (PRD 2.3).",
  },
  {
    role: "admin",
    label: "Admin",
    description: "Hanya memiliki izin yang ditugaskan Super Admin (PRD 2.3).",
  },
];

const ORDER = new Map<Permission, number>(PERMISSION_VALUES.map((permission, index) => [permission, index]));
const INFO = new Map<Permission, AdminPermissionInfo>(
  PERMISSION_CATALOG.map((info) => [info.permission, info]),
);

/** Izin dalam urutan katalog (kontrak AdminAccount.permissions). */
export function sortPermissions(permissions: Iterable<Permission>): Permission[] {
  return [...new Set(permissions)].sort((a, b) => (ORDER.get(a) ?? 99) - (ORDER.get(b) ?? 99));
}

/** Izin efektif: super_admin seluruh 15 izin, admin izin yang ditugaskan (ARCHITECTURE §4.5). */
export function effectivePermissions(role: string, assigned: Iterable<Permission>): Permission[] {
  return role === "super_admin" ? [...PERMISSION_VALUES] : sortPermissions(assigned);
}

/**
 * Pesan galat penugasan izin untuk peran `admin` (kontrak adminInviteAdmin): izin yang tidak dapat ditugaskan
 * (admins.manage) dan prasyarat yang tidak ikut ditugaskan. Kosong berarti sah.
 */
export function assignmentProblems(permissions: readonly Permission[]): string[] {
  const set = new Set(permissions);
  const problems: string[] = [];
  for (const permission of permissions) {
    const info = INFO.get(permission);
    if (!info) continue;
    if (!info.assignable)
      problems.push(`Izin ${permission} hanya melekat pada Super Admin dan tidak dapat ditugaskan.`);
    for (const required of info.requires)
      if (!set.has(required)) problems.push(`Izin ${permission} wajib disertai ${required}.`);
  }
  return problems;
}

export function permissionCatalog(): AdminPermissionCatalog {
  return {
    permissions: PERMISSION_CATALOG.map((info) => ({ ...info, requires: [...info.requires] })),
    roles: ROLE_CATALOG.map((role) => ({ ...role })),
  };
}
