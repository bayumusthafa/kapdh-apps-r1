import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ErrorTrackerStream, errorTrackingFromEnv, parseDsn } from "./error-tracker.js";
import { createRootLogger } from "./logger.js";
import { safeError } from "./safe-error.js";

const SECRET = "RAHASIA-GLITCHTIP-7f3a";

function quiet() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

/** fetch tiruan yang menyimpan envelope. */
function recorder() {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function eventOf(body: string): Record<string, unknown> & { tags: Record<string, string> } {
  const [header, item, event] = body.trim().split("\n");
  expect(JSON.parse(header!)).toHaveProperty("event_id");
  expect(JSON.parse(item!)).toEqual({ type: "event" });
  return JSON.parse(event!);
}

/** DrizzleQueryError membawa SQL + parameter di pesan; cause = galat driver dengan SQLSTATE. */
function drizzleError() {
  const cause = Object.assign(new Error("duplicate key"), {
    severity: "ERROR",
    code: "23505",
    constraint: "users_kind_email_key",
    table: "users",
  });
  return Object.assign(new Error(`Failed query: insert\nparams: ${SECRET}@contoh.test`), {
    query: 'insert into "users"',
    params: [`${SECRET}@contoh.test`],
    cause,
  });
}

describe("parseDsn (GlitchTip/Sentry)", () => {
  it("menyusun endpoint envelope, termasuk DSN dengan prefix path", () => {
    expect(parseDsn("https://kunci@glitchtip.kapdh.or.id/3")).toEqual({
      envelopeUrl: "https://glitchtip.kapdh.or.id/api/3/envelope/",
      publicKey: "kunci",
      projectId: "3",
    });
    expect(parseDsn("http://k@127.0.0.1:8000/sentry/12").envelopeUrl).toBe(
      "http://127.0.0.1:8000/sentry/api/12/envelope/",
    );
  });

  it.each(["bukan-url", "https://glitchtip.kapdh.or.id/3", "https://k@host/proyek", "ftp://k@host/3"])(
    "menolak DSN tidak sah %j tanpa mencetak kunci",
    (dsn) => {
      expect(() => parseDsn(dsn)).toThrow(/SENTRY_DSN/);
    },
  );

  it("errorTrackingFromEnv: kosong = nonaktif; lingkungan bawaan NODE_ENV", () => {
    expect(errorTrackingFromEnv({ NODE_ENV: "production" })).toBeUndefined();
    expect(
      errorTrackingFromEnv({ NODE_ENV: "staging", SENTRY_DSN: "https://k@h/1", SENTRY_RELEASE: "v1" }),
    ).toMatchObject({ dsn: "https://k@h/1", environment: "staging", release: "v1" });
  });
});

describe("ErrorTrackerStream lewat logger (PRD 7.1, N-14)", () => {
  it("hanya level error/fatal yang dikirim; event berisi tipe, kode, frame dan request_id tanpa pesan galat atau field lain", async () => {
    const { calls, fetchImpl } = recorder();
    const tracker = new ErrorTrackerStream({
      dsn: "https://kuncipublik@glitchtip.test/9",
      environment: "staging",
      release: "api:v1",
      fetchImpl,
    });
    const logger = createRootLogger({
      level: "info",
      service: "kapdh-api",
      destination: quiet(),
      errorTracking: tracker,
    });
    logger.info({ email: `${SECRET}@contoh.test` }, "info biasa");
    logger.warn("peringatan");
    logger.error(
      {
        error: safeError(drizzleError()),
        request_id: "req-123",
        module: "AuthService",
        email: `${SECRET}@contoh.test`,
        password: SECRET,
        body: { note: SECRET },
      },
      "galat tak tertangani",
    );
    await tracker.flush();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://glitchtip.test/api/9/envelope/");
    expect(call!.headers["x-sentry-auth"]).toContain("sentry_key=kuncipublik");
    expect(call!.headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(call!.body).not.toContain(SECRET);
    const event = eventOf(call!.body);
    expect(event).toMatchObject({
      level: "error",
      environment: "staging",
      release: "api:v1",
      message: { formatted: "galat tak tertangani" },
      logger: "kapdh-api",
    });
    expect(event.tags).toMatchObject({
      service: "kapdh-api",
      module: "AuthService",
      error_code: "23505",
      constraint: "users_kind_email_key",
      table: "users",
      request_id: "req-123",
    });
    const exception = (event.exception as { values: { type: string; stacktrace?: { frames: unknown[] } }[] })
      .values[0]!;
    expect(exception.type).toBe("DrizzleQueryError");
    expect(exception.stacktrace?.frames.length).toBeGreaterThan(0);
    expect(Object.keys(event).sort()).toEqual(
      [
        "environment",
        "event_id",
        "exception",
        "fingerprint",
        "level",
        "logger",
        "message",
        "platform",
        "release",
        "server_name",
        "tags",
        "timestamp",
      ].sort(),
    );
  });

  it("batas laju per menit: kelebihan dibuang dan dihitung; kegagalan kirim tidak melempar", async () => {
    const { calls, fetchImpl } = recorder();
    const tracker = new ErrorTrackerStream({
      dsn: "https://k@glitchtip.test/1",
      environment: "test",
      maxPerMinute: 2,
      fetchImpl,
    });
    const logger = createRootLogger({
      level: "info",
      service: "kapdh-worker",
      destination: quiet(),
      errorTracking: tracker,
    });
    for (let i = 0; i < 4; i++) logger.error({ error: safeError(new Error(SECRET)) }, "job terjadwal gagal");
    await tracker.flush();
    expect(calls).toHaveLength(2);
    expect(tracker.dropped).toBe(2);

    const failing = new ErrorTrackerStream({
      dsn: "https://k@glitchtip.test/1",
      environment: "test",
      fetchImpl: (async () => {
        throw new Error("jaringan putus");
      }) as typeof fetch,
    });
    const logger2 = createRootLogger({
      level: "info",
      service: "kapdh-api",
      destination: quiet(),
      errorTracking: failing,
    });
    expect(() => logger2.fatal({ error: safeError(new Error("x")) }, "galat fatal")).not.toThrow();
    await failing.flush();
    expect(failing.failed).toBe(1);
  });

  it("mengirim envelope HTTP sungguhan ke server kompatibel GlitchTip", async () => {
    const received: { url?: string; auth?: string; body: string }[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        received.push({ url: req.url, auth: String(req.headers["x-sentry-auth"]), body });
        res.writeHead(200, { "content-type": "application/json" }).end('{"id":"ok"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const tracker = new ErrorTrackerStream({
        dsn: `http://kunci@127.0.0.1:${port}/7`,
        environment: "test",
      });
      const logger = createRootLogger({
        level: "info",
        service: "kapdh-api",
        destination: quiet(),
        errorTracking: tracker,
      });
      logger.error({ error: safeError(new TypeError(SECRET)) }, "galat tak tertangani");
      await tracker.flush();
      expect(received).toHaveLength(1);
      expect(received[0]!.url).toBe("/api/7/envelope/");
      expect(received[0]!.auth).toContain("sentry_key=kunci");
      expect(received[0]!.body).not.toContain(SECRET);
      expect((eventOf(received[0]!.body).exception as { values: { type: string }[] }).values[0]!.type).toBe(
        "TypeError",
      );
      expect(tracker.failed).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
