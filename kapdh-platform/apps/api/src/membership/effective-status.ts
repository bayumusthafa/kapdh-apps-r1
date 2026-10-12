import { isExpired, isExpiring } from "./period.js";

export type AccountStatus = "pending_otp" | "active" | "disabled" | "deletion_pending" | "deleted";
export type EffectiveStatus =
  | "pending_otp"
  | "unverified"
  | "verified"
  | "expiring"
  | "expired"
  | "suspended"
  | "disabled"
  | "deletion_pending";

export interface MembershipFacts {
  accountStatus: AccountStatus;
  expiresAt: Date | null;
  suspendedAt: Date | null;
}

/**
 * Dihitung dari data canonical, bukan kolom status yang bisa diubah langsung (PRD 4.2).
 * Urutan: status akun, lalu suspend (mengalahkan masa aktif), lalu periode berdasarkan waktu (tidak menunggu worker).
 */
export function effectiveStatus(facts: MembershipFacts, now: Date): EffectiveStatus {
  switch (facts.accountStatus) {
    case "pending_otp":
      return "pending_otp";
    case "disabled":
    case "deleted":
      return "disabled";
    case "deletion_pending":
      return "deletion_pending";
    case "active":
      break;
  }
  if (facts.suspendedAt) return "suspended";
  if (!facts.expiresAt) return "unverified";
  if (isExpired(facts.expiresAt, now)) return "expired";
  if (isExpiring(facts.expiresAt, now)) return "expiring";
  return "verified";
}

export function hasActiveMembership(status: EffectiveStatus): boolean {
  return status === "verified" || status === "expiring";
}
