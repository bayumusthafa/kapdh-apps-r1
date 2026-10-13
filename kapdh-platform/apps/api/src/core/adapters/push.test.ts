import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { classifyFcmError, createPushSender, DisabledPush, FcmPushSender, type PushMessage } from "./push.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  client_email: "push@kapdh-uji.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

const message: PushMessage = {
  token: "token-perangkat-uji",
  platform: "android",
  title: "Pembayaran disetujui",
  body: "KTA Anda aktif.",
  data: { route: "/payments/0192f0d2-0000-7000-8000-000000000001" },
  collapseKey: "payment",
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(responses: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: Call[] = [];
  const impl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const isToken = url.startsWith("https://oauth2.googleapis.com/token");
    const next = isToken
      ? { status: 200, body: { access_token: "akses-uji", expires_in: 3600 } }
      : responses.shift();
    if (!next) throw new Error("tidak ada respons tiruan");
    return {
      status: next.status,
      headers: {
        get: (name: string) => ("headers" in next ? next.headers?.[name.toLowerCase()] : undefined) ?? null,
      },
      json: async () => next.body,
    };
  };
  return { impl, calls };
}

describe("klasifikasi galat FCM (ARCHITECTURE §4.8, F-13)", () => {
  it.each([
    [404, "UNREGISTERED", "unregistered", false, true],
    [403, "SENDER_ID_MISMATCH", "sender_mismatch", false, true],
    [400, "INVALID_ARGUMENT", "invalid_argument", false, false],
    [429, "QUOTA_EXCEEDED", "quota_exceeded", true, false],
    [503, "UNAVAILABLE", "unavailable", true, false],
    [500, "INTERNAL", "internal", true, false],
    [401, "THIRD_PARTY_AUTH_ERROR", "auth_error", false, false],
    [404, undefined, "unregistered", false, true],
    [502, undefined, "unavailable", true, false],
  ] as const)("HTTP %i %s → %s", (status, code, errorClass, retryable, deactivate) => {
    expect(classifyFcmError(status, code)).toEqual({
      ok: false,
      errorClass,
      retryable,
      deactivateToken: deactivate,
    });
  });
});

describe("FcmPushSender (FCM HTTP v1)", () => {
  it("menukar JWT akun layanan menjadi token akses (di-cache) lalu mengirim pesan dengan collapse key", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { name: "projects/kapdh-uji/messages/1" } },
      { status: 200, body: { name: "projects/kapdh-uji/messages/2" } },
    ]);
    const sender = new FcmPushSender("kapdh-uji", serviceAccount, impl);
    expect(await sender.send(message)).toEqual({ ok: true, messageId: "projects/kapdh-uji/messages/1" });
    expect(await sender.send(message)).toEqual({ ok: true, messageId: "projects/kapdh-uji/messages/2" });
    const tokenCalls = calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token"));
    expect(tokenCalls).toHaveLength(1);
    const assertion = new URLSearchParams(tokenCalls[0]!.body).get("assertion")!;
    expect(decodeJwt(assertion)).toMatchObject({
      iss: "push@kapdh-uji.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
    const send = calls.find((c) => c.url.includes("/messages:send"))!;
    expect(send.url).toBe("https://fcm.googleapis.com/v1/projects/kapdh-uji/messages:send");
    expect(send.headers.authorization).toBe("Bearer akses-uji");
    expect(JSON.parse(send.body)).toMatchObject({
      message: {
        token: "token-perangkat-uji",
        notification: { title: "Pembayaran disetujui", body: "KTA Anda aktif." },
        data: message.data,
        android: { collapse_key: "payment" },
        apns: { headers: { "apns-collapse-id": "payment" } },
      },
    });
  });

  it("token tidak terdaftar menonaktifkan token; kuota habis dicoba ulang dengan Retry-After", async () => {
    const { impl } = fakeFetch([
      { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } },
      { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } }, headers: { "retry-after": "30" } },
    ]);
    const sender = new FcmPushSender("kapdh-uji", serviceAccount, impl);
    expect(await sender.send(message)).toMatchObject({
      ok: false,
      errorClass: "unregistered",
      deactivateToken: true,
    });
    expect(await sender.send(message)).toMatchObject({
      ok: false,
      errorClass: "quota_exceeded",
      retryable: true,
      retryAfterSeconds: 30,
    });
  });

  it("galat jaringan menjadi kelas network yang dapat dicoba ulang", async () => {
    const failing = async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token"))
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({ access_token: "a", expires_in: 3600 }),
        };
      throw new Error("ECONNRESET");
    };
    const sender = new FcmPushSender("kapdh-uji", serviceAccount, failing);
    expect(await sender.send(message)).toEqual({
      ok: false,
      errorClass: "network",
      retryable: true,
      deactivateToken: false,
    });
  });

  it("tanpa konfigurasi FCM, push nonaktif (inbox tetap ditulis, F-13)", async () => {
    const sender = createPushSender({});
    expect(sender).toBeInstanceOf(DisabledPush);
    expect(sender.enabled).toBe(false);
    expect(await sender.send(message)).toMatchObject({ ok: false, errorClass: "disabled", retryable: false });
    expect(
      createPushSender({ FCM_PROJECT_ID: "kapdh-uji", FCM_SERVICE_ACCOUNT_JSON: serviceAccount }).enabled,
    ).toBe(true);
  });
});
