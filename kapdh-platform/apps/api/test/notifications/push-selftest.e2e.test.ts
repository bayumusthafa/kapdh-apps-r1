import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DUMMY_FCM_TOKEN,
  maskEmail,
  PUSH_SELFTEST_EXIT,
  type PushSelftestDeps,
  runPushSelftestCommand,
  type TokenInput,
} from "../../src/cli/push-selftest-command.js";

/**
 * CLI uji mandiri push FCM (docs/runbooks/push-fcm.md) terhadap server OAuth/FCM tiruan LOKAL (127.0.0.1, tanpa
 * jaringan nyata), pola yang sama dengan fcm-provider.e2e.test.ts: token OAuth lewat jalur pengirim push, messages:send
 * dengan validate_only, tafsir status (400 token tidak sah/404 UNREGISTERED lulus; 400 tanpa token, 401/403/404
 * gagal; 5xx galat teknis), FCM_PROJECT_ID mentah yang hanya dicetak bila berbentuk Project ID, token dari stdin
 * (pipa dan TTY tanpa gema), dan keluaran yang tidak pernah memuat private key, token akses, atau token FCM.
 */

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PKCS1_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PROJECT = "kapdh-uji";
const CLIENT_EMAIL = "firebase-adminsdk-abc12@kapdh-uji.iam.gserviceaccount.com";
const KEY_ID = "0123456789abcdef0123456789abcdef01234567";
/** Baris base64 di tengah PEM: bagian kunci privat yang paling mungkin bocor bila dicetak. */
const PEM_BODY_LINES = PEM.split("\n").filter((line) => line.length > 0 && !line.startsWith("-----"));
const DEVICE_TOKEN = "cXk9-perangkat_UJI:APA91bRahasiaTokenPerangkatNyata0123456789abcdefghij";

function serviceAccount(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: PROJECT,
    private_key_id: KEY_ID,
    private_key: PEM,
    client_email: CLIENT_EMAIL,
    client_id: "123456789012345678901",
    token_uri: "https://oauth2.googleapis.com/token",
    ...overrides,
  });
}

interface Recorded {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

type Reply = { status: number; body?: unknown };

let server: Server;
let baseUrl: string;
const requests: Recorded[] = [];
let tokenReplies: Reply[] = [];
let sendReplies: Reply[] = [];
const issuedAccessTokens: string[] = [];

const INVALID_TOKEN_REPLY: Reply = {
  status: 400,
  body: {
    error: {
      code: 400,
      message: "The registration token is not a valid FCM registration token",
      status: "INVALID_ARGUMENT",
      details: [
        { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" },
      ],
    },
  },
};

function respond(res: ServerResponse, reply: Reply) {
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body ?? {}));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url === "/token") {
        const reply = tokenReplies.shift();
        if (reply) return respond(res, reply);
        const accessToken = `ya29.akses-rahasia-${issuedAccessTokens.length + 1}-${"x".repeat(40)}`;
        issuedAccessTokens.push(accessToken);
        return respond(res, {
          status: 200,
          body: { access_token: accessToken, expires_in: 3599, token_type: "Bearer" },
        });
      }
      if (/^\/v1\/projects\/[^/]+\/messages:send$/.test(req.url ?? ""))
        return respond(res, sendReplies.shift() ?? INVALID_TOKEN_REPLY);
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sends = () => requests.filter((r) => r.path.endsWith("/messages:send"));
const tokenRequests = () => requests.filter((r) => r.path === "/token");

