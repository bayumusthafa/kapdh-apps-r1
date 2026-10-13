import { randomInt } from "node:crypto";
import type { components } from "@kapdh/contracts";
import { formatDateWib } from "../../core/membership/format.js";
import { jakartaYear } from "../../core/membership/period.js";

type DataItem = components["schemas"]["AccountDeletionDataItem"];
type RetainedItem = components["schemas"]["AccountDeletionRetainedItem"];
type AccountDeletion = components["schemas"]["AccountDeletion"];

/** Penyelesaian otomatis maksimal 7 hari kalender sejak permintaan (F-14, PRD 3.14). */
export const DELETION_COMPLETION_DAYS = 7;
/** Backup harian berotasi 30 hari; deletion ledger diterapkan ulang saat restore (D2, AC F14-6, PRD 5.5). */
export const BACKUP_RETENTION_DAYS = 30;
/** Slug halaman kebijakan privasi (seed referensi LEGAL_PAGE_SHELLS). */
export const PRIVACY_POLICY_SLUG = "kebijakan-privasi";
const DAY_MS = 24 * 3600_000;

/**
 * Versi teks pengungkapan (N-15). Naikkan setiap kali daftar/kalimat di bawah berubah sehingga `version`
 * pengungkapan berubah dan pengguna wajib membaca ulang sebelum konfirmasi.
 */
export const DISCLOSURE_TEXT_VERSION = 1;

/** Data yang dihapus atau menjadi placeholder tanpa isi (AC F14-3, D2). */
export const DELETED_DATA: readonly DataItem[] = [
  { category: "credentials", description: "Email login dan sandi dihapus; akun tidak dapat dipakai masuk lagi." },
  {
    category: "profile",
    description: "Profil alumni (nama, angkatan, kelas, kota, pendidikan, profesi, keahlian, bio) dihapus.",
  },
  { category: "contacts", description: "Nomor telepon, tautan media sosial, dan pengaturan privasinya dihapus." },
  { category: "avatar", description: "Foto profil dihapus dari penyimpanan." },
  {
    category: "private_uploads",
    description: "Unggahan pribadi (gambar chat, avatar grup yang Anda unggah) dihapus dari penyimpanan.",
  },
  {
    category: "payment_proofs",
    description: "Berkas bukti transfer asli dan catatan transfer yang Anda tulis dihapus.",
  },
  {
    category: "chat_content",
    description:
      "Isi pesan chat yang Anda kirim menjadi placeholder tanpa isi; reaksi, like berita, dan daftar blokir dihapus.",
  },
  { category: "device_tokens", description: "Token notifikasi perangkat dicabut lalu dihapus." },
  { category: "sessions", description: "Semua sesi login dicabut seketika dan catatan perangkatnya dihapus." },
  { category: "notifications", description: "Kotak masuk notifikasi dan riwayat pengirimannya dihapus." },
  { category: "preferences", description: "Preferensi notifikasi dan pengaturan akun dihapus." },
];

/** Catatan yang tetap ada hanya dalam bentuk anonim (AC F14-4, D2). */
export const RETAINED_DATA: readonly RetainedItem[] = [
  {
    category: "payments",
    description:
      "Catatan pembayaran tetap ada tanpa nama, email, telepon atau foto: jumlah, tanggal, status dan nomor referensi untuk pembukuan organisasi.",
  },
  {
    category: "tickets",
    description:
      "Tiket event tetap tercatat anonim (jumlah, tanggal, status) agar kuota dan laporan event tetap benar; tiket aktif hangus.",
  },
  {
    category: "membership_history",
    description: "Riwayat periode keanggotaan disimpan anonim tanpa nomor anggota dan tanpa alasan tertulis.",
  },
  {
    category: "moderation_reports",
    description:
      "Laporan moderasi yang melibatkan Anda disimpan anonim; nama, isi pesan dan foto Anda dihapus dari bukti.",
  },
  {
    category: "audit_logs",
    description:
      "Jejak audit keamanan dan keuangan disimpan tanpa identitas Anda sebagai pelaku dan tanpa data pribadi.",
  },
];

