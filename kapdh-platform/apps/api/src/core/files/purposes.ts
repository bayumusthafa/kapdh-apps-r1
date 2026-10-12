import type { Permission } from "@kapdh/contracts";
import { FILE_PURPOSES, type FilePurpose } from "@kapdh/database";
import type { MemberAccessLevel } from "../membership/access.js";

export { FILE_PURPOSES, type FilePurpose };

/** Batas ukuran N-10: gambar <= 5 MB, PDF <= 10 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Batas terbesar yang dibaca dari multipart (batas busboy global); batas per purpose lebih ketat. */
export const MAX_UPLOAD_BYTES = MAX_PDF_BYTES;
/** N-10: maksimal 10 unggahan berhasil per purpose per pengguna per rolling 24 jam. */
export const UPLOAD_QUOTA = 10;
export const UPLOAD_QUOTA_WINDOW_MS = 24 * 3600_000;
/** Unggahan yang belum dilampirkan ke objek dihapus job setelah 24 jam (PRD 2.5). */
export const TEMP_FILE_MAX_AGE_MS = 24 * 3600_000;

export type FileKind = "image" | "pdf" | "csv";
export type FileVisibility = "public" | "private";

/** Aturan per purpose (PRD 2.5, 5.4, N-10). */
export interface FilePurposeSpec {
  purpose: FilePurpose;
  /** Jenis isi yang diterima. PDF hanya untuk bukti bayar (PRD 2.5). */
  kinds: readonly FileKind[];
  /** Visibilitas awal: publik hanya untuk gambar yang memang tampil umum (files_private_purpose_chk). */
  visibility: FileVisibility;
  /**
   * Boleh dijadikan publik lewat `FilesService.setVisibility` (avatar publik sesuai pengaturan privasi pemiliknya,
   * PRD 5.4). Harus sejalan dengan files_private_purpose_chk.
   */
  publicAllowed: boolean;
  /** Siapa yang boleh mengunggah lewat POST /files: anggota (sesi mobile), pengurus, atau hanya sistem. */
  uploader: "member" | "admin" | "system";
  /** Anggota: tingkat effective_status minimum (PRD 2.2). */
  memberAccess?: MemberAccessLevel;
  /** Pengurus: SEMUA izin ini wajib (ARCHITECTURE §4.5). */
  permissions?: readonly Permission[];
  /**
   * Purpose anggota yang JUGA boleh diunggah sesi admin dengan SEMUA izin ini (mis. bukti verifikasi pembayaran yang
   * dicatat pengurus, D13 rencana cadangan iOS / adminRecordPayment). Berkas menjadi milik akun login admin.
   */
  adminPermissions?: readonly Permission[];
}

export const FILE_PURPOSE_SPECS: Readonly<Record<FilePurpose, FilePurposeSpec>> = {
  // Foto profil/KTA: privat bawaan; dibuka lewat URL bertanda tangan setelah kebijakan akses (pemilik, pengurus,
  // dan aturan modul seperti direktori). Modul profil dapat menjadikannya publik sesuai pengaturan privasi.
  avatar: {
    purpose: "avatar",
    kinds: ["image"],
    visibility: "private",
    publicAllowed: true,
    uploader: "member",
    memberAccess: "nonsuspended",
  },
  // Gambar chat dan avatar grup: hanya anggota aktif (chat PRD 2.2); tidak pernah publik.
  chat_image: {
    purpose: "chat_image",
    kinds: ["image"],
    visibility: "private",
    publicAllowed: false,
    uploader: "member",
    memberAccess: "active",
  },
  // Satu-satunya purpose yang menerima PDF (PRD 2.5); tidak pernah publik (PRD 5.4). Pengurus payments.decide juga
  // dapat mengunggah bukti verifikasi untuk pembayaran yang dicatat pengurus (adminRecordPayment, D13).
  payment_proof: {
    purpose: "payment_proof",
    kinds: ["image", "pdf"],
    visibility: "private",
    publicAllowed: false,
    uploader: "member",
    memberAccess: "nonsuspended",
    adminPermissions: ["payments.decide"],
  },
  post_cover: {
    purpose: "post_cover",
    kinds: ["image"],
    visibility: "public",
    publicAllowed: true,
    uploader: "admin",
    permissions: ["content.manage"],
  },
  banner_image: {
    purpose: "banner_image",
    kinds: ["image"],
    visibility: "public",
    publicAllowed: true,
    uploader: "admin",
    permissions: ["content.manage"],
  },
  event_cover: {
    purpose: "event_cover",
    kinds: ["image"],
    visibility: "public",
    publicAllowed: true,
    uploader: "admin",
    permissions: ["events.manage"],
  },
  // Bukti penyelesaian penyesuaian/refund oleh bendahara (D6); gambar saja karena PDF khusus bukti bayar anggota.
  adjustment_evidence: {
    purpose: "adjustment_evidence",
    kinds: ["image"],
    visibility: "private",
    publicAllowed: false,
    uploader: "admin",
    permissions: ["payments.decide"],
  },
  // Dibangkitkan job ekspor audit (AC F17-4); tidak dapat diunggah dan tidak pernah publik.
  audit_export: {
    purpose: "audit_export",
    kinds: ["csv"],
    visibility: "private",
    publicAllowed: false,
    uploader: "system",
  },
};

/** Purpose yang dapat diunggah pengguna (bukan buatan sistem), lewat POST /files atau endpoint unggah domain. */
export const UPLOADABLE_PURPOSES = FILE_PURPOSES.filter((p) => FILE_PURPOSE_SPECS[p].uploader !== "system");

/**
 * Purpose yang diterima unggahan umum POST /files (kontrak files.yaml `FileUploadPurpose`). Gambar publik konten
 * diunggah lewat endpoint domainnya sendiri sehingga izin area itu yang diperiksa: `post_cover`/`banner_image` lewat
 * POST /admin/content/media (content.manage, kontrak C4) dan `event_cover` lewat POST /admin/event-covers
 * (events.manage, kontrak C5); keduanya memakai FilesService.beginUpload/completeUpload yang sama.
 */
export const GENERAL_UPLOAD_PURPOSES = [
  "avatar",
  "chat_image",
  "payment_proof",
  "adjustment_evidence",
] as const satisfies readonly FilePurpose[];

export function isFilePurpose(value: unknown): value is FilePurpose {
  return typeof value === "string" && (FILE_PURPOSES as readonly string[]).includes(value);
}

export function maxBytesFor(kind: FileKind): number {
  return kind === "pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
}

/**
 * Batas byte yang dibaca dari stream unggahan untuk purpose (N-10): 5 MB untuk purpose khusus gambar, 10 MB untuk
 * `payment_proof` (PDF); gambar bukti bayar tetap dibatasi 5 MB setelah tipe dideteksi.
 */
export function maxStreamBytesFor(spec: FilePurposeSpec): number {
  return Math.max(...spec.kinds.map(maxBytesFor));
}
