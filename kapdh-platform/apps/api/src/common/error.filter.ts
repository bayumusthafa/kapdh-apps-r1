import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { ErrorCode } from "@kapdh/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppException } from "./app-exception.js";

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "VERSION_CONFLICT",
  413: "FILE_INVALID",
  429: "RATE_LIMITED",
  503: "MAINTENANCE",
};

/** Mengubah semua galat menjadi format baku {code, message, field_errors, request_id}; tanpa stack trace ke klien. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("ErrorFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = String(request.id);

    if (exception instanceof AppException) {
      if (exception.extra.retryAfterSeconds)
        reply.header("Retry-After", String(exception.extra.retryAfterSeconds));
      void reply.status(exception.status).send({
        code: exception.code,
        message: exception.message,
        request_id: requestId,
        ...(exception.extra.fieldErrors ? { field_errors: exception.extra.fieldErrors } : {}),
        ...(exception.extra.retryAfterSeconds
          ? { retry_after_seconds: exception.extra.retryAfterSeconds }
          : {}),
        ...(exception.extra.current !== undefined ? { current: exception.extra.current } : {}),
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      void reply.status(status).send({
        code: STATUS_TO_CODE[status] ?? "INTERNAL_ERROR",
        message: status === 404 ? "Data tidak ditemukan." : "Permintaan tidak dapat diproses.",
        request_id: requestId,
      });
      return;
    }

    this.logger.error({ requestId, err: exception instanceof Error ? exception.message : String(exception) });
    void reply
      .status(500)
      .send({ code: "INTERNAL_ERROR", message: "Terjadi kesalahan. Coba lagi.", request_id: requestId });
  }
}
