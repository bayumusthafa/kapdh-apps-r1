import "reflect-metadata";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { FcmPushSender, type PushMessage } from "../../src/core/adapters/push.js";
import { commitAwareDb } from "../../src/core/db/tx.js";
import type { Db } from "../../src/core/db/types.js";
import { JobRunner } from "../../src/core/jobs/job-runner.js";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { createTestDatabase, type TestApp, TestClock, testEnv } from "../support/test-app.js";
import { deliveryOf, fcmToken, notify, registerDeviceOk, tokenRow } from "./support.js";

/**
 * FcmPushSender ("FcmPushProvider", F-13, R5) diuji terhadap server HTTP tiruan LOKAL (127.0.0.1, tanpa jaringan nyata):
 * pertukaran JWT akun layanan → token OAuth, payload HTTP v1, kelas galat per respons nyata, Retry-After, batas waktu,
 * lalu jalur penuh prosesor pengiriman → FCM tiruan.
 */

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SERVICE_ACCOUNT = JSON.stringify({
  client_email: "push@kapdh-uji.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
const PROJECT = "kapdh-uji";

interface Recorded {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

type Reply = {
  status: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  hang?: boolean;
};

let server: Server;
let baseUrl: string;
const requests: Recorded[] = [];
let tokenReplies: Reply[] = [];
let sendReplies: Reply[] = [];
let tokenCounter = 0;
let messageCounter = 0;
const hanging: ServerResponse[] = [];

function respond(res: ServerResponse, reply: Reply) {
  if (reply.hang) {
    hanging.push(res);
    return;
  }
  res.writeHead(reply.status, {
    "content-type": reply.raw !== undefined ? "text/html" : "application/json",
    ...reply.headers,
  });
  res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      if (req.url === "/token") {
        respond(
          res,
          tokenReplies.shift() ?? {
            status: 200,
            body: { access_token: `akses-${++tokenCounter}`, expires_in: 3600, token_type: "Bearer" },
          },
        );
        return;
      }
      if (req.url === `/v1/projects/${PROJECT}/messages:send`) {
        respond(
          res,
          sendReplies.shift() ?? {
            status: 200,
            body: { name: `projects/${PROJECT}/messages/${++messageCounter}` },
          },
        );
        return;
      }
      respond(res, { status: 404, body: { error: { status: "NOT_FOUND" } } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  requests.length = 0;
  tokenReplies = [];
  sendReplies = [];
});
afterAll(async () => {
  for (const res of hanging) res.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sender(timeoutMs = 2_000) {
  return new FcmPushSender(PROJECT, SERVICE_ACCOUNT, undefined, timeoutMs, {
    tokenUrl: `${baseUrl}/token`,
    apiBaseUrl: baseUrl,
  });
}

const message: PushMessage = {
  token: "token-perangkat-uji",
  platform: "ios",
  title: "Pembayaran disetujui",
  body: "KTA Anda aktif.",
  data: { notification_id: "0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f", category: "payment", route: "/payments" },
  collapseKey: "0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f",
};

const sends = () => requests.filter((r) => r.path.endsWith("/messages:send"));
const tokenRequests = () => requests.filter((r) => r.path === "/token");

describe("FcmPushSender terhadap endpoint HTTP tiruan (FCM HTTP v1)", () => {
  it("JWT akun layanan RS256 → token OAuth (di-cache, sekali untuk kiriman paralel) → messages:send dengan payload notification+data", async () => {
    const fcm = sender();
    const results = await Promise.all([fcm.send(message), fcm.send(message), fcm.send(message)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await fcm.send(message)).toMatchObject({ ok: true });
    expect(tokenRequests()).toHaveLength(1);
    const form = new URLSearchParams(tokenRequests()[0]!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion")!;
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const claims = decodeJwt(assertion);
    expect(claims).toMatchObject({
      iss: "push@kapdh-uji.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
    expect(claims.exp! - claims.iat!).toBe(3600);

    expect(sends()).toHaveLength(4);
    const send = sends()[0]!;
    expect(send.headers.authorization).toMatch(/^Bearer akses-\d+$/);
    expect(send.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(send.body)).toEqual({
      message: {
        token: "token-perangkat-uji",
        notification: { title: "Pembayaran disetujui", body: "KTA Anda aktif." },
        data: message.data,
        android: {
          priority: "high",
          collapse_key: message.collapseKey,
          notification: { tag: message.collapseKey },
        },
        apns: {
          headers: { "apns-priority": "10", "apns-collapse-id": message.collapseKey },
          payload: { aps: { sound: "default" } },
        },
      },
    });
  });

  it("AC F13-4: respons galat FCM nyata → kelas galat, penonaktifan token, retry dan Retry-After", async () => {
    const fcm = sender();
    const fcmError = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
      status,
      body: {
        error: {
          code: status,
          status: code,
          message: "galat",
          details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code }],
          ...extra,
        },
      },
    });
    sendReplies = [
      fcmError(404, "UNREGISTERED"),
      {
        status: 400,
        body: {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "The registration token is not a valid FCM registration token",
            details: [
              {
                "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                errorCode: "INVALID_ARGUMENT",
              },
              {
                "@type": "type.googleapis.com/google.rpc.BadRequest",
                fieldViolations: [{ field: "message.token", description: "Invalid registration token" }],
              },
            ],
          },
        },
      },
      {
        status: 400,
        body: {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "Invalid value at 'message.data[0].value'",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.BadRequest",
                fieldViolations: [{ field: "message.data[0].value" }],
              },
            ],
          },
        },
      },
      { ...fcmError(429, "QUOTA_EXCEEDED"), headers: { "retry-after": "45" } },
      { status: 503, raw: "<html>Service Unavailable</html>" },
      fcmError(500, "INTERNAL"),
      fcmError(403, "SENDER_ID_MISMATCH"),
      fcmError(401, "THIRD_PARTY_AUTH_ERROR"),
    ];
    const outcomes = [];
    for (let i = 0; i < 8; i++) outcomes.push(await fcm.send(message));
    expect(outcomes).toEqual([
      { ok: false, errorClass: "unregistered", retryable: false, deactivateToken: true },
      { ok: false, errorClass: "invalid_argument", retryable: false, deactivateToken: true },
      { ok: false, errorClass: "invalid_argument", retryable: false, deactivateToken: false },
      {
        ok: false,
        errorClass: "quota_exceeded",
        retryable: true,
        deactivateToken: false,
        retryAfterSeconds: 45,
      },
      { ok: false, errorClass: "unavailable", retryable: true, deactivateToken: false },
      { ok: false, errorClass: "internal", retryable: true, deactivateToken: false },
      { ok: false, errorClass: "sender_mismatch", retryable: false, deactivateToken: true },
      { ok: false, errorClass: "auth_error", retryable: false, deactivateToken: false },
    ]);
    // 401 membuang token OAuth yang di-cache: kiriman berikutnya menukar ulang.
    const before = tokenRequests().length;
    expect(await fcm.send(message)).toMatchObject({ ok: true });
    expect(tokenRequests().length).toBe(before + 1);
  });

  it("AC F13-4: OAuth gagal → auth_error dapat dicoba ulang; server tidak merespons → timeout jaringan dapat dicoba ulang", async () => {
    tokenReplies = [{ status: 400, body: { error: "invalid_grant" } }];
    expect(await sender().send(message)).toEqual({
      ok: false,
      errorClass: "auth_error",
      retryable: true,
      deactivateToken: false,
    });
    sendReplies = [{ status: 200, hang: true }];
    const started = Date.now();
    expect(await sender(300).send(message)).toEqual({
      ok: false,
      errorClass: "network",
      retryable: true,
      deactivateToken: false,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    const refused = new FcmPushSender(PROJECT, SERVICE_ACCOUNT, undefined, 1_000, {
      tokenUrl: `${baseUrl}/token`,
      apiBaseUrl: "http://127.0.0.1:1",
    });
    expect(await refused.send(message)).toMatchObject({ ok: false, errorClass: "network", retryable: true });
  });
});

describe("Prosesor pengiriman → FCM tiruan (F-13, AC F13-1, F13-4)", () => {
  let app: NestFastifyApplication;
  let t: TestApp;

  beforeAll(async () => {
    const { pg, db: raw } = await createTestDatabase();
    const db = commitAwareDb(raw as Db);
    const clock = new TestClock();
    const mailer = new MemoryMailer();
    app = await createApp(
      {
        env: testEnv,
        db,
        mailer,
        clock,
        push: sender(),
        storage: new MemoryDriver(),
        redis: null,
      },
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const close = app.close.bind(app);
    app.close = async () => {
      await close();
      await pg.close();
    };
    t = { app, db, clock, mailer, jobs: app.get(JobRunner) } as unknown as TestApp;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("AC F13-1, F13-4: pengiriman diterima FCM (provider_message_id), lalu UNREGISTERED menonaktifkan token perangkat", async () => {
    const member = await createAlumni(t);
    const session = await signInAlumni(t, member);
    const token = fcmToken("fcm-nyata");
    await registerDeviceOk(t, session.accessToken, token);

    const first = await notify(t, member.userId, {
      category: "membership",
      route: "/kta",
      body: "KTA aktif.",
    });
    await t.jobs.drainOutbox();
    const sent = await deliveryOf(t, first.id, "push");
    expect(sent).toMatchObject({ status: "sent", providerStatus: "accepted" });
    expect(sent.providerMessageId).toMatch(new RegExp(`^projects/${PROJECT}/messages/\\d+$`));
    const payload = JSON.parse(sends().at(-1)!.body) as {
      message: { token: string; data: Record<string, string> };
    };
    expect(payload.message.token).toBe(token);
    expect(payload.message.data).toEqual({
      notification_id: first.id,
      category: "membership",
      route: "/kta",
      deep_link: "kapdh://app/kta",
    });

    sendReplies = [
      {
        status: 404,
        body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
      },
    ];
    const second = await notify(t, member.userId, { category: "membership", route: "/kta" });
    await t.jobs.drainOutbox();
    expect(await deliveryOf(t, second.id, "push")).toMatchObject({
      status: "failed",
      errorClass: "UNREGISTERED",
    });
    expect((await tokenRow(t, token))!.revokedAt).not.toBeNull();
  });
});
