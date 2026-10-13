import type { components } from "@kapdh/contracts";
import type { payments } from "@kapdh/database";
import type { EffectiveStatus } from "../../core/membership/effective-status.js";
import { renewalOpensAt } from "../../core/membership/period.js";

type MeMembershipPayment = components["schemas"]["MeMembershipPayment"];
type MemberCardStatus = components["schemas"]["MemberCardStatus"];
type MemberCardAction = components["schemas"]["MemberCardAction"];
type PaymentRow = typeof payments.$inferSelect;

const DAY_MS = 24 * 3600_000;
/** Batas tampilan KTA offline sejak sinkronisasi terakhir (AC F05-2, F05-3). */
export const OFFLINE_CARD_MAX_AGE_MS = 7 * DAY_MS;

/**
 * Penunjuk iuran keanggotaan nonterminal untuk perutean layar Biaya KTA / unggah bukti / Menunggu / Ditolak
 * (PRD 2.2, 4.3, AC F03-3, F04-2): pending tanpa bukti = awaiting_proof, pending dengan bukti = awaiting_review,
 * rejected = dapat diperbaiki dengan payment yang sama. Alasan penolakan hanya untuk pemilik dan hanya saat ditolak.
 */
export function toMembershipPayment(row: PaymentRow): MeMembershipPayment {
  const stage =
    row.status === "rejected" ? "rejected" : row.proofVersion === 0 ? "awaiting_proof" : "awaiting_review";
  return {
    id: row.id,
    stage,
    amount: row.amount,
    proof_version: row.proofVersion,
    created_at: row.createdAt.toISOString(),
    submitted_at: row.submittedAt?.toISOString() ?? null,
    decided_at: row.decidedAt?.toISOString() ?? null,
    rejection_reason: row.status === "rejected" ? row.rejectionReason : null,
  };
}

export interface RenewalState {
  /** expires_at - 30 hari; null bila belum pernah aktif. */
  opensAt: Date | null;
  /** Jendela renewal terbuka (juga setelah expired) dan tidak suspended (AC F07-5, PRD 2.2). */
  eligible: boolean;
}

/**
 * Jendela perpanjangan (AC F07-5, disahkan v3.2): dibuka 30 hari sebelum expires_at dan TETAP terbuka setelah
 * expired, tanpa masa tenggang. Suspend tidak membuang tanggal periode tetapi menutup kelayakan pembayaran baru
 * (PRD 2.2); status akun nonaktif juga tidak layak.
 */
export function renewalState(expiresAt: Date | null, status: EffectiveStatus, now: Date): RenewalState {
  const opensAt = expiresAt ? renewalOpensAt(expiresAt) : null;
  const statusAllows = status === "verified" || status === "expiring" || status === "expired";
  return { opensAt, eligible: opensAt !== null && statusAllows && now.getTime() >= opensAt.getTime() };
}

/**
 * Label status kartu (PRD 2.2, 3.5; MemberCardStatus): verified → KTA Aktif, expiring → tetap aktif dengan tanggal
 * habis, unverified → KTA Tidak Aktif, expired → KTA Kedaluwarsa, suspended → dibatasi tanpa QR. Status akun
 * nonaktif (tidak pernah memiliki sesi biasa) diperlakukan Tidak Aktif.
 */
export function cardStatusFor(status: EffectiveStatus): MemberCardStatus {
  switch (status) {
    case "verified":
      return "active";
    case "expiring":
      return "expiring";
    case "expired":
      return "expired";
    case "suspended":
      return "suspended";
    default:
      return "inactive";
  }
}

/** QR hanya untuk kartu active/expiring (F-05, ARCHITECTURE §3.2). */
export function cardAllowsQr(status: MemberCardStatus): boolean {
  return status === "active" || status === "expiring";
}

/**
 * Ajakan utama kartu (guideline hal. 6, MemberCardAction):
 * - suspended → tidak ada tindakan (portal pembatasan);
 * - unverified → lanjutkan iuran pendaftaran terbuka, atau mulai bayar (Biaya KTA);
 * - lainnya → lanjutkan iuran renewal terbuka, atau Perpanjang bila jendela renewal terbuka, selain itu null.
 */
export function cardAction(input: {
  status: EffectiveStatus;
  registrationPaymentId: string | null;
  renewalPaymentId: string | null;
  renewalOpen: boolean;
}): { action: MemberCardAction | null; openPaymentId: string | null } {
  const { status } = input;
  if (status === "suspended") return { action: null, openPaymentId: null };
  if (status === "unverified" || status === "pending_otp") {
    return input.registrationPaymentId
      ? { action: "continue_payment", openPaymentId: input.registrationPaymentId }
      : { action: "pay_registration", openPaymentId: null };
  }
  if (status !== "verified" && status !== "expiring" && status !== "expired")
    return { action: null, openPaymentId: null };
  if (input.renewalPaymentId) return { action: "continue_payment", openPaymentId: input.renewalPaymentId };
  return { action: input.renewalOpen ? "renew" : null, openPaymentId: null };
}

/**
 * Batas tampilan offline berlabel Offline (AC F05-2, F05-3): min(synced_at + 7 hari, expires_at, token QR); null bila
 * kartu tidak boleh tampil aktif secara offline (tanpa QR: inactive, expired, suspended).
 */
export function offlineValidUntil(
  syncedAt: Date,
  expiresAt: Date | null,
  qrExpiresAt: Date | null,
): Date | null {
  if (!expiresAt || !qrExpiresAt) return null;
  return new Date(
    Math.min(syncedAt.getTime() + OFFLINE_CARD_MAX_AGE_MS, expiresAt.getTime(), qrExpiresAt.getTime()),
  );
}

/** Pola LIKE aman: `\`, `%` dan `_` dari masukan pengguna diperlakukan literal (escape bawaan PostgreSQL `\`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
