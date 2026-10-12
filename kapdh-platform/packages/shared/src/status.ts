import type { EffectiveStatus } from "@kapdh/contracts";

/** Label status yang selalu ditampilkan bersama warna (PRD 4.5: status tidak dibedakan dengan warna saja). */
export const MEMBERSHIP_LABEL: Record<EffectiveStatus, string> = {
  pending_otp: "Menunggu Verifikasi Email",
  unverified: "KTA Tidak Aktif",
  verified: "KTA Aktif",
  expiring: "Segera Berakhir",
  expired: "KTA Tidak Aktif",
  suspended: "Dibatasi",
  disabled: "Nonaktif",
  deletion_pending: "Penghapusan Diproses",
};

/** Rute awal klien anggota berdasarkan effective_status (PRD 2.2). Server tetap menegakkan izin. */
export type MemberRoute =
  "verify_otp" | "onboarding_payment" | "home" | "renewal" | "restricted" | "deletion_status";

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
