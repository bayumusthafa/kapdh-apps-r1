import { type FcmServiceAccount, parseFcmServiceAccount } from "@kapdh/config";
import { importPKCS8, SignJWT } from "jose";

/**
 * Adapter push FCM (Firebase hanya untuk FCM, ARCHITECTURE §2.4; F-13). Payload layar kunci tidak pernah memuat isi
 * chat, data bukti bayar, atau kontak (ARCHITECTURE §4.7). Token perangkat tidak pernah dicatat (ARCHITECTURE §2.3).
 */
export interface PushMessage {
  /** Token FCM perangkat tujuan. */
  token: string;
  platform: "android" | "ios";
  title: string;
  body: string;
  /** Data aplikasi (string saja, batas FCM), misalnya `route` deep link `/payments/<id>`. */
  data: Record<string, string>;
  /** Pesan sejenis menggantikan yang lama di baki notifikasi (mis. per room chat). */
  collapseKey?: string;
}

/**
 * Kelas galat FCM (ARCHITECTURE §4.8 `notifications.deliver`): `unregistered`/`sender_mismatch` menonaktifkan token,
 * `quota_exceeded`/`unavailable`/`internal`/`network` dicoba ulang, sisanya permanen untuk pesan ini.
 */
export type PushErrorClass =
  | "unregistered"
  | "invalid_argument"
  | "sender_mismatch"
  | "quota_exceeded"
  | "unavailable"
  | "internal"
  | "auth_error"
  | "network"
  | "disabled";

export type PushResult =
  | { ok: true; messageId: string }
  | {
      ok: false;
      errorClass: PushErrorClass;
      retryable: boolean;
      deactivateToken: boolean;
      /** Detik tunggu yang disarankan FCM (Retry-After), bila ada. */
      retryAfterSeconds?: number;
    };

export interface PushSender {
  /** false bila FCM belum dikonfigurasi (development/test/staging tanpa proyek FCM). */
  readonly enabled: boolean;
  send(message: PushMessage): Promise<PushResult>;
}

/** Push nonaktif: notifikasi tetap tercatat di inbox (F-13), hanya kanal push yang dilewati. */
export class DisabledPush implements PushSender {
  readonly enabled = false;
  async send(): Promise<PushResult> {
    return { ok: false, errorClass: "disabled", retryable: false, deactivateToken: false };
  }
}

export function classifyFcmError(
  httpStatus: number,
  errorCode: string | undefined,
): Exclude<PushResult, { ok: true }> {
  const fail = (errorClass: PushErrorClass, retryable: boolean, deactivateToken = false) => ({
    ok: false as const,
    errorClass,
    retryable,
    deactivateToken,
  });
  switch (errorCode) {
    case "UNREGISTERED":
      return fail("unregistered", false, true);
    case "SENDER_ID_MISMATCH":
      return fail("sender_mismatch", false, true);
    case "INVALID_ARGUMENT":
      return fail("invalid_argument", false);
    case "QUOTA_EXCEEDED":
      return fail("quota_exceeded", true);
    case "UNAVAILABLE":
      return fail("unavailable", true);
    case "INTERNAL":
      return fail("internal", true);
    case "THIRD_PARTY_AUTH_ERROR":
      return fail("auth_error", false);
  }
  if (httpStatus === 404) return fail("unregistered", false, true);
  if (httpStatus === 429) return fail("quota_exceeded", true);
  if (httpStatus === 401 || httpStatus === 403) return fail("auth_error", false);
  if (httpStatus >= 500) return fail("unavailable", true);
  return fail("invalid_argument", false);
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/**
 * FCM HTTP v1 dengan OAuth akun layanan (JWT RS256 ditandatangani jose), tanpa SDK Firebase penuh. Token akses
 * di-cache sampai 60 detik sebelum kedaluwarsa.
 */
export class FcmPushSender implements PushSender {
  readonly enabled = true;
  private readonly account: FcmServiceAccount;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly projectId: string,
    serviceAccountJson: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    private readonly timeoutMs = 10_000,
  ) {
    this.account = parseFcmServiceAccount(serviceAccountJson);
  }

  private async token(): Promise<string> {
    // Waktu nyata (bukan Clock aplikasi): Google memvalidasi iat/exp terhadap jam dunia.
    const nowMs = Date.now();
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > nowMs) return this.accessToken.value;
    const key = await importPKCS8(this.account.private_key, "RS256");
    const iat = Math.floor(nowMs / 1000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.account.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(key);
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (res.status !== 200 || !body.access_token) throw new Error(`OAuth FCM gagal (HTTP ${res.status})`);
    this.accessToken = { value: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async send(message: PushMessage): Promise<PushResult> {
    let accessToken: string;
    try {
      accessToken = await this.token();
    } catch {
      return { ok: false, errorClass: "auth_error", retryable: true, deactivateToken: false };
    }
    const payload = {
      message: {
        token: message.token,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: {
          priority: "high",
          ...(message.collapseKey ? { collapse_key: message.collapseKey } : {}),
        },
        apns: {
          headers: {
            "apns-priority": "10",
            ...(message.collapseKey ? { "apns-collapse-id": message.collapseKey.slice(0, 64) } : {}),
          },
          payload: { aps: { sound: "default" } },
        },
      },
    };
    try {
      const res = await Promise.race([
        this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout FCM")), this.timeoutMs).unref(),
        ),
      ]);
      const body = (await res.json().catch(() => ({}))) as {
        name?: string;
        error?: { status?: string; details?: { errorCode?: string }[] };
      };
      if (res.status === 200 && body.name) return { ok: true, messageId: body.name };
      if (res.status === 401) this.accessToken = null;
      const errorCode = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status;
      const result = classifyFcmError(res.status, errorCode);
      const retryAfter = Number(res.headers.get("retry-after"));
      return Number.isFinite(retryAfter) && retryAfter > 0 ? { ...result, retryAfterSeconds: retryAfter } : result;
    } catch {
      return { ok: false, errorClass: "network", retryable: true, deactivateToken: false };
    }
  }
}

/** Memilih pengirim push dari env: FCM bila dikonfigurasi, selain itu nonaktif (config mewajibkan FCM di production). */
export function createPushSender(env: { FCM_PROJECT_ID?: string; FCM_SERVICE_ACCOUNT_JSON?: string }): PushSender {
  if (env.FCM_PROJECT_ID && env.FCM_SERVICE_ACCOUNT_JSON)
    return new FcmPushSender(env.FCM_PROJECT_ID, env.FCM_SERVICE_ACCOUNT_JSON);
  return new DisabledPush();
}
