import type { components } from "@kapdh/contracts";
import { api } from "./client";
import { unwrap, useApiQuery } from "./query";

type FilePurpose = components["schemas"]["FilePurpose"];
type FileRef = components["schemas"]["FileRef"];
type FileUploadRequest = components["schemas"]["FileUploadRequest"];

/**
 * Aturan berkas sisi klien, cermin aturan server (N-10): JPG/PNG <= 5 MB untuk semua purpose, PDF <= 10 MB hanya
 * untuk bukti bayar. Server tetap memeriksa magic bytes, decoding aman dan kuota unggah.
 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png"] as const;

export function acceptedTypes(purpose: FilePurpose): string[] {
  return purpose === "payment_proof" ? [...IMAGE_TYPES, "application/pdf"] : [...IMAGE_TYPES];
}

export function fileRulesText(purpose: FilePurpose): string {
  return purpose === "payment_proof"
    ? "JPG/PNG maksimal 5 MB atau PDF maksimal 10 MB."
    : "JPG/PNG maksimal 5 MB.";
}

/** Pesan galat bila berkas jelas ditolak server; null bila layak dikirim. */
export function validateFileForPurpose(file: File, purpose: FilePurpose): string | null {
  const isPdf = file.type === "application/pdf";
  const isImage = (IMAGE_TYPES as readonly string[]).includes(file.type);
  if (!isImage && !(isPdf && purpose === "payment_proof"))
    return `Tipe berkas tidak diterima. Gunakan ${fileRulesText(purpose)}`;
  if (file.size > (isPdf ? PDF_MAX_BYTES : IMAGE_MAX_BYTES))
    return isPdf ? "PDF maksimal 10 MB." : "Gambar maksimal 5 MB.";
  if (file.size === 0) return "Berkas kosong.";
  return null;
}

/** POST /files multipart (N-10). Melempar ApiError (FILE_INVALID, RATE_LIMITED, VALIDATION_ERROR, ...). */
export function uploadFile(purpose: FilePurpose, file: File, signal?: AbortSignal): Promise<FileRef> {
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", file, file.name);
  return unwrap(
    api.POST("/files", {
      // openapi-fetch meneruskan FormData apa adanya dan membiarkan peramban menetapkan boundary multipart.
      body: form as unknown as FileUploadRequest,
      signal,
    }),
  );
}

/** Sisa umur URL bertanda tangan yang masih aman dipakai sebelum diminta ulang (server: <= 10 menit, PRD 5.4). */
const ACCESS_STALE_MS = 8 * 60_000;

/** GET /files/{id}/access: URL bertanda tangan untuk pratinjau berkas privat (bukti bayar, sampul). */
export function useFileAccess(fileId: string | null | undefined) {
  return useApiQuery({
    queryKey: ["file-access", fileId],
    enabled: Boolean(fileId),
    staleTime: ACCESS_STALE_MS,
    gcTime: ACCESS_STALE_MS,
    retry: false,
    request: ({ signal, headers }) =>
      api.GET("/files/{fileId}/access", { params: { path: { fileId: fileId ?? "" } }, signal, headers }),
  });
}
