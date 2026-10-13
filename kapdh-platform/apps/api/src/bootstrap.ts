import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import type { DynamicModule, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { LogController } from "fastify";
import type { DestinationStream } from "pino";
import { v7 as uuidv7 } from "uuid";
import { type AppDeps, AppModule } from "./app.module.js";
import { FILE_TOKEN_MAX_LENGTH } from "./core/files/file-token.js";
import { MAX_UPLOAD_BYTES } from "./core/files/purposes.js";
import { installHttpHooks, installMultipartGate } from "./core/http/fastify-hooks.js";
import { RequestGate } from "./core/http/request-gate.js";
import { createRootLogger, NestPinoLogger } from "./core/logging/logger.js";
import type { RateLimitStore } from "./core/rate-limit/store.js";
import { KapdhIoAdapter } from "./core/realtime/io-adapter.js";

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
export async function createApp(
  deps: AppDeps,
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
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
    // Token URL berkas privat ada di path `/files/content/{token}` (PRD 5.4); bawaan Fastify 100 karakter terlalu
    // pendek untuk JWT kompak. Parameter lain tetap divalidasi (UUID pipe, zod).
    routerOptions: { maxParamLength: FILE_TOKEN_MAX_LENGTH },
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(deps, {
      logger,
      rateLimitStore: options.rateLimitStore,
      extraModules: options.extraModules,
    }),
    adapter,
    // Parser bawaan Nest (JSON + urlencoded) dimatikan: API hanya menerima application/json lewat parser Fastify
    // (bodyLimit dan penolakan __proto__ tetap berlaku). Unggahan multipart dipasang modul files per rute.
    // abortOnError false: galat DI/inisialisasi menolak promise createApp (main.ts mencatatnya aman; uji melihat
    // pesan UnknownDependenciesException) alih-alih process.abort() yang mematikan worker vitest tanpa petunjuk.
    { logger: new NestPinoLogger(logger), bodyParser: false, abortOnError: false },
  );
  // text/plain dan tipe lain di luar JSON → 415 VALIDATION_ERROR (multipart → 415 FILE_INVALID), bukan body string.
  const fastify = adapter.getInstance();
  fastify.removeContentTypeParser(["text/plain", "application/json"]);
  // JSON: parser bawaan Fastify (bodyLimit, __proto__/constructor ditolak), tetapi body kosong dengan header
  // application/json (mis. POST /auth/logout dari klien yang selalu mengirim header) diterima sebagai tanpa body.
  const defaultJson = fastify.getDefaultJsonParser("error", "error");
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    defaultJson(request, text, done);
  });
  app.setGlobalPrefix("api/v1");
  // Multipart hanya untuk rute ber-@RouteConfig({ multipart: true }) (POST /files); rute lain tetap 415 FILE_INVALID.
  // Batas busboy: satu berkas <= 10 MB (batas per purpose/tipe diperiksa FilesService, N-10), field kecil.
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 6, fieldSize: 256, headerPairs: 50 },
  });
  installMultipartGate(fastify);
  // Socket.IO /realtime di server HTTP yang sama (ARCHITECTURE §4.9): websocket saja, Origin browser dibatasi,
  // adapter Redis bila REDIS_URL diisi.
  app.useWebSocketAdapter(
    new KapdhIoAdapter(app, {
      allowedOrigins: [deps.env.ADMIN_ORIGIN, new URL(deps.env.PUBLIC_WEB_URL).origin],
      redis: deps.redis ?? null,
    }),
  );
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
