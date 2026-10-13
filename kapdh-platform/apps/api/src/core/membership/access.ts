import { AppException } from "../errors/app-exception.js";
import type { EffectiveStatus } from "./effective-status.js";

/**
 * Tingkat akses anggota berdasarkan effective_status (PRD 2.2, ARCHITECTURE §3.1), dipakai @MemberAccess dan modul:
 * - `any`: unverified, verified, expiring, expired, suspended (/me, riwayat sendiri, pengaturan, legal, hapus akun)
 * - `nonsuspended`: unverified, verified, expiring, expired (pembayaran, kartu sendiri, ubah profil, tiket sendiri)
 * - `active`: verified, expiring (reservasi event, direktori, chat, like, laporan, blokir)
 */
export type MemberAccessLevel = "any" | "nonsuspended" | "active";

export const MEMBER_ACCESS: Readonly<Record<MemberAccessLevel, ReadonlySet<EffectiveStatus>>> = {
  any: new Set(["unverified", "verified", "expiring", "expired", "suspended"]),
  nonsuspended: new Set(["unverified", "verified", "expiring", "expired"]),
  active: new Set(["verified", "expiring"]),
};

export function memberAccessAllows(level: MemberAccessLevel, status: EffectiveStatus): boolean {
  return MEMBER_ACCESS[level].has(status);
}

/**
 * PRD 2.2: suspended → 403 ACCOUNT_SUSPENDED; status lain di luar tingkat → 403 MEMBERSHIP_REQUIRED. Status akun
 * non-aktif (pending_otp/disabled/deletion_pending) tidak pernah lolos tingkat mana pun.
 */
export function assertMemberAccess(level: MemberAccessLevel, status: EffectiveStatus): void {
  if (memberAccessAllows(level, status)) return;
  if (status === "suspended")
    throw new AppException(403, "ACCOUNT_SUSPENDED", "Akun Anda sedang dibatasi. Buka portal pembatasan.");
  throw new AppException(
    403,
    "MEMBERSHIP_REQUIRED",
    status === "unverified"
      ? "Fitur ini tersedia setelah iuran pendaftaran diverifikasi."
      : "Fitur ini memerlukan KTA aktif. Perpanjang keanggotaan untuk melanjutkan.",
  );
}
