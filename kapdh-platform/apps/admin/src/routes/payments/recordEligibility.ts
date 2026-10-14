import type { components } from "@kapdh/contracts";
import type { Permission } from "@kapdh/contracts";
import { formatDate } from "../../lib/format";

type MemberDetail = components["schemas"]["AdminMemberDetail"];
type DuesType = components["schemas"]["MembershipPaymentType"];

/**
 * Izin "Catat iuran" (rencana cadangan D13): adminRecordPayment memerlukan payments.read + payments.decide
 * (x-kapdh-access kontrak). Formulirnya juga membaca daftar alumni (members.read) serta rekening dan biaya
 * (settings.manage); tanpa izin itu dialog menjelaskan alasannya.
 */
export const RECORD_PERMISSIONS: readonly Permission[] = ["payments.read", "payments.decide"];

export const DUES_TYPES: readonly DuesType[] = ["registration", "renewal"];

/**
 * Alasan iuran tidak dapat dicatat untuk akun ini sama sekali (kontrak adminRecordPayment: akun alumni aktif, tidak
 * disuspend, bukan akun yang tertaut ke admin pemanggil, PRD 2.3). Null bila akun dapat dicatat iurannya.
 */
export function recordBlockReason(
  m: Pick<MemberDetail, "account_status" | "effective_status" | "linked_admin">,
  adminId: string | null | undefined,
): string | null {
  if (m.linked_admin && adminId && m.linked_admin.admin_id === adminId)
    return "Akun alumni ini tertaut ke akun admin Anda. Mintalah pengurus lain mencatat iurannya (konflik kepentingan, PRD 2.3).";
  if (m.effective_status === "suspended")
    return "Akun ini sedang dibatasi pengurus, sehingga iuran tidak dapat dicatat selama pembatasan berlaku.";
  if (
    m.account_status !== "active" ||
    m.effective_status === "pending_otp" ||
    m.effective_status === "disabled" ||
    m.effective_status === "deletion_pending"
  )
    return "Akun ini belum aktif, dinonaktifkan, atau sedang dalam proses penghapusan, sehingga iuran tidak dapat dicatat.";
  return null;
}

/**
 * Kelayakan per jenis iuran, sama dengan instruksi anggota GET /me/fees (AC F07-5): pendaftaran hanya bila iuran
 * pendaftaran belum pernah disetujui (unverified), perpanjangan hanya bila status expiring atau expired. Nilai null
 * berarti jenis itu dapat dipilih; selain itu alasannya.
 */
export function duesUnavailableReason(
  m: Pick<MemberDetail, "effective_status" | "renewal_opens_at">,
): Record<DuesType, string | null> {
  const registration =
    m.effective_status === "unverified" ? null : "Iuran pendaftaran anggota ini sudah disetujui.";
  const renewal =
    m.effective_status === "expiring" || m.effective_status === "expired"
      ? null
      : m.effective_status === "unverified"
        ? "Perpanjangan tersedia setelah iuran pendaftaran disetujui."
        : m.renewal_opens_at
          ? `Jendela perpanjangan dibuka ${formatDate(m.renewal_opens_at)} (30 hari sebelum masa aktif habis).`
          : "Jendela perpanjangan belum dibuka.";
  return { registration, renewal };
}

/** Iuran anggota ini dapat dicatat sekarang: akun tidak terhalang dan sedikitnya satu jenis iuran layak. */
export function canRecordDuesFor(
  m: Pick<MemberDetail, "account_status" | "effective_status" | "linked_admin" | "renewal_opens_at">,
  adminId: string | null | undefined,
): boolean {
  if (recordBlockReason(m, adminId) !== null) return false;
  const unavailable = duesUnavailableReason(m);
  return DUES_TYPES.some((t) => unavailable[t] === null);
}