interface RunOptions {
  env?: PushSelftestDeps["env"];
  stdin?: TokenInput;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

async function run(args: string[], options: RunOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPushSelftestCommand(args, {
    env: options.env ?? { FCM_PROJECT_ID: PROJECT, FCM_SERVICE_ACCOUNT_JSON: serviceAccount() },
    now: new Date("2026-10-18T03:00:00.000Z"),
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    stdin: options.stdin,
    timeoutMs: options.timeoutMs ?? 2_000,
    endpoints: { tokenUrl: `${baseUrl}/token`, apiBaseUrl: options.apiBaseUrl ?? baseUrl },
  });
  return { code, out: out.join(""), err: err.join(""), all: out.join("") + err.join("") };
}

/** Tidak ada private key (header PEM atau baris base64 mana pun), token akses, atau token perangkat di keluaran. */
function expectNoSecrets(text: string) {
  expect(text).not.toContain("PRIVATE KEY");
  for (const line of PEM_BODY_LINES) expect(text).not.toContain(line);
  for (const accessToken of issuedAccessTokens) expect(text).not.toContain(accessToken);
  expect(text).not.toContain("akses-rahasia");
  expect(text).not.toContain(DEVICE_TOKEN);
  expect(text).not.toContain("RahasiaTokenPerangkat");
  expect(text).not.toContain(CLIENT_EMAIL);
}

function pipeStdin(text: string): TokenInput {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

describe("uji mandiri push FCM: kredensial dan izin (validate_only, token dummy)", () => {
  it("400 INVALID_ARGUMENT untuk token dummy → LULUS (kode 0); OAuth lewat JWT pengirim push; validate_only selalu true", async () => {
    const r = await run([]);
    expect(r.code).toBe(PUSH_SELFTEST_EXIT.passed);
    expect(r.out).toContain("  FCM_PROJECT_ID: kapdh-uji");
    expect(r.out).toContain("  client_email: fir***@kapdh-uji.iam.gserviceaccount.com");
    expect(r.out).toContain("  private_key_id (8 karakter awal): 01234567");
    expect(r.out).toContain("  type = service_account: ya");
    expect(r.out).toContain("  project_id JSON = FCM_PROJECT_ID: ya");
    expect(r.out).toContain("  private_key PKCS8 terbaca: ya");
    expect(r.out).toContain("  oauth: ok\n");
    expect(r.out).toMatch(/ {2}fcm: ok, HTTP 400 INVALID_ARGUMENT untuk token dummy/);
    expect(r.out).toContain("LULUS: kredensial akun layanan dan izin FCM benar untuk proyek kapdh-uji.");
    expect(r.out).not.toContain("GAGAL");
    expect(r.err).toBe("");
    expectNoSecrets(r.all);

    // Jalur OAuth sama dengan FcmPushSender: JWT RS256 akun layanan, audience endpoint token Google, scope FCM.
    expect(tokenRequests()).toHaveLength(1);
    const assertion = new URLSearchParams(tokenRequests()[0]!.body).get("assertion")!;
    expect(decodeJwt(assertion)).toMatchObject({
      iss: CLIENT_EMAIL,
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
    expect(sends()).toHaveLength(1);
    const send = sends()[0]!;
    expect(send.path).toBe(`/v1/projects/${PROJECT}/messages:send`);
    expect(send.headers.authorization).toBe(`Bearer ${issuedAccessTokens.at(-1)}`);
    const payload = JSON.parse(send.body) as { validate_only: boolean; message: Record<string, unknown> };
    expect(payload.validate_only).toBe(true);
    expect(payload.message).toMatchObject({
      token: DUMMY_FCM_TOKEN,
      notification: { title: "Uji mandiri KAPDH" },
      android: { priority: "high" },
      apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
    });
  });

  it("404 UNREGISTERED (token tidak terdaftar) juga LULUS; 400 tanpa menyebut token → GAGAL (bukan bukti izin)", async () => {
    sendReplies = [
      {
        status: 404,
        body: { error: { code: 404, status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
      },
    ];
    const unregistered = await run([]);
    expect(unregistered.code).toBe(PUSH_SELFTEST_EXIT.passed);
    expect(unregistered.out).toContain("fcm: ok, HTTP 404 UNREGISTERED untuk token dummy");

    // fieldViolations message.token (bentuk lain respons token tidak sah) tetap LULUS.
    sendReplies = [
      {
        status: 400,
        body: {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "Request contains an invalid argument.",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.BadRequest",
                fieldViolations: [{ field: "message.token" }],
              },
            ],
          },
        },
      },
    ];
    const fieldViolation = await run([]);
    expect(fieldViolation.code).toBe(PUSH_SELFTEST_EXIT.passed);
    expect(fieldViolation.out).toContain("fcm: ok, HTTP 400 INVALID_ARGUMENT untuk token dummy");

    sendReplies = [
      {
        status: 400,
        body: {
          error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid value at 'message.data'" },
        },
      },
    ];
    const payloadRejected = await run([]);
    expect(payloadRejected.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(payloadRejected.out).toContain(
      "fcm: GAGAL, HTTP 400 INVALID_ARGUMENT: INVALID_ARGUMENT tidak menyebut token; tidak membuktikan izin FCM",
    );
    expect(payloadRejected.out).toContain("GAGAL: push FCM belum siap.");
    expect(payloadRejected.out).not.toContain("LULUS");
    // Pesan bebas FCM tidak dicetak.
    expect(payloadRejected.out).not.toContain("message.data");
  });

  it("401 UNAUTHENTICATED → GAGAL (kode 1): kredensial ditolak", async () => {
    sendReplies = [
      {
        status: 401,
        body: {
          error: { code: 401, status: "UNAUTHENTICATED", message: "Request had invalid authentication" },
        },
      },
    ];
    const r = await run([]);
    expect(r.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(r.out).toContain("  oauth: ok\n");
    expect(r.out).toContain("fcm: GAGAL, HTTP 401 UNAUTHENTICATED: kredensial ditolak FCM");
    expect(r.out).toContain("GAGAL: push FCM belum siap.");
    expect(r.out).not.toContain("LULUS");
    expectNoSecrets(r.all);
  });

  it("403 → GAGAL: izin IAM kurang; 403 SERVICE_DISABLED → API FCM (V1) belum aktif", async () => {
    sendReplies = [
      {
        status: 403,
        body: {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "Permission 'cloudmessaging.messages.create' denied on resource",
          },
        },
      },
    ];
    const denied = await run([]);
    expect(denied.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(denied.out).toContain(
      "fcm: GAGAL, HTTP 403 PERMISSION_DENIED: izin IAM kurang atau FCM_PROJECT_ID salah",
    );

    sendReplies = [
      {
        status: 403,
        body: {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
          },
        },
      },
    ];
    const disabled = await run([]);
    expect(disabled.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(disabled.out).toContain("Firebase Cloud Messaging API (V1) belum aktif di proyek kapdh-uji");
  });

  it("404 NOT_FOUND tanpa UNREGISTERED → GAGAL: FCM_PROJECT_ID salah", async () => {
    sendReplies = [
      {
        status: 404,
        body: { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } },
      },
    ];
    const r = await run([]);
    expect(r.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(r.out).toContain(
      "fcm: GAGAL, HTTP 404 NOT_FOUND: proyek FCM tidak ditemukan; FCM_PROJECT_ID salah",
    );
  });

  it("project_id di JSON berbeda dari FCM_PROJECT_ID dilaporkan (boolean + peringatan); FCM menolak → GAGAL", async () => {
    sendReplies = [{ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED" } } }];
    const r = await run([], {
      env: {
        FCM_PROJECT_ID: PROJECT,
        FCM_SERVICE_ACCOUNT_JSON: serviceAccount({ project_id: "kapdh-staging" }),
      },
    });
    expect(r.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(r.out).toContain("  project_id JSON = FCM_PROJECT_ID: tidak\n");
    expect(r.out).toContain("PERINGATAN: project_id di JSON berbeda dari FCM_PROJECT_ID.");
    // Nilai project_id dari JSON tidak dicetak; hanya boolean.
    expect(r.out).not.toContain("kapdh-staging");
    expect(sends()[0]!.path).toBe(`/v1/projects/${PROJECT}/messages:send`);

    const missing = await run([], {
      env: { FCM_PROJECT_ID: PROJECT, FCM_SERVICE_ACCOUNT_JSON: serviceAccount({ project_id: undefined }) },
    });
    expect(missing.code).toBe(PUSH_SELFTEST_EXIT.passed);
    expect(missing.out).toContain("  project_id JSON = FCM_PROJECT_ID: tidak (project_id tidak ada)");
  });

  it("OAuth ditolak (invalid_grant) → oauth: GAGAL dengan kelas galat, tanpa memanggil FCM", async () => {
    tokenReplies = [
      { status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } },
    ];
    const r = await run([]);
    expect(r.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(r.out).toContain("  oauth: GAGAL, HTTP 400 invalid_grant\n");
    expect(r.out).toContain("  fcm: dilewati");
    expect(r.out).not.toContain("Invalid JWT Signature");
    expect(sends()).toHaveLength(0);
    expectNoSecrets(r.all);
  });

  it("FCM 503 dan koneksi ditolak → galat teknis (kode 3), bukan LULUS atau GAGAL", async () => {
    sendReplies = [{ status: 503, body: { error: { code: 503, status: "UNAVAILABLE" } } }];
    const unavailable = await run([]);
    expect(unavailable.code).toBe(PUSH_SELFTEST_EXIT.error);
    expect(unavailable.out).toContain("fcm: galat teknis, HTTP 503 UNAVAILABLE (kelas 5xx)");
    expect(unavailable.out).toContain("GALAT TEKNIS");

    const refused = await run([], { apiBaseUrl: "http://127.0.0.1:1" });
    expect(refused.code).toBe(PUSH_SELFTEST_EXIT.error);
    expect(refused.out).toMatch(/fcm: galat teknis, galat jaringan \w+/);
    expectNoSecrets(refused.all);
  });

  it("private_key bukan PKCS8 (PKCS1 atau \\n literal) → GAGAL tanpa permintaan jaringan; kunci tidak dicetak", async () => {
    const pkcs1 = await run([], {
      env: { FCM_PROJECT_ID: PROJECT, FCM_SERVICE_ACCOUNT_JSON: serviceAccount({ private_key: PKCS1_PEM }) },
    });
    expect(pkcs1.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(pkcs1.out).toContain("  private_key PKCS8 terbaca: tidak");
    expect(pkcs1.out).toContain("  oauth: dilewati");
    for (const line of PKCS1_PEM.split("\n").filter((l) => l && !l.startsWith("-----")))
      expect(pkcs1.all).not.toContain(line);

    const escaped = await run([], {
      env: {
        FCM_PROJECT_ID: PROJECT,
        FCM_SERVICE_ACCOUNT_JSON: serviceAccount({ private_key: PEM.replaceAll("\n", "\\n") }),
      },
    });
    expect(escaped.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(escaped.out).toContain("private_key memuat \\n literal");
    expect(requests).toHaveLength(0);
    expectNoSecrets(pkcs1.all + escaped.all);
  });

  it("placeholder lembar operator → GAGAL tanpa jaringan; env kosong atau argumen asing → kode 2 tanpa mencetak nilainya", async () => {
    const placeholder = await run([], {
      env: {
        FCM_PROJECT_ID: "kapdh-fcm-belum-dikonfigurasi",
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: "belum-dikonfigurasi@kapdh.invalid",
          private_key: "belum-dikonfigurasi",
        }),
      },
    });
    expect(placeholder.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(placeholder.out).toContain("nilai FCM masih placeholder");

    const empty = await run([], { env: {} });
    expect(empty.code).toBe(PUSH_SELFTEST_EXIT.usage);
    expect(empty.err).toContain("FCM_PROJECT_ID dan FCM_SERVICE_ACCOUNT_JSON wajib diisi");

    const invalidJson = await run([], {
      env: { FCM_PROJECT_ID: PROJECT, FCM_SERVICE_ACCOUNT_JSON: "{bukan json" },
    });
    expect(invalidJson.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(invalidJson.out).toContain("FCM_SERVICE_ACCOUNT_JSON bukan JSON yang valid");

    // Token yang keliru diberikan sebagai argumen tidak pernah dicetak.
    const argv = await run(["--token", DEVICE_TOKEN]);
    expect(argv.code).toBe(PUSH_SELFTEST_EXIT.usage);
    expect(argv.err).toContain("Argumen tidak dikenal (2)");
    expectNoSecrets(argv.all);
    expect(requests).toHaveLength(0);
  });

  it("FCM_PROJECT_ID bukan Project ID (JSON akun layanan tertempel, spasi di akhir, nomor proyek) → GAGAL tanpa jaringan; isinya tidak dicetak", async () => {
    // JSON akun layanan nyata tertempel di FCM_PROJECT_ID, sedangkan FCM_SERVICE_ACCOUNT_JSON masih placeholder.
    const swapped = await run([], {
      env: {
        FCM_PROJECT_ID: serviceAccount(),
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: "belum-dikonfigurasi@kapdh.invalid",
          private_key: "belum-dikonfigurasi",
        }),
      },
    });
    expect(swapped.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(swapped.out).toContain(
      "  FCM_PROJECT_ID: tidak berbentuk Project ID Firebase (isi tidak ditampilkan)\n",
    );
    expect(swapped.out).toContain("FCM_PROJECT_ID: berisi JSON, bukan Project ID");
    expect(swapped.out).toContain("  oauth: dilewati");
    expect(swapped.out).not.toContain('service_account"');
    expect(swapped.out).not.toContain(KEY_ID);
    expectNoSecrets(swapped.all);

    // Spasi di akhir: pengirim push memakai nilai mentah (URL .../projects/kapdh-uji%20/...), jadi uji tidak boleh lulus.
    const trailing = await run([], {
      env: { FCM_PROJECT_ID: `${PROJECT} `, FCM_SERVICE_ACCOUNT_JSON: serviceAccount() },
    });
    expect(trailing.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(trailing.out).toContain("FCM_PROJECT_ID: memuat spasi atau karakter tidak sah");
    expect(trailing.out).not.toContain(`  FCM_PROJECT_ID: ${PROJECT}`);
    // Konsisten dengan boolean keempat runbook 4.2 (project_id JSON === env mentah).
    expect(trailing.out).toContain("  project_id JSON = FCM_PROJECT_ID: tidak\n");
    expectNoSecrets(trailing.all);

    const number = await run([], {
      env: { FCM_PROJECT_ID: "931256687765", FCM_SERVICE_ACCOUNT_JSON: serviceAccount() },
    });
    expect(number.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(number.out).toContain("bukan nama tampilan atau nomor proyek");

    expect(requests).toHaveLength(0);
  });

  it("maskEmail: tiga karakter awal + domain", () => {
    expect(maskEmail(CLIENT_EMAIL)).toBe("fir***@kapdh-uji.iam.gserviceaccount.com");
    expect(maskEmail("ab@x.test")).toBe("ab***@x.test");
    expect(maskEmail("tanpa-at")).toBe("(bukan alamat email)");
  });
});

describe("uji mandiri push FCM: token perangkat nyata dari stdin (--token-from-stdin, validate_only)", () => {
  it("token valid (200) → LULUS; token dikirim hanya sebagai validate_only dan tidak pernah dicetak", async () => {
    sendReplies = [
      INVALID_TOKEN_REPLY,
      { status: 200, body: { name: `projects/${PROJECT}/messages/fake_message_id` } },
    ];
    const r = await run(["--token-from-stdin"], { stdin: pipeStdin(`${DEVICE_TOKEN}\n`) });
    expect(r.code).toBe(PUSH_SELFTEST_EXIT.passed);
    expect(r.out).toContain(
      "  token stdin: ok, valid untuk proyek kapdh-uji (validate_only; tidak dikirim ke perangkat)",
    );
    expect(r.out).toContain("token perangkat valid.");
    expect(sends()).toHaveLength(2);
    const [dummy, device] = sends().map(
      (s) => JSON.parse(s.body) as { validate_only: boolean; message: { token: string } },
    );
    expect(dummy).toMatchObject({ validate_only: true, message: { token: DUMMY_FCM_TOKEN } });
    expect(device).toMatchObject({ validate_only: true, message: { token: DEVICE_TOKEN } });
    expectNoSecrets(r.all);
  });

  it("token tidak terdaftar (404 UNREGISTERED) atau dari proyek lain (403 SENDER_ID_MISMATCH) → GAGAL; kredensial tetap terbukti", async () => {
    sendReplies = [
      INVALID_TOKEN_REPLY,
      {
        status: 404,
        body: { error: { code: 404, status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
      },
    ];
    const unregistered = await run(["--token-from-stdin"], { stdin: pipeStdin(DEVICE_TOKEN) });
    expect(unregistered.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(unregistered.out).toContain("fcm: ok, HTTP 400 INVALID_ARGUMENT");
    expect(unregistered.out).toContain("token stdin: GAGAL, tidak terdaftar (HTTP 404 UNREGISTERED)");
    expect(unregistered.out).toContain(
      "GAGAL: kredensial akun layanan dan izin FCM benar untuk proyek kapdh-uji, tetapi token perangkat tidak valid.",
    );
    expect(unregistered.out).not.toContain("LULUS");
    expectNoSecrets(unregistered.all);

    sendReplies = [
      INVALID_TOKEN_REPLY,
      {
        status: 403,
        body: {
          error: { code: 403, status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] },
        },
      },
    ];
    const mismatch = await run(["--token-from-stdin"], { stdin: pipeStdin(`\n  ${DEVICE_TOKEN}  \r\n\n`) });
    expect(mismatch.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(mismatch.out).toContain(
      "token stdin: GAGAL, milik proyek Firebase lain (HTTP 403 SENDER_ID_MISMATCH)",
    );
    expectNoSecrets(mismatch.all);
  });

  it("kredensial gagal → token stdin dilewati (tidak dikirim ke FCM)", async () => {
    sendReplies = [{ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } }];
    const r = await run(["--token-from-stdin"], { stdin: pipeStdin(DEVICE_TOKEN) });
    expect(r.code).toBe(PUSH_SELFTEST_EXIT.failed);
    expect(r.out).toContain("  token stdin: dilewati");
    expect(sends()).toHaveLength(1);
    expectNoSecrets(r.all);
  });

  it("stdin kosong, lebih dari satu token, atau bukan token FCM → kode 2 tanpa permintaan jaringan dan tanpa mencetak isinya", async () => {
    const empty = await run(["--token-from-stdin"], { stdin: pipeStdin("") });
    expect(empty.code).toBe(PUSH_SELFTEST_EXIT.usage);
    expect(empty.err).toContain("token dari stdin kosong");

    const two = await run(["--token-from-stdin"], {
      stdin: pipeStdin(`${DEVICE_TOKEN}\n${DEVICE_TOKEN}x\n`),
    });
    expect(two.code).toBe(PUSH_SELFTEST_EXIT.usage);
    expect(two.err).toContain("memuat 2 baris");

    const notToken = await run(["--token-from-stdin"], {
      stdin: pipeStdin('{"token": "RahasiaTokenPerangkat"}'),
    });
    expect(notToken.code).toBe(PUSH_SELFTEST_EXIT.usage);
    expect(notToken.err).toContain("tidak berbentuk token FCM");

    const huge = await run(["--token-from-stdin"], { stdin: pipeStdin("a".repeat(10_000)) });
    expect(huge.code).toBe(PUSH_SELFTEST_EXIT.usage);
    expect(huge.err).toContain("melebihi 8192 karakter");

    expect(requests).toHaveLength(0);
    expectNoSecrets(empty.all + two.all + notToken.all + huge.all);
  });

  it("TTY: mode raw tanpa gema selama token diketik (Backspace didukung), lalu dikembalikan; Ctrl-C membatalkan", async () => {
    function tty(...chunks: string[]) {
      const stream = new PassThrough() as PassThrough & TokenInput;
      const rawModes: boolean[] = [];
      stream.isTTY = true;
      stream.setRawMode = (mode: boolean) => rawModes.push(mode);
      // Ketikan tiba setelah prompt dan mode raw aktif.
      setTimeout(() => {
        for (const chunk of chunks) stream.write(chunk);
      }, 10);
      return { stream, rawModes };
    }
    sendReplies = [
      INVALID_TOKEN_REPLY,
      { status: 200, body: { name: `projects/${PROJECT}/messages/fake_message_id` } },
    ];
    const typed = tty(
      `\u001b[200~${DEVICE_TOKEN.slice(0, 30)}`,
      `${DEVICE_TOKEN.slice(30)}Z\u007f\u001b[201~`,
      "\r",
    );
    const r = await run(["--token-from-stdin"], { stdin: typed.stream });
    expect(r.code).toBe(PUSH_SELFTEST_EXIT.passed);
    expect(typed.rawModes).toEqual([true, false]);
    expect(r.err).toContain("Tempel token FCM lalu tekan Enter (tidak ditampilkan): \n");
    expect((JSON.parse(sends()[1]!.body) as { message: { token: string } }).message.token).toBe(DEVICE_TOKEN);
    expectNoSecrets(r.all);

    const cancelled = tty("abc", "\u0003");
    const c = await run(["--token-from-stdin"], { stdin: cancelled.stream });
    expect(c.code).toBe(PUSH_SELFTEST_EXIT.usage);
    expect(c.err).toContain("dibatalkan (Ctrl-C)");
    expect(cancelled.rawModes).toEqual([true, false]);
  });
});
