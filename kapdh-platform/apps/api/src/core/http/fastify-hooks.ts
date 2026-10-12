import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AsyncResource } from "node:async_hooks";
import { ANONYMOUS_ACTOR, type RequestContext, runInContext } from "../context/request-context.js";
import type { RequestGate } from "./request-gate.js";

const CONTEXT_RESOURCE = Symbol("kapdh.requestContextResource");
type WithResource = FastifyRequest & { [CONTEXT_RESOURCE]?: AsyncResource };

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** X-Request-Id klien hanya disimpan untuk log bila berformat aman (bukan untuk audit). */
function clientRequestId(request: FastifyRequest): string | null {
  const value = header(request, "x-request-id")?.trim();
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function appPlatform(request: FastifyRequest): "android" | "ios" | null {
  const value = header(request, "x-app-platform")?.trim().toLowerCase();
  return value === "android" || value === "ios" ? value : null;
}

function appVersion(request: FastifyRequest): string | null {
  const value = header(request, "x-app-version")?.trim();
  return value && value.length <= 32 ? value : null;
}

/**
 * Memasang hook Fastify global (ARCHITECTURE §4.2, §4.3):
 * 1. onRequest: konteks request (AsyncLocalStorage) dengan request_id server; klien X-Request-Id hanya ke log.
 * 2. onRequest: gerbang maintenance dan versi aplikasi minimum (sebelum guard dan sebelum body dibaca).
 * 3. preValidation: memulihkan konteks setelah parsing body (event stream body berjalan di luar konteks awal).
 * 4. onSend: header `x-request-id`; onResponse: satu baris log JSON per request tanpa query/header/body (N-14).
 */
export function installHttpHooks(fastify: FastifyInstance, gate: () => RequestGate): void {
  fastify.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done) => {
    const clientId = clientRequestId(request);
    if (clientId) {
      request.log = request.log.child({ client_request_id: clientId });
      reply.log = request.log;
    }
    const context: RequestContext = {
      requestId: String(request.id),
      jobId: null,
      clientRequestId: clientId,
      actor: { ...ANONYMOUS_ACTOR },
      ip: request.ip ?? null,
      appVersion: appVersion(request),
      appPlatform: appPlatform(request),
      source: "http",
    };
    runInContext(context, () => {
      (request as WithResource)[CONTEXT_RESOURCE] = new AsyncResource("kapdh.request");
      done();
    });
  });

  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    await gate().check({
      method: request.method,
      // Pola rute yang cocok (bukan URL mentah) agar pengecualian maintenance tidak bisa dipancing dengan
      // encoding/segmen aneh; tanpa rute (404) dipakai URL mentah dan diperlakukan bukan pengecualian.
      url: request.routeOptions?.url ?? request.url,
      appPlatform: appPlatform(request),
      appVersion: header(request, "x-app-version"),
    });
  });

  fastify.addHook("preValidation", (request: FastifyRequest, _reply: FastifyReply, done) => {
    const resource = (request as WithResource)[CONTEXT_RESOURCE];
    if (resource) resource.runInAsyncScope(done, request.raw);
    else done();
  });

  fastify.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });

  fastify.addHook("onResponse", (request: FastifyRequest, reply: FastifyReply, done) => {
    const status = reply.statusCode;
    const route = request.routeOptions?.url;
    const level =
      status >= 500
        ? "error"
        : route?.endsWith("/health") || route?.endsWith("/health/ready")
          ? "debug"
          : "info";
    reply.log[level](
      { req: request, res: reply, response_time_ms: Math.round(reply.elapsedTime) },
      "request selesai",
    );
    done();
  });
}