/** Alasan sistem untuk tiket/pembayaran yang ditutup penghapusan akun (PRD 3.9 "Akun dihapus: tiket hangus"). */
export const FORFEIT_REASON = "Akun pemilik dihapus (F-14)";

/** Pesan sistem grup (AC F14-5); tanpa nama sehingga tidak menyimpan data pribadi akun yang dihapus. */
export const SYSTEM_MESSAGES = {
  memberDeleted: "Seorang anggota keluar dari grup karena akunnya dihapus.",
  adminTransferred:
    "Seorang admin grup keluar karena akunnya dihapus. Peran admin dialihkan otomatis kepada anggota aktif.",
  groupClosed:
    "Seorang admin grup keluar karena akunnya dihapus dan tidak ada anggota aktif yang dapat menjadi admin. Grup ditutup.",
} as const;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Nomor permintaan yang ditampilkan ke pengguna, `DEL-<tahun WIB>-<8 karakter>` (pola kontrak `^DEL-[0-9]{4}-[0-9A-Z]{4,}$`),
 * tanpa sequence kedua (PRD 6.1). Alfabet Crockford (tanpa I, L, O, U) agar mudah dibacakan ke kanal bantuan.
 */
export function newRequestNumber(now: Date): string {
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += CROCKFORD[randomInt(0, CROCKFORD.length)];
  return `DEL-${jakartaYear(now)}-${suffix}`;
}

/** Batas penyelesaian otomatis sejak permintaan (F-14). */
export function deletionDeadline(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + DELETION_COMPLETION_DAYS * DAY_MS);
}

/** Bentuk kontrak AccountDeletion tanpa data pribadi (AC F14-1). */
export function toAccountDeletion(row: {
  requestNumber: string;
  status: string;
  source: string;
  requestedAt: Date;
  deadlineAt: Date;
  completedAt: Date | null;
}): AccountDeletion {
  return {
    request_number: row.requestNumber,
    status: row.status as AccountDeletion["status"],
    source: row.source as AccountDeletion["source"],
    requested_at: row.requestedAt.toISOString(),
    estimated_completion_at: row.deadlineAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}

/** Email konfirmasi permintaan (F-14): nomor permintaan dan batas penyelesaian, tanpa data pribadi lain. */
export function requestedMail(requestNumber: string, deadline: Date) {
  return {
    subject: `Permintaan penghapusan akun KAPDH ${requestNumber} diterima`,
    text: [
      "Assalamu'alaikum,",
      "",
      `Permintaan penghapusan akun KAPDH Anda telah kami terima dengan nomor ${requestNumber}.`,
      `Semua sesi login sudah dicabut. Penghapusan diselesaikan otomatis paling lambat ${formatDateWib(deadline)} WIB`,
      "dan Anda akan menerima email pemberitahuan saat selesai.",
      "",
      "Catatan pembayaran, tiket, laporan moderasi dan audit hanya disimpan dalam bentuk anonim (D2). Refund yang",
      "sedang diproses tidak otomatis dianggap selesai; hubungi bendahara bila ada dana yang belum kembali.",
      "",
      "Bila Anda tidak meminta penghapusan ini, segera hubungi bantuan KAPDH dengan menyebutkan nomor permintaan.",
    ].join("\n"),
  };
}

/** Email pemberitahuan selesai (F-14 "pemberitahuan setelah selesai"); dikirim sebelum alamat ini dihapus. */
export function completedMail(requestNumber: string) {
  return {
    subject: `Penghapusan akun KAPDH ${requestNumber} selesai`,
    text: [
      "Assalamu'alaikum,",
      "",
      `Penghapusan akun KAPDH dengan nomor permintaan ${requestNumber} telah selesai.`,
      "Data pribadi, kontak, unggahan dan berkas bukti transfer Anda telah dihapus. Catatan keuangan, tiket,",
      `laporan moderasi dan audit hanya tersisa dalam bentuk anonim. Backup harian berotasi ${BACKUP_RETENTION_DAYS} hari`,
      "dan penghapusan ini diterapkan ulang bila backup dipulihkan.",
      "",
      "Alamat email ini tidak lagi disimpan setelah email ini terkirim. Terima kasih telah menjadi bagian dari KAPDH.",
    ].join("\n"),
  };
}
