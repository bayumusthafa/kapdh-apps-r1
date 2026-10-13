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
 * Kelas galat FCM (ARCHITECTURE §4.8 `notifications.deliver`): `unregistered`/`sender_mismatch` (dan
 * `invalid_argument` untuk token tidak sah) menonaktifkan token, `quota_exceeded`/`unavailable`/`internal`/`network`
 * (dan `auth_error` karena token akses OAuth kedaluwarsa/gagal ditukar) dicoba ulang, sisanya permanen untuk pesan ini.
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

export interface PushSendOptions {
  /**
   * Pembatalan dari pemanggil (batas waktu percobaan pengiriman, F-13): permintaan HTTP yang sedang berjalan DIPUTUS,
   * bukan dibiarkan selesai di latar belakang, lalu hasilnya `network` yang dapat dicoba ulang.
   */
  signal?: AbortSignal;
}

export interface PushSender {
  /** false bila FCM belum dikonfigurasi (development/test/staging tanpa proyek FCM). */
  readonly enabled: boolean;
  send(message: PushMessage, options?: PushSendOptions): Promise<PushResult>;
}

/** Push nonaktif: notifikasi tetap tercatat di inbox (F-13), hanya kanal push yang dilewati. */
export class DisabledPush implements PushSender {
  readonly enabled = false;
  async send(): Promise<PushResult> {
    return { ok: false, errorClass: "disabled", retryable: false, deactivateToken: false };
  }
}

export interface ClassifyFcmOptions {
  /**
   * INVALID_ARGUMENT karena token registrasi tidak sah (BadRequest fieldViolations `message.token`): token
   * dinonaktifkan seperti UNREGISTERED (R5, AC F13-4). INVALID_ARGUMENT karena payload tetap gagal permanen untuk pesan
   * itu tanpa menonaktifkan token.
   */
  invalidToken?: boolean;
}

export function classifyFcmError(
  httpStatus: number,
  errorCode: string | undefined,
  options: ClassifyFcmOptions = {},
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
      return fail("invalid_argument", false, options.invalidToken === true);
    case "QUOTA_EXCEEDED":
      return fail("quota_exceeded", true);
    case "UNAVAILABLE":
      return fail("unavailable", true);
    case "INTERNAL":
      return fail("internal", true);
    case "THIRD_PARTY_AUTH_ERROR":
      // Kredensial APNs/pihak ketiga salah: perlu perbaikan konfigurasi oleh operator.
      return fail("auth_error", false);
  }
  if (httpStatus === 404) return fail("unregistered", false, true);
  if (httpStatus === 429) return fail("quota_exceeded", true);
  // 401 UNAUTHENTICATED: token akses OAuth ditolak (kedaluwarsa/dicabut). Pengirim membuang token cache sehingga
  // percobaan berikutnya menukar token baru; dicoba ulang dengan backoff, bukan langsung gagal (F-13).
  if (httpStatus === 401) return fail("auth_error", true);
  if (httpStatus === 403) return fail("auth_error", false);
  if (httpStatus >= 500) return fail("unavailable", true);
  return fail("invalid_argument", false, options.invalidToken === true);
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_API_BASE = "https://fcm.googleapis.com";

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/**
 * Titik akhir FCM yang dapat diganti, HANYA untuk uji terhadap server HTTP tiruan lokal (tanpa jaringan nyata).
 * Audience JWT akun layanan tetap `https://oauth2.googleapis.com/token` sesuai persyaratan Google.
 */
export interface FcmEndpoints {
  tokenUrl?: string;
  /** Basis URL API FCM; pesan dikirim ke `<base>/v1/projects/<project>/messages:send`. */
  apiBaseUrl?: string;
}

interface FcmErrorBody {
  name?: string;
  error?: {
    status?: string;
    message?: string;
    details?: { "@type"?: string; errorCode?: string; fieldViolations?: { field?: string }[] }[];
  };
}

/** INVALID_ARGUMENT yang menunjuk token registrasi (bukan payload): fieldViolations `message.token` atau pesan FCM. */
function isInvalidTokenError(body: FcmErrorBody): boolean {
  const violations = (body.error?.details ?? []).flatMap((detail) => detail.fieldViolations ?? []);
  if (violations.some((violation) => /(^|\.)token$/.test(violation.field ?? ""))) return true;
  return /registration token/i.test(body.error?.message ?? "");
}

/** Alasan pembatalan sebagai Error (AbortSignal.reason bisa berupa nilai apa pun). */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Permintaan FCM dibatalkan");
}

