import type { Permission } from "@kapdh/contracts";
import { FILE_PURPOSES, type FilePurpose } from "@kapdh/database";
import type { MemberAccessLevel } from "../membership/access.js";

export { FILE_PURPOSES, type FilePurpose };

/** Batas ukuran N-10: gambar <= 5 MB, PDF <= 10 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Batas terbesar yang dibaca dari multipart sebelum purpose dan tipe diketahui. */
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
  /** Visibilitas: publik hanya untuk gambar yang memang tampil umum (files_private_purpose_chk). */
  visibility: FileVisibility;
  /** Siapa yang boleh mengunggah lewat POST /files: anggota (sesi mobile), pengurus, atau hanya sistem. */
  uploader: "member" | "admin" | "system";
  /** Anggota: tingkat effective_status minimum (PRD 2.2). */
  memberAccess?: MemberAccessLevel;
  /** Pengurus: SEMUA izin ini wajib (ARCHITECTURE §4.5). */
  permissions?: readonly Permission[];
}

export const FILE_PURPOSE_SPECS: Readonly<Record<FilePurpose, FilePurposeSpec>> = {
  // Foto profil/KTA; dibuka lewat URL bertanda tangan setelah kebijakan akses (anggota lain, pengurus).
  avatar: {
    purpose: "avatar",
    kinds: ["image"],
    visibility: "private",
    uploader: "member",
    memberAccess: "nonsuspended",
  },
  // Gambar chat dan avatar grup: hanya anggota aktif (chat PRD 2.2).
  chat_image: {
    purpose: "chat_image",
    kinds: ["image"],
    visibility: "private",
    uploader: "member",
    memberAccess: "active",
  },
  payment_proof: {
    purpose: "payment_proof",
    kinds: ["image", "pdf"],
    visibility: "private",
    uploader: "member",
    memberAccess: "nonsuspended",
  },
  post_cover: {
    purpose: "post_cover",
    kinds: ["image"],
    visibility: "public",
    uploader: "admin",
    permissions: ["content.manage"],
  },
  banner_image: {
    purpose: "banner_image",
    kinds: ["image"],
    visibility: "public",
    uploader: "admin",
    permissions: ["content.manage"],
  },
  event_cover: {
    purpose: "event_cover",
    kinds: ["image"],
    visibility: "public",
    uploader: "admin",
    permissions: ["events.manage"],
  },
  // Bukti penyelesaian penyesuaian/refund oleh bendahara (D6); gambar saja karena PDF khusus bukti bayar anggota.
  adjustment_evidence: {
    purpose: "adjustment_evidence",
    kinds: ["image"],
    visibility: "private",
    uploader: "admin",
    permissions: ["payments.decide"],
  },
  // Dibangkitkan job ekspor audit (AC F17-4); tidak dapat diunggah.
  audit_export: { purpose: "audit_export", kinds: ["csv"], visibility: "private", uploader: "system" },
};

/** Purpose yang dapat diunggah lewat POST /files. */
export const UPLOADABLE_PURPOSES = FILE_PURPOSES.filter((p) => FILE_PURPOSE_SPECS[p].uploader !== "system");

export function isFilePurpose(value: unknown): value is FilePurpose {
  return typeof value === "string" && (FILE_PURPOSES as readonly string[]).includes(value);
}

export function maxBytesFor(kind: FileKind): number {
  return kind === "pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
}
