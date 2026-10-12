import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "./client";
import { refetchInBackground, unwrap, useApiQuery } from "./query";

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

/** URL bertanda tangan diminta ulang sekian ms sebelum `expires_at` (server: berlaku <= 10 menit, PRD 5.4). */
export const ACCESS_RENEW_MARGIN_MS = 30_000;
/** URL yang tersisa kurang dari ini dianggap sudah kedaluwarsa (tidak layak dibuka). */
const ACCESS_EXPIRED_MARGIN_MS = 5_000;

type FileAccess = components["schemas"]["FileAccess"];

function expiresAtMs(access: FileAccess | undefined): number {
  if (!access) return 0;
  // Berkas publik memakai URL tetap tanpa kedaluwarsa (expires_at null, kontrak FileAccess).
  if (access.expires_at === null) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(access.expires_at);
  return Number.isFinite(ms) ? ms : 0;
}

/** URL akses sudah (hampir) kedaluwarsa sehingga harus diminta ulang sebelum dipakai. */
export function isAccessExpired(access: FileAccess | undefined, now = Date.now()): boolean {
  const exp = expiresAtMs(access);
  return exp === 0 || exp - now <= ACCESS_EXPIRED_MARGIN_MS;
}

/**
 * GET /files/{id}/access: URL bertanda tangan untuk pratinjau berkas privat (bukti bayar, sampul).
 * Umur cache mengikuti `expires_at` dari server, dan selama komponen terpasang URL diperbarui otomatis sebelum
 * kedaluwarsa (permintaan latar, bukan aktivitas admin; AC F02-5) sehingga tautan "Buka" tidak pernah basi walau
 * panel terbuka lebih lama dari umur URL.
 */
export function useFileAccess(fileId: string | null | undefined) {
  const queryClient = useQueryClient();
  const access = useApiQuery<FileAccess>({
    queryKey: ["file-access", fileId],
    enabled: Boolean(fileId),
    staleTime: (query) => Math.max(0, expiresAtMs(query.state.data) - Date.now() - ACCESS_RENEW_MARGIN_MS),
    gcTime: 10 * 60_000,
    retry: false,
    request: ({ signal, headers }) =>
      api.GET("/files/{fileId}/access", { params: { path: { fileId: fileId ?? "" } }, signal, headers }),
  });

  const expiresAt = access.data?.expires_at;
  useEffect(() => {
    if (!fileId || !expiresAt) return;
    const exp = Date.parse(expiresAt);
    if (!Number.isFinite(exp)) return;
    const delay = Math.max(1_000, exp - Date.now() - ACCESS_RENEW_MARGIN_MS);
    const timer = window.setTimeout(
      () => void refetchInBackground(queryClient, ["file-access", fileId]),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [fileId, expiresAt, queryClient]);

  return access;
}
