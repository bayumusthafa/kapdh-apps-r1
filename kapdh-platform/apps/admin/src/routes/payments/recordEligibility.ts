import type { components } from "@kapdh/contracts";
import type { Permission } from "@kapdh/contracts";
import { formatDate } from "../../lib/format";
import { toCents } from "./money";

type MemberDetail = components["schemas"]["AdminMemberDetail"];
type DuesType = components["schemas"]["MembershipPaymentType"];
type FeeSettings = components["schemas"]["FeeSettings"];

/**
 * Izin "Catat iuran" (rencana cadangan D13): adminRecordPayment memerlukan payments.read + payments.decide
 * (x-kapdh-access kontrak). Formulirnya juga membaca daftar alumni (members.read) serta rekening dan biaya
 * (settings.manage); tanpa izin itu dialog menjelaskan alasannya.
 */
export const RECORD_PERMISSIONS: readonly Permission[] = ["payments.read", "payments.decide"];

/**
 * Izin yang dibutuhkan formulir "Catat iuran" secara utuh: selain RECORD_PERMISSIONS, memilih alumni membaca
 * adminListMembers/adminGetMember (members.read), dan rekening penerima serta nominal membaca adminListPaymentMethods/
 * adminGetFees (settings.manage) menurut x-kapdh-access kontrak.
 */
export const RECORD_FORM_PERMISSIONS: readonly Permission[] = [
  ...RECORD_PERMISSIONS,
  "members.read",
  "settings.manage",
];

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

/**
 * Nominal iuran jenis ini belum ditetapkan (kontrak adminRecordPayment, gagal tertutup PRD 8.2 butir 4): pengaturan
 * `fees` belum tersimpan (versi "0", nilai bawaan kode yang tidak pernah disahkan bendahara) atau totalnya 0.00. Server
 * menolak payment iuran baru dengan 403 FORBIDDEN; tagihan terbuka memakai snapshot-nya sendiri.
 */
export function feesUnconfigured(
  fees: Pick<FeeSettings, "version" | "registration_total" | "renewal_fee">,
  type: DuesType,
): boolean {
  if (fees.version === "0") return true;
  const cents = toCents(type === "registration" ? fees.registration_total : fees.renewal_fee);
  // Nilai yang tidak dapat dibaca klien tidak menghalangi: server tetap menjadi penentu.
  return cents !== null && cents <= 0n;
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
