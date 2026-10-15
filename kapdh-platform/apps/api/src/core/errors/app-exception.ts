import type { ErrorCode } from "@kapdh/contracts";

/**
 * Galat domain dengan kode baku (PRD 5.2, ARCHITECTURE §4.4). Pesan aman untuk pengguna dalam Bahasa Indonesia,
 * tanpa detail internal. Body galat: `{code, message, request_id, field_errors?, retry_after_seconds?, current?}`.
 */
export class AppException extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: {
      fieldErrors?: Record<string, string[]>;
      retryAfterSeconds?: number;
      current?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "AppException";
  }
}

/** 404 NOT_FOUND: tidak membedakan "tidak ada" dan "tidak berhak melihat" (N-09). */
export function notFound(message = "Data tidak ditemukan."): AppException {
  return new AppException(404, "NOT_FOUND", message);
}

export function forbidden(message = "Anda tidak memiliki izin untuk tindakan ini."): AppException {
  return new AppException(403, "FORBIDDEN", message);
}

export function unauthenticated(message = "Sesi berakhir. Silakan masuk kembali."): AppException {
  return new AppException(401, "UNAUTHENTICATED", message);
}

/**
 * 403 REAUTH_REQUIRED: X-Reauth-Token tidak ada, tidak sah, atau kedaluwarsa untuk tindakan kredensial (kontrak C1
 * reauthenticate, ADR-025). Dipakai AuthGuard (@RequireReauth) dan layanan dengan reautentikasi bersyarat
 * (@ConditionalReauth, mis. koreksi email login admin).
 */
export function reauthRequired(): AppException {
  return new AppException(
    403,
    "REAUTH_REQUIRED",
    "Konfirmasi ulang identitas Anda untuk melanjutkan tindakan ini.",
  );
}

/** 409 VERSION_CONFLICT dengan keadaan terbaru (AC F15-4, PRD 4.5). */
export function versionConflict(
  current: unknown,
  message = "Data sudah diubah orang lain. Muat ulang untuk melihat versi terbaru.",
): AppException {
  return new AppException(409, "VERSION_CONFLICT", message, { current });
}

/** 429 RATE_LIMITED dengan Retry-After (PRD 2.5). */
export function rateLimited(
  retryAfterSeconds: number,
  message = "Terlalu banyak percobaan. Coba lagi nanti.",
): AppException {
  return new AppException(429, "RATE_LIMITED", message, {
    retryAfterSeconds: Math.max(1, retryAfterSeconds),
  });
}

/** 400 VALIDATION_ERROR untuk satu field. */
export function fieldError(field: string, message: string): AppException {
  return new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
    fieldErrors: { [field]: [message] },
  });
}
