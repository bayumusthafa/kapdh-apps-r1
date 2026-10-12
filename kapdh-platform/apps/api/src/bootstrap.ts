import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import type { DynamicModule, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { LogController } from "fastify";
import type { DestinationStream } from "pino";
import { v7 as uuidv7 } from "uuid";
import { type AppDeps, AppModule } from "./app.module.js";
import { installHttpHooks } from "./core/http/fastify-hooks.js";
import { RequestGate } from "./core/http/request-gate.js";
import { createRootLogger, NestPinoLogger } from "./core/logging/logger.js";
import type { RateLimitStore } from "./core/rate-limit/store.js";

export interface CreateAppOptions {
  /** false = log senyap (uji). Bawaan mengikuti LOG_LEVEL. */
  logger?: boolean;
  /** Tujuan log JSON (bawaan stdout); uji memakai stream memori untuk memeriksa redaksi. */
  logDestination?: DestinationStream;
  rateLimitStore?: RateLimitStore;
  /** Modul tambahan, hanya untuk uji. */
  extraModules?: (Type | DynamicModule)[];
}

/** Batas body JSON global (1 MB); unggahan berkas memakai batas per rute (N-10). */
export const JSON_BODY_LIMIT = 1_048_576;
/** HSTS 1 tahun bila HSTS_ENABLED (N-07). */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * Factory tunggal aplikasi (main.ts dan uji): Fastify + Nest, prefix /api/v1, logger pino JSON (N-14), request_id
 * server, trust proxy per hop (TRUST_PROXY_HOPS), helmet dengan HSTS terkendali env (N-07), CORS hanya origin web
 * admin dan situs publik, hook konteks/maintenance/versi (ARCHITECTURE §4.3).
 */
export async function createApp(deps: AppDeps, options: CreateAppOptions = {}): Promise<NestFastifyApplication> {
  const logger = createRootLogger({
    level: options.logger === false ? "silent" : deps.env.LOG_LEVEL,
    service: "kapdh-api",
    destination: options.logDestination,
  });
  const adapter = new FastifyAdapter({
    loggerInstance: logger,
    // Satu baris log per request ditulis hook onResponse (tanpa query/header/body); label korelasi `request_id`.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    // request_id selalu dibuat server; X-Request-Id klien hanya dicatat sebagai client_request_id.
    requestIdHeader: false,
    genReqId: () => uuidv7(),
    // Hanya hop proxy tepercaya (Traefik); X-Forwarded-For dari klien tidak dapat memalsukan req.ip (PRD 2.5).
    trustProxy: deps.env.TRUST_PROXY_HOPS > 0 ? deps.env.TRUST_PROXY_HOPS : false,
    bodyLimit: JSON_BODY_LIMIT,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(deps, { logger, rateLimitStore: options.rateLimitStore, extraModules: options.extraModules }),
    adapter,
    { logger: new NestPinoLogger(logger) },
  );
  app.setGlobalPrefix("api/v1");
  await app.register(helmet, {
    contentSecurityPolicy: false,
    hsts: deps.env.HSTS_ENABLED ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true } : false,
  });
  await app.register(cookie);
  // Web admin memakai cookie (credentials); situs publik hanya memanggil endpoint publik.
  app.enableCors({
    origin: [deps.env.ADMIN_ORIGIN, new URL(deps.env.PUBLIC_WEB_URL).origin],
    credentials: true,
    exposedHeaders: ["x-request-id", "retry-after", "idempotent-replayed"],
  });
  const gate = app.get(RequestGate);
  installHttpHooks(app.getHttpAdapter().getInstance(), () => gate);
  return app;
}
