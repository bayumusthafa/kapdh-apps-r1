import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { catchError, from, mergeMap, type Observable, of, throwError } from "rxjs";
import { AppException } from "../errors/app-exception.js";
import type { AuthedRequest } from "../guards/auth-context.js";
import { isUuid } from "../validation/validate.js";
import { IdempotencyService, payloadHashOf } from "./idempotency.service.js";

export const IDEMPOTENT_KEY = "kapdh:idempotent";
const HEADER = "idempotency-key";

/**
 * Interceptor Idempotency-Key (PRD 4.3). Scope = id pengguna aktor (setelah AuthGuard) atau `anon`; endpoint =
 * metode + pola rute; hash = body + parameter path. Header opsional: tanpa header, permintaan diproses biasa.
 * Hanya untuk endpoint yang seluruh hasilnya ada di body JSON (header seperti Set-Cookie tidak diputar ulang).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const raw = request.headers[HEADER];
    if (raw === undefined) return next.handle();
    if (typeof raw !== "string" || !isUuid(raw.trim()))
      throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
        fieldErrors: { "Idempotency-Key": ["Idempotency-Key harus berupa UUID"] },
      });

    const begin = await this.idempotency.begin({
      scope: request.auth?.userId ?? "anon",
      endpoint: `${request.method} ${request.routeOptions?.url ?? request.url.split("?")[0]}`,
      key: raw.trim().toLowerCase(),
      payloadHash: payloadHashOf({ body: request.body ?? null, params: request.params ?? {} }),
    });
    if (begin.kind === "replay") {
      void reply.status(begin.status).header("idempotent-replayed", "true");
      return of(begin.status === 204 ? undefined : begin.body);
    }

    const recordId = begin.recordId;
    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        // Disimpan sebagai JSON persis seperti yang dikirim ke klien.
        const stored = body === undefined ? null : (JSON.parse(JSON.stringify(body)) as unknown);
        if (reply.statusCode >= 200 && reply.statusCode < 300)
          await this.idempotency.complete(recordId, reply.statusCode, stored);
        else await this.idempotency.abandon(recordId);
        return body;
      }),
      catchError((error: unknown) => from(this.idempotency.abandon(recordId)).pipe(mergeMap(() => throwError(() => error)))),
    );
  }
}

/** Menghormati header Idempotency-Key pada handler ini (ARCHITECTURE §4.3). */
export const Idempotent = () => applyDecorators(SetMetadata(IDEMPOTENT_KEY, true), UseInterceptors(IdempotencyInterceptor));
