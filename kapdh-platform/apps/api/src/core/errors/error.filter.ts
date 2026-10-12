import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import type { ErrorCode } from "@kapdh/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { tryCtx } from "../context/request-context.js";
import { safeError } from "../logging/safe-error.js";
import { ROOT_LOGGER } from "../tokens.js";
import { AppException } from "./app-exception.js";

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  request_id: string;
  field_errors?: Record<string, string[]>;
  retry_after_seconds?: number;
  current?: unknown;
}

const GENERIC: Record<number, { code: ErrorCode; message: string }> = {
  400: { code: "VALIDATION_ERROR", message: "Permintaan tidak valid. Periksa kembali isian Anda." },
  401: { code: "UNAUTHENTICATED", message: "Sesi berakhir. Silakan masuk kembali." },
  403: { code: "FORBIDDEN", message: "Anda tidak memiliki izin untuk tindakan ini." },
  404: { code: "NOT_FOUND", message: "Data tidak ditemukan." },
  405: { code: "VALIDATION_ERROR", message: "Metode tidak didukung untuk alamat ini." },
  406: { code: "VALIDATION_ERROR", message: "Format respons yang diminta tidak didukung." },
  409: { code: "VERSION_CONFLICT", message: "Data sudah berubah. Muat ulang lalu coba lagi." },
  413: { code: "VALIDATION_ERROR", message: "Isi permintaan terlalu besar." },
  415: { code: "VALIDATION_ERROR", message: "Tipe konten tidak didukung. Kirim data sebagai application/json." },
  422: { code: "VALIDATION_ERROR", message: "Permintaan tidak dapat diproses. Periksa kembali isian Anda." },
  426: { code: "UPGRADE_REQUIRED", message: "Versi aplikasi tidak lagi didukung. Perbarui aplikasi." },
  429: { code: "RATE_LIMITED", message: "Terlalu banyak percobaan. Coba lagi nanti." },
  503: { code: "MAINTENANCE", message: "Layanan sedang dalam pemeliharaan. Coba lagi nanti." },
};

/** Unggahan multipart memakai FILE_INVALID untuk ukuran/tipe berkas (N-10, katalog ErrorCode 413/415). */
const MULTIPART_FILE: Record<number, string> = {
  413: "Berkas terlalu besar. Gambar maksimal 5 MB, PDF maksimal 10 MB.",
  415: "Tipe berkas tidak didukung.",
};

function isMultipart(request: FastifyRequest | undefined): boolean {
  const type = request?.headers?.["content-type"];
  return typeof type === "string" && type.toLowerCase().startsWith("multipart/");
}

/**
 * Mengubah semua galat menjadi format baku (PRD 5.2): tanpa stack trace, SQL, atau pesan internal ke klien. Galat 5xx
 * dicatat dengan bentuk aman (safeError): untuk galat database hanya tipe, SQLSTATE, dan constraint; pesan
 * DrizzleQueryError (SQL + parameter) tidak pernah masuk log (perbaikan audit core, N-14).
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  toBody(exception: unknown, request?: FastifyRequest): { status: number; body: Omit<ErrorBody, "request_id"> } {
    if (exception instanceof AppException) {
      const { fieldErrors, retryAfterSeconds, current } = exception.extra;
      return {
        status: exception.status,
        body: {
          code: exception.code,
          message: exception.message,
          ...(fieldErrors ? { field_errors: fieldErrors } : {}),
          ...(retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : {}),
          ...(current !== undefined ? { current } : {}),
        },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (isMultipart(request) && MULTIPART_FILE[status])
        return { status, body: { code: "FILE_INVALID", message: MULTIPART_FILE[status] } };
      const generic =
        GENERIC[status] ??
        (status >= 500
          ? { code: "INTERNAL_ERROR" as const, message: "Terjadi kesalahan. Coba lagi." }
          : GENERIC[400]!);
      return { status, body: { ...generic } };
    }
    return { status: 500, body: { code: "INTERNAL_ERROR", message: "Terjadi kesalahan. Coba lagi." } };
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const type = host.getType<"http" | "ws" | "rpc">();
    if (type !== "http") {
      // Gateway Socket.IO (ARCHITECTURE §4.9): kirim galat baku ke klien socket, jangan melempar ulang.
      const { status, body } = this.toBody(exception);
      if (status >= 500) this.logger.error({ error: safeError(exception), ...this.correlation() }, "galat realtime");
      const client = host.switchToWs().getClient<{ emit?: (event: string, data: unknown) => void }>();
      client?.emit?.("exception", { ...body, request_id: tryCtx()?.requestId ?? null });
      return;
    }

    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const { status, body } = this.toBody(exception, request);
    const requestId = String(request?.id ?? tryCtx()?.requestId ?? "");

    if (status >= 500) {
      (request?.log ?? this.logger).error({ error: safeError(exception) }, "galat tak tertangani");
    }
    if (reply.sent) return;
    if (body.retry_after_seconds) void reply.header("Retry-After", String(body.retry_after_seconds));
    void reply.status(status).send({ ...body, request_id: requestId });
  }

  private correlation(): Record<string, string> {
    const context = tryCtx();
    return context ? { request_id: context.requestId } : {};
  }
}
