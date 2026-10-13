import { EFFECTIVE_STATUS_VALUES, type components } from "@kapdh/contracts";
import { membershipLabelFor } from "@kapdh/shared";

type S = components["schemas"];

/** Label tampilan area Manajemen Users (PRD 3.5, 4.2; guideline hal. 16). */

export const GENDER_LABEL: Record<S["Gender"], string> = { male: "Laki-laki", female: "Perempuan" };

export const GENDER_OPTIONS = [
  { value: "male", label: GENDER_LABEL.male },
  { value: "female", label: GENDER_LABEL.female },
] as const satisfies readonly { value: S["Gender"]; label: string }[];

/** Kelas 1-3 = 1-3 MTs, 4-6 = 1-3 Aliyah (PRD 3.5). */
export function classLabel(level: number): string {
  return level <= 3 ? `Kelas ${level} (${level} MTs)` : `Kelas ${level} (${level - 3} Aliyah)`;
}

export const CLASS_OPTIONS = [1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: classLabel(n) }));

/** Status pendidikan SS pada nomor anggota (tabel PRD 3.5). */
export const EDUCATION_STATUS_LABEL: Record<S["EducationStatus"], string> = {
  "01": "01 - Tamat MTs dan Aliyah",
  "02": "02 - Tamat MTs atau Aliyah",
  "03": "03 - Tidak tamat",
};

/** Status akun lapisan autentikasi (`users.status`, PRD 4.2); berbeda dari status keanggotaan. */
export const ACCOUNT_STATUS_LABEL: Record<S["AccountStatus"], string> = {
  pending_otp: "Menunggu verifikasi email",
  active: "Aktif",
  disabled: "Dinonaktifkan",
  deletion_pending: "Penghapusan diproses",
  deleted: "Dihapus",
};

export const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "Semua status" },
  ...EFFECTIVE_STATUS_VALUES.map((s) => ({ value: s, label: membershipLabelFor(s) })),
] as const;

export const MEMBER_SORT_OPTIONS = [
  { value: "registered_desc", label: "Terdaftar terbaru" },
  { value: "registered_asc", label: "Terdaftar terlama" },
  { value: "name_asc", label: "Nama A-Z" },
  { value: "name_desc", label: "Nama Z-A" },
  { value: "cohort_asc", label: "Angkatan terkecil" },
  { value: "cohort_desc", label: "Angkatan terbesar" },
  { value: "member_number_asc", label: "Nomor anggota" },
  { value: "expires_at_asc", label: "Masa aktif habis tercepat" },
  { value: "expires_at_desc", label: "Masa aktif habis terlama" },
] as const satisfies readonly { value: S["AdminMemberSort"]; label: string }[];

export const MEMBERSHIP_EVENT_LABEL: Record<S["AdminMembershipEventKind"], string> = {
  activation: "Aktivasi keanggotaan",
  renewal: "Perpanjangan",
  suspend: "Dibatasi (suspend)",
  unsuspend: "Pembatasan dicabut",
  number_correction: "Koreksi nomor anggota",
  warn: "Peringatan moderasi",
};

export const PERIOD_KIND_LABEL: Record<S["MembershipPeriodKind"], string> = {
  activation: "Aktivasi",
  renewal: "Perpanjangan",
};

export const MASTER_KIND_LABEL: Record<S["MasterKind"], { singular: string; plural: string }> = {
  professions: { singular: "profesi", plural: "Profesi" },
  skills: { singular: "keahlian", plural: "Keahlian" },
};

/** Teks pengganti alasan suspend yang disembunyikan server (`reason_redacted`, PRD 2.3, AC F15-1). */
export const REASON_REDACTED_TEXT = "Alasan hanya untuk pemegang izin moderasi";

/**
 * Angkatan terbesar pada pilihan filter: angkatan N lulus tahun 1996 + N (PRD 3.5), ditambah satu angkatan yang
 * belum lulus tahun ini; maksimal 99 (kontrak). Hanya pilihan tampilan; server memvalidasi filter.
 */
export function latestCohort(now: Date = new Date()): number {
  return Math.min(99, Math.max(1, now.getFullYear() - 1996 + 1));
}
