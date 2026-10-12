import type { ApiError as ApiErrorBody, ErrorCode } from "@kapdh/contracts";
import { CLIENT_ERROR_UI, type ClientErrorCode, type ErrorUi, errorUiFor, isErrorCode } from "@kapdh/shared";

export type AnyErrorCode = ErrorCode | ClientErrorCode;

interface ApiErrorInit {
  code: AnyErrorCode;
  status: number;
  message: string;
  requestId?: string | null;
  fieldErrors?: Record<string, string[]>;
  retryAfterSeconds?: number | null;
  current?: unknown;
  reauthCancelled?: boolean;
  cause?: unknown;
}

/**
 * Galat API bertipe untuk seluruh web admin. Bentuk body mengikuti kontrak `Error` (PRD 5.2) dan perilaku UI
 * diambil dari katalog tunggal `ERROR_UI` (@kapdh/shared) agar sama dengan klien Flutter (PRD 4.5).
 * Galat jaringan (NETWORK) dan respons yang tidak dikenali, mis. HTML 502 dari proxy (UNKNOWN), tidak pernah
 * membuat admin keluar.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: AnyErrorCode;
  readonly status: number;
  readonly requestId: string | null;
  readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
  readonly retryAfterSeconds: number | null;
  readonly current: unknown;
  readonly ui: ErrorUi;
  /** True bila admin membatalkan dialog reautentikasi sehingga tindakan tidak dikirim ulang. */
  readonly reauthCancelled: boolean;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.fieldErrors = init.fieldErrors ?? {};
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.current = init.current;
    this.reauthCancelled = init.reauthCancelled ?? false;
    this.ui = isErrorCode(init.code) ? errorUiFor(init.code) : CLIENT_ERROR_UI[init.code];
  }

  /** Body galat dari server (bila berbentuk kontrak `Error`) beserta status HTTP-nya. */
  static fromResponse(body: unknown, status: number): ApiError {
    if (isErrorBody(body)) {
      const ui = errorUiFor(body.code);
      return new ApiError({
        code: isErrorCode(body.code) ? body.code : "UNKNOWN",
        status,
        message: body.message?.trim() ? body.message : ui.fallbackMessage,
        requestId: body.request_id,
        fieldErrors: body.field_errors ?? {},
        retryAfterSeconds: body.retry_after_seconds ?? null,
        current: body.current,
      });
    }
    return new ApiError({ code: "UNKNOWN", status, message: CLIENT_ERROR_UI.UNKNOWN.fallbackMessage });
  }

  static network(cause: unknown): ApiError {
    return new ApiError({
      code: "NETWORK",
      status: 0,
      message: CLIENT_ERROR_UI.NETWORK.fallbackMessage,
      cause,
    });
  }

  /** Salinan galat REAUTH_REQUIRED yang menandai admin membatalkan reautentikasi. */
  withReauthCancelled(): ApiError {
    return new ApiError({
      code: this.code,
      status: this.status,
      message: "Tindakan dibatalkan karena identitas belum dikonfirmasi ulang.",
      requestId: this.requestId,
      reauthCancelled: true,
    });
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    "request_id" in value
  );
}

/** Ubah apa pun yang dilempar (galat fetch, body kontrak, ApiError) menjadi ApiError. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isErrorBody(error)) return ApiError.fromResponse(error, 0);
  // fetch() menolak dengan TypeError saat jaringan putus, DNS gagal atau CORS ditolak.
  if (error instanceof TypeError) return ApiError.network(error);
  return new ApiError({
    code: "UNKNOWN",
    status: 0,
    message: CLIENT_ERROR_UI.UNKNOWN.fallbackMessage,
    cause: error,
  });
}

/** Pesan aman untuk ditampilkan; pesan server diutamakan, lalu pesan cadangan katalog. */
export function errorMessage(error: unknown): string {
  return toApiError(error).message;
}
