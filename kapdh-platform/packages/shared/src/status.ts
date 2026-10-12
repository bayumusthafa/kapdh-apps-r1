// Label status dan rute awal klien anggota per effective_status (PRD 2.2). Status route Dart (kapdh_api
// status_routes.dart) dibangkitkan dari berkas ini oleh packages/contracts/scripts/gen-dart.mjs, sehingga berkas ini
// hanya boleh mengimpor TIPE dari @kapdh/contracts (tanpa impor runtime).
import type { EffectiveStatus } from "@kapdh/contracts";

/**
 * Label status yang selalu ditampilkan bersama warna/ikon (PRD 4.5: status tidak dibedakan dengan warna saja).
 * PRD 2.2 membedakan kartu unverified ("KTA berlabel Tidak Aktif") dari expired ("kartu dengan label
 * kedaluwarsa"); AC F06-2 menampilkan "Kedaluwarsa" untuk anggota expired. Selaras dengan label token desain
 * (packages/design-tokens tokens.json membership).
 */
export const MEMBERSHIP_LABEL: Record<EffectiveStatus, string> = {
  pending_otp: "Menunggu Verifikasi Email",
  unverified: "KTA Tidak Aktif",
  verified: "KTA Aktif",
  expiring: "Segera Berakhir",
  expired: "KTA Kedaluwarsa",
  suspended: "Dibatasi",
  disabled: "Nonaktif",
  deletion_pending: "Penghapusan Diproses",
};

/** Label untuk effective_status yang belum dikenal versi klien ini (kontrak lebih baru, N-13). */
export const MEMBERSHIP_LABEL_UNKNOWN = "Status Tidak Dikenal";

/** Rute awal klien anggota. Server tetap menegakkan izin di setiap endpoint (PRD 2.2). */
export const MEMBER_ROUTES = [
  "verify_otp",
  "onboarding_payment",
  "home",
  "renewal",
  "restricted",
  "deletion_status",
] as const;
export type MemberRoute = (typeof MEMBER_ROUTES)[number];

/** Path go_router aplikasi Flutter untuk setiap rute awal (ARCHITECTURE §8.4). */
export const MEMBER_ROUTE_PATH: Record<MemberRoute, string> = {
  verify_otp: "/register/otp",
  onboarding_payment: "/onboarding/fees",
  home: "/home",
  renewal: "/renewal",
  restricted: "/restricted",
  deletion_status: "/deletion-status",
};

/** Rute awal berdasarkan effective_status (PRD 2.2). Switch exhaustive: status baru wajib dipetakan. */
export function routeForStatus(status: EffectiveStatus): MemberRoute {
  switch (status) {
    case "pending_otp":
      return "verify_otp";
    case "unverified":
      return "onboarding_payment";
    case "verified":
    case "expiring":
      return "home";
    case "expired":
      return "renewal";
    case "suspended":
      return "restricted";
    case "disabled":
    case "deletion_pending":
      return "deletion_status";
  }
}

/** Label untuk status dari server, termasuk status yang belum dikenal versi klien ini. */
export function membershipLabelFor(status: string): string {
  return Object.hasOwn(MEMBERSHIP_LABEL, status)
    ? MEMBERSHIP_LABEL[status as EffectiveStatus]
    : MEMBERSHIP_LABEL_UNKNOWN;
}