/**
 * Menolak segera saat `signal` dibatalkan. Jaring pengaman untuk implementasi fetch yang mengabaikan sinyal; fetch
 * bawaan Node (undici) sendiri sudah memutus koneksi dan pembacaan body saat sinyal dibatalkan.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

interface FcmHttpResponse {
  status: number;
  retryAfter: string | null;
  body: unknown;
}

/**
 * FCM HTTP v1 dengan OAuth akun layanan (JWT RS256 ditandatangani jose), tanpa SDK Firebase penuh ("FcmPushProvider"
 * F-13). Token akses di-cache sampai 60 detik sebelum kedaluwarsa dan diambil sekali untuk pengiriman paralel. Setiap
 * panggilan HTTP (termasuk membaca body respons) dibatasi `timeoutMs` dengan AbortController sehingga permintaan yang
 * macet benar-benar DIPUTUS, bukan dibiarkan selesai di latar belakang; pembatalan pemanggil (`options.signal`) memutus
 * permintaan messages:send dengan cara yang sama. Galat dikelompokkan sesuai kode FCM (R5): UNREGISTERED/
 * SENDER_ID_MISMATCH dan INVALID_ARGUMENT token menonaktifkan token, 429/5xx/jaringan dicoba ulang (AC F13-4).
 */
export class FcmPushSender implements PushSender {
  readonly enabled = true;
  private readonly account: FcmServiceAccount;
  private accessToken: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;
  private readonly tokenUrl: string;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly projectId: string,
    serviceAccountJson: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    private readonly timeoutMs = 10_000,
    endpoints: FcmEndpoints = {},
  ) {
    this.account = parseFcmServiceAccount(serviceAccountJson);
    this.tokenUrl = endpoints.tokenUrl ?? TOKEN_URL;
    this.apiBaseUrl = (endpoints.apiBaseUrl ?? FCM_API_BASE).replace(/\/+$/, "");
  }

  private async token(): Promise<string> {
    // Waktu nyata (bukan Clock aplikasi): Google memvalidasi iat/exp terhadap jam dunia.
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > Date.now()) return this.accessToken.value;
    // Pengiriman paralel berbagi satu permintaan token (tidak membanjiri endpoint OAuth).
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    const nowMs = Date.now();
    const key = await importPKCS8(this.account.private_key, "RS256");
    const iat = Math.floor(nowMs / 1000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.account.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(key);
    // Dipakai bersama pengiriman paralel: hanya dibatasi timeoutMs, tidak ikut dibatalkan sinyal satu pemanggil.
    const res = await this.request(
      this.tokenUrl,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      },
      "Batas waktu OAuth FCM habis",
    );
    const body = res.body as { access_token?: string; expires_in?: number };
    if (res.status !== 200 || !body.access_token) throw new Error(`OAuth FCM gagal (HTTP ${res.status})`);
    this.accessToken = { value: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /**
   * Satu permintaan HTTP beserta pembacaan body-nya dengan batas waktu keras `timeoutMs` dan pembatalan pemanggil;
   * keduanya membatalkan AbortController yang diteruskan ke fetch sehingga koneksi diputus.
   */
  private async request(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
    timeoutLabel: string,
    signal?: AbortSignal,
  ): Promise<FcmHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(timeoutLabel)), this.timeoutMs);
    timer.unref();
    const onAbort = () => controller.abort(signal ? abortReason(signal) : undefined);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await untilAborted(this.fetchImpl(url, { ...init, signal: controller.signal }), controller.signal);
      const body = await untilAborted(
        res.json().catch(() => ({})),
        controller.signal,
      );
      // Body yang gagal dibaca karena pembatalan bukan "body kosong": tetap diperlakukan sebagai pembatalan.
      if (controller.signal.aborted) throw abortReason(controller.signal);
      return { status: res.status, retryAfter: res.headers.get("retry-after"), body };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async send(message: PushMessage, options: PushSendOptions = {}): Promise<PushResult> {
    const { signal } = options;
    const networkFailure = { ok: false, errorClass: "network", retryable: true, deactivateToken: false } as const;
    if (signal?.aborted) return networkFailure;
    let accessToken: string;
    try {
      accessToken = await (signal ? untilAborted(this.token(), signal) : this.token());
    } catch {
      if (signal?.aborted) return networkFailure;
      return { ok: false, errorClass: "auth_error", retryable: true, deactivateToken: false };
    }
    const payload = {
      message: {
        token: message.token,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: {
          priority: "high",
          ...(message.collapseKey
            ? { collapse_key: message.collapseKey, notification: { tag: message.collapseKey } }
            : {}),
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
      const res = await this.request(
        `${this.apiBaseUrl}/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Batas waktu FCM habis",
        signal,
      );
      const body = (res.body ?? {}) as FcmErrorBody;
      if (res.status === 200 && body.name) return { ok: true, messageId: body.name };
      if (res.status === 401) this.accessToken = null;
      const errorCode = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status;
      const result = classifyFcmError(res.status, errorCode, { invalidToken: isInvalidTokenError(body) });
      const retryAfter = Number(res.retryAfter);
      return Number.isFinite(retryAfter) && retryAfter > 0
        ? { ...result, retryAfterSeconds: retryAfter }
        : result;
    } catch {
      return networkFailure;
    }
  }
}

/** Memilih pengirim push dari env: FCM bila dikonfigurasi, selain itu nonaktif (config mewajibkan FCM di production). */
export function createPushSender(env: {
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
}): PushSender {
  if (env.FCM_PROJECT_ID && env.FCM_SERVICE_ACCOUNT_JSON)
    return new FcmPushSender(env.FCM_PROJECT_ID, env.FCM_SERVICE_ACCOUNT_JSON);
  return new DisabledPush();
}
