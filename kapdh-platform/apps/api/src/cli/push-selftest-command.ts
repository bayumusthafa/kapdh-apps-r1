import { createPrivateKey } from "node:crypto";
import { type FcmServiceAccount, parseFcmServiceAccount } from "@kapdh/config";
import {
  buildFcmMessage,
  type FcmEndpoints,
  type FcmErrorBody,
  fcmErrorCode,
  type FcmFetchLike,
  type FcmHttpResponse,
  fcmMessagesSendUrl,
  FcmOAuthError,
  fcmRequest,
  FcmTimeoutError,
  fetchFcmAccessToken,
  isInvalidTokenError,
} from "../core/adapters/push.js";
import type { CliOutput } from "./bootstrap-admin-command.js";

/** Kode keluar uji mandiri push. 0 hanya bila HASIL LULUS. */
export const PUSH_SELFTEST_EXIT = {
  /** Kredensial, izin FCM, dan (bila diberikan) token perangkat lulus. */
  passed: 0,
  /** Ditolak: kredensial, izin IAM, project id, kunci, atau token perangkat salah. */
  failed: 1,
  /** Argumen salah, env FCM kosong, atau stdin tidak berisi tepat satu token. */
  usage: 2,
  /** Galat teknis (jaringan, batas waktu, FCM/OAuth 429/5xx): bukan keputusan, ulangi nanti. */
  error: 3,
} as const;

export const PUSH_SELFTEST_USAGE = [
  "Pakai: node dist/cli/push-selftest.js [--token-from-stdin]",
  "  Memeriksa FCM_PROJECT_ID dan FCM_SERVICE_ACCOUNT_JSON env API: isi JSON (boolean saja), token akses OAuth,",
  "  lalu FCM HTTP v1 messages:send dengan validate_only=true ke token dummy. Tidak ada notifikasi yang terkirim.",
  "  --token-from-stdin  baca SATU token FCM nyata dari stdin (tidak pernah dari argumen; tidak ditampilkan) dan",
  "                      validasi dengan validate_only (tidak dikirim ke perangkat).",
  "Kode keluar: 0 LULUS, 1 GAGAL, 2 argumen/konfigurasi salah, 3 galat teknis (jaringan, batas waktu, 429/5xx).",
  "Runbook: docs/runbooks/push-fcm.md.",
].join("\n");

const FLAG_TOKEN = "--token-from-stdin";

/** Token dummy yang jelas tidak sah: FCM menolaknya (400 INVALID_ARGUMENT) setelah kredensial dan izin diterima. */
export const DUMMY_FCM_TOKEN = "kapdh-push-selftest-token-dummy-tidak-sah";

/**
 * Project ID Firebase/Google Cloud: 6-30 karakter huruf kecil, angka, dan tanda hubung, diawali huruf dan tidak
 * diakhiri tanda hubung. Nilai FCM_PROJECT_ID hanya dicetak bila cocok, karena isi lain (mis. JSON akun layanan yang
 * tertempel di variabel ini) bisa memuat private key.
 */
const FIREBASE_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Batas stdin: token FCM jauh lebih pendek; sisanya ditolak tanpa dibaca lebih lanjut. */
const MAX_STDIN_CHARS = 8192;
/** Bentuk token registrasi FCM (base64url + `:`); panjang mengikuti device_tokens (1-4096). */
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:.-]{20,4096}$/;
/** Urutan escape terminal (mis. bracketed paste) yang ikut terbaca dari TTY. */
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** stdin proses (pipa atau TTY). */
export type TokenInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export interface PushSelftestDeps {
  /** FCM_PROJECT_ID dan FCM_SERVICE_ACCOUNT_JSON dari env API yang tervalidasi. */
  env: { FCM_PROJECT_ID?: string; FCM_SERVICE_ACCOUNT_JSON?: string };
  /** Jam eksekusi untuk judul laporan (CLI: jam sistem). */
  now: Date;
  stdout: CliOutput;
  stderr: CliOutput;
  /** Hanya dibaca bila `--token-from-stdin`. */
  stdin?: TokenInput;
  fetchImpl?: FcmFetchLike;
  /** Batas waktu per permintaan HTTP (bawaan 10 detik, sama dengan pengirim push). */
  timeoutMs?: number;
  /** HANYA uji: server OAuth/FCM tiruan lokal. */
  endpoints?: FcmEndpoints;
}

type TokenRead = { ok: true; token: string } | { ok: false; reason: string };

/** Membaca seluruh stdin pipa (sampai EOF) dengan batas ukuran. `null` = melebihi batas. */
function readAll(input: TokenInput): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let text = "";
    let settled = false;
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text.length > MAX_STDIN_CHARS) settle(null);
    };
    const onEnd = () => settle(text);
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

/**
 * Membaca satu baris dari TTY tanpa gema (mode raw): Enter/Ctrl-D mengakhiri, Backspace menghapus, Ctrl-C
 * membatalkan (`null`). Prompt ditulis ke `prompt` (stderr), isi yang diketik tidak pernah ditulis ke mana pun.
 */
function readHiddenLine(input: TokenInput, prompt: CliOutput): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.setRawMode?.(false);
      input.pause();
      prompt.write("\n");
    };
    const settle = (result: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return settle(value);
        if (ch === "\u0003") return settle(null);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
        if (value.length > MAX_STDIN_CHARS) return settle(value);
      }
    };
    const onEnd = () => settle(value);
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    prompt.write("Tempel token FCM lalu tekan Enter (tidak ditampilkan): ");
    input.setRawMode?.(true);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

/**
 * SATU token FCM dari stdin: pipa (`... | docker exec -i`) dibaca sampai EOF, TTY (`docker exec -it`) dibaca tanpa
 * gema. Tepat satu baris tidak kosong yang berbentuk token FCM; isinya tidak pernah dicetak, termasuk saat ditolak.
 */
export async function readTokenFromStdin(input: TokenInput, prompt: CliOutput): Promise<TokenRead> {
  const raw = input.isTTY ? await readHiddenLine(input, prompt) : await readAll(input);
  if (raw === null)
    return {
      ok: false,
      reason: input.isTTY ? "dibatalkan (Ctrl-C)" : `melebihi ${MAX_STDIN_CHARS} karakter`,
    };
  if (raw.length > MAX_STDIN_CHARS) return { ok: false, reason: `melebihi ${MAX_STDIN_CHARS} karakter` };
  const lines = raw
    .replace(ANSI_SEQUENCE, "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { ok: false, reason: "kosong" };
  if (lines.length > 1)
    return { ok: false, reason: `memuat ${lines.length} baris; berikan tepat satu token` };
  if (!FCM_TOKEN_PATTERN.test(lines[0]!))
    return { ok: false, reason: "tidak berbentuk token FCM (isinya tidak ditampilkan)" };
  return { ok: true, token: lines[0]! };
}

/** `fir***@proyek.iam.gserviceaccount.com`: tiga karakter awal bagian lokal + domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "(bukan alamat email)";
  return `${email.slice(0, Math.min(3, at))}***@${email.slice(at + 1)}`;
}

/** Alasan FCM_PROJECT_ID tidak berbentuk Project ID, tanpa memuat isinya. */
function invalidProjectIdReason(value: string): string {
  if (value.trimStart().startsWith("{"))
    return (
      "berisi JSON, bukan Project ID (JSON akun layanan tertempel di variabel yang salah?). Isi FCM_PROJECT_ID " +
      "dengan Project ID (mis. kapdh-prod) dan JSON hanya di FCM_SERVICE_ACCOUNT_JSON."
    );
  if (/\s/.test(value))
    return (
      "memuat spasi atau karakter tidak sah (mis. spasi di akhir). Pengirim push memakai nilai apa adanya, " +
      "sehingga FCM menolaknya. Hapus spasi di Coolify lalu deploy ulang."
    );
  return (
    "memuat karakter tidak sah atau panjangnya bukan 6-30 karakter. Pakai Project ID Firebase (mis. kapdh-prod), " +
    "bukan nama tampilan atau nomor proyek."
  );
}

/** Hanya boolean tentang `private_key`; isi kunci tidak pernah keluar dari fungsi ini. */
function inspectPrivateKey(pem: string): { pkcs8: boolean; realNewlines: boolean; escapedNewlines: boolean } {
  const realNewlines = pem.includes("\n");
  const escapedNewlines = pem.includes("\\n");
  let pkcs8 = false;
  if (pem.includes("-----BEGIN PRIVATE KEY-----")) {
    try {
      const key = createPrivateKey({ key: pem, format: "pem" });
      pkcs8 = key.type === "private" && key.asymmetricKeyType === "rsa";
    } catch {
      pkcs8 = false;
    }
  }
  return { pkcs8, realNewlines, escapedNewlines };
}

type Outcome = { kind: "pass" | "fail" | "error"; text: string; hints?: string[] };

const RUNBOOK = "docs/runbooks/push-fcm.md";

/** Label aman respons FCM: status HTTP dan kode galat FCM/Google berbentuk enum (pesan bebas tidak pernah dicetak). */
function responseLabel(res: FcmHttpResponse): string {
  const body = (res.body ?? {}) as FcmErrorBody;
  const code = fcmErrorCode(body);
  return `HTTP ${res.status}${code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` ${code}` : ""}`;
}

function errorReason(body: FcmErrorBody): string | undefined {
  return body.error?.details?.find((d) => typeof d.reason === "string")?.reason;
}

function statusClass(status: number): string {
  return `kelas ${Math.floor(status / 100)}xx`;
}

/** Menafsirkan messages:send validate_only ke token dummy. */
function interpretDummy(res: FcmHttpResponse, projectId: string): Outcome {
  const body = (res.body ?? {}) as FcmErrorBody;
  const code = fcmErrorCode(body);
  const label = responseLabel(res);
  if (res.status === 200)
    return { kind: "pass", text: `${label} (validate_only diterima; kredensial dan izin FCM benar)` };
  if (res.status === 400 && (code === "INVALID_ARGUMENT" || body.error?.status === "INVALID_ARGUMENT")) {
    if (isInvalidTokenError(body))
      return {
        kind: "pass",
        text: `${label} untuk token dummy (diharapkan: token ditolak, kredensial dan izin FCM diterima)`,
      };
    // 400 yang tidak menunjuk token bisa berupa penolakan parameter/path sebelum izin diperiksa: bukan bukti.
    return {
      kind: "fail",
      text: `${label}: INVALID_ARGUMENT tidak menyebut token; tidak membuktikan izin FCM`,
      hints: [
        "FCM menolak pesan uji itu sendiri (bukan token dummy). Kredensial dan izin belum terbukti. Laporkan ke",
        "pengembang beserta keluaran ini; pesan galat FCM sengaja tidak dicetak.",
      ],
    };
  }
  if (code === "UNREGISTERED")
    return { kind: "pass", text: `${label} untuk token dummy (diharapkan: token tidak terdaftar)` };
  if (res.status === 401)
    return {
      kind: "fail",
      text: `${label}: kredensial ditolak FCM`,
      hints: [
        "Token akses OAuth tidak diterima FCM. Buat kunci baru akun layanan yang sama, isi ulang Coolify (API dan",
        `worker), deploy, lalu ulangi (${RUNBOOK} bagian 7).`,
      ],
    };
  if (res.status === 403) {
    if (errorReason(body) === "SERVICE_DISABLED")
      return {
        kind: "fail",
        text: `${label}: Firebase Cloud Messaging API (V1) belum aktif di proyek ${projectId}`,
        hints: [`Aktifkan "Firebase Cloud Messaging API (V1)" di Firebase Console (${RUNBOOK} bagian 2.3).`],
      };
    return {
      kind: "fail",
      text: `${label}: izin IAM kurang atau FCM_PROJECT_ID salah`,
      hints: [
        `Akun layanan butuh izin cloudmessaging.messages.create di proyek ${projectId} (akun firebase-adminsdk`,
        `bawaan proyek itu sudah memilikinya). Pastikan kunci dibuat di proyek yang sama (${RUNBOOK} bagian 3).`,
      ],
    };
  }
  if (res.status === 404)
    return {
      kind: "fail",
      text: `${label}: proyek FCM tidak ditemukan; FCM_PROJECT_ID salah`,
      hints: [
        `FCM_PROJECT_ID harus Project ID Firebase (mis. kapdh-prod), bukan nama tampilan atau nomor proyek.`,
      ],
    };
  if (res.status === 429 || res.status >= 500)
    return {
      kind: "error",
      text: `${label} (${statusClass(res.status)}): galat sementara FCM; ulangi nanti`,
    };
  return { kind: "fail", text: `${label} (${statusClass(res.status)}): respons tidak diharapkan` };
}

/** Menafsirkan messages:send validate_only ke token perangkat nyata. */
function interpretDevice(res: FcmHttpResponse, projectId: string): Outcome {
  const body = (res.body ?? {}) as FcmErrorBody;
  const code = fcmErrorCode(body);
  const label = responseLabel(res);
  if (res.status === 200)
    return {
      kind: "pass",
      text: `valid untuk proyek ${projectId} (validate_only; tidak dikirim ke perangkat)`,
    };
  if (code === "UNREGISTERED" || res.status === 404)
    return {
      kind: "fail",
      text: `tidak terdaftar (${label})`,
      hints: [
        "Aplikasi dihapus atau token kedaluwarsa. Buka aplikasi lagi dan login agar token baru terdaftar.",
      ],
    };
  if (code === "SENDER_ID_MISMATCH")
    return {
      kind: "fail",
      text: `milik proyek Firebase lain (${label})`,
      hints: [
        `Build aplikasi memakai FIREBASE_* dari proyek selain ${projectId}. Server menonaktifkan token seperti ini.`,
        `Bangun ulang aplikasi dengan berkas dart-define proyek yang sama dengan FCM_PROJECT_ID (${RUNBOOK} bagian 6).`,
      ],
    };
  if (code === "THIRD_PARTY_AUTH_ERROR")
    return {
      kind: "fail",
      text: `kredensial APNs ditolak (${label})`,
      hints: [`Token iOS butuh kunci APNs .p8 di proyek Firebase (${RUNBOOK} bagian 8).`],
    };
  if (res.status === 400)
    return {
      kind: "fail",
      text: `tidak sah (${label})`,
      hints: ["Token terpotong atau bukan token FCM. Salin ulang token utuh."],
    };
  if (res.status === 429 || res.status >= 500)
    return {
      kind: "error",
      text: `${label} (${statusClass(res.status)}): galat sementara FCM; ulangi nanti`,
    };
  return { kind: "fail", text: `${label} (${statusClass(res.status)}): respons tidak diharapkan` };
}

/** Kelas galat jaringan yang aman dicetak: nama tipe dan kode sistem (mis. ENOTFOUND), tanpa pesan. */
function networkLabel(e: unknown): string {
  if (e instanceof FcmTimeoutError) return "batas waktu habis";
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  const code = err?.cause?.code ?? err?.code;
  const safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` ${code}` : "";
  return `galat jaringan ${err?.name ?? "tidak dikenal"}${safeCode}`;
}

function oauthOutcome(e: unknown): Outcome {
  if (e instanceof FcmOAuthError) {
    const label = `HTTP ${e.status}${e.oauthError ? ` ${e.oauthError}` : ""}`;
    if (e.status === 429 || e.status >= 500)
      return { kind: "error", text: `${label} (${statusClass(e.status)}): galat sementara Google OAuth` };
    const hints =
      e.oauthError === "invalid_grant"
        ? [
            "Kunci akun layanan dihapus/dinonaktifkan di IAM, akun layanan dihapus, atau jam server melenceng.",
            `Buat kunci baru (${RUNBOOK} bagian 7) dan periksa jam VPS (timedatectl).`,
          ]
        : ["client_email dan private_key harus berasal dari berkas kunci JSON yang sama."];
    return { kind: "fail", text: label, hints };
  }
  // fetch bawaan Node (undici) melempar TypeError("fetch failed") dengan `cause` untuk galat jaringan.
  if (e instanceof FcmTimeoutError || (e instanceof Error && e.cause !== undefined))
    return { kind: "error", text: `${networkLabel(e)} ke oauth2.googleapis.com` };
  // Kunci sudah diperiksa createPrivateKey; sisanya jose menolak kunci saat menandatangani JWT atau galat lain.
  const name = (e as Error)?.name ?? "tidak dikenal";
  return { kind: "fail", text: `JWT akun layanan tidak dapat dibuat atau dikirim (galat ${name})` };
}

/**
 * Uji mandiri kredensial push FCM production (F-13; docs/runbooks/push-fcm.md), dipisah dari entry `push-selftest.ts`
 * agar dapat diuji tanpa proses baru. Hanya validate_only: FCM memvalidasi pesan tanpa mengirimkannya. Keluaran tidak
 * pernah memuat private key, token akses, atau token FCM; client_email hanya disamarkan, dan FCM_PROJECT_ID hanya
 * dicetak bila berbentuk Project ID Firebase. Mengembalikan {@link PUSH_SELFTEST_EXIT}.
 */
export async function runPushSelftestCommand(
  args: readonly string[],
  deps: PushSelftestDeps,
): Promise<number> {
  const unknown = args.filter((a) => a !== FLAG_TOKEN);
  if (unknown.length > 0) {
    // Nilai argumen tidak dicetak: token yang keliru diberikan lewat argv tidak boleh tampil di layar/log.
    deps.stderr.write(`Argumen tidak dikenal (${unknown.length}).\n${PUSH_SELFTEST_USAGE}\n`);
    return PUSH_SELFTEST_EXIT.usage;
  }
  // Nilai mentah, persis yang dipakai createPushSender/FcmPushSender (tanpa trim), agar hasil uji sama dengan pengirim.
  const projectId = deps.env.FCM_PROJECT_ID;
  const rawJson = deps.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!projectId?.trim() || !rawJson?.trim()) {
    deps.stderr.write(
      "Gagal: FCM_PROJECT_ID dan FCM_SERVICE_ACCOUNT_JSON wajib diisi di env API (push nonaktif). " +
        `Lihat ${RUNBOOK} bagian 4.\n`,
    );
    return PUSH_SELFTEST_EXIT.usage;
  }

  let deviceToken: string | undefined;
  if (args.includes(FLAG_TOKEN)) {
    if (!deps.stdin) {
      deps.stderr.write("Gagal: stdin tidak tersedia.\n");
      return PUSH_SELFTEST_EXIT.usage;
    }
    const read = await readTokenFromStdin(deps.stdin, deps.stderr);
    if (!read.ok) {
      deps.stderr.write(
        `Gagal: token dari stdin ${read.reason}. Kirim tepat satu token lewat pipa ke \`docker exec -i\` ` +
          `atau tempel di \`docker exec -it\` (${RUNBOOK} bagian 5.3).\n`,
      );
      return PUSH_SELFTEST_EXIT.usage;
    }
    deviceToken = read.token;
  }

  const out = (text = "") => deps.stdout.write(`${text}\n`);
  const field = (name: string, value: string) => out(`  ${name}: ${value}`);
  const yesNo = (value: boolean) => (value ? "ya" : "tidak");
  const problems: string[] = [];
  const warnings: string[] = [];
  let technical = false;
  /** true setelah FCM menerima kredensial dan izin (token dummy ditolak sebagaimana mestinya). */
  let credentialsOk = false;
  const finish = (): number => {
    out();
    for (const warning of warnings) out(`PERINGATAN: ${warning}`);
    if (problems.length > 0) {
      out(
        credentialsOk
          ? `GAGAL: kredensial akun layanan dan izin FCM benar untuk proyek ${projectId}, tetapi token perangkat tidak valid.`
          : "GAGAL: push FCM belum siap.",
      );
      for (const problem of problems) out(`  - ${problem}`);
      out(`Perbaikan: ${RUNBOOK}. Push tetap tercatat di inbox; hanya kanal push yang gagal.`);
      return PUSH_SELFTEST_EXIT.failed;
    }
    if (technical) {
      out(
        "GALAT TEKNIS: belum ada keputusan (jaringan, batas waktu, atau galat sementara Google). Ulangi nanti.",
      );
      return PUSH_SELFTEST_EXIT.error;
    }
    out(
      deviceToken
        ? `LULUS: kredensial akun layanan dan izin FCM benar untuk proyek ${projectId}; token perangkat valid.`
        : `LULUS: kredensial akun layanan dan izin FCM benar untuk proyek ${projectId}.`,
    );
    return PUSH_SELFTEST_EXIT.passed;
  };
  const record = (name: string, outcome: Outcome) => {
    const prefix = { pass: "ok", fail: "GAGAL", error: "galat teknis" }[outcome.kind];
    field(name, outcome.text ? `${prefix}, ${outcome.text}` : prefix);
    for (const hint of outcome.hints ?? []) out(`      ${hint}`);
    if (outcome.kind === "fail") problems.push(`${name}: ${outcome.text}`);
    if (outcome.kind === "error") technical = true;
  };

  out(`Uji mandiri push FCM KAPDH (F-13) - ${deps.now.toISOString()}`);
  out("Mode validate_only: FCM hanya memvalidasi pesan; tidak ada notifikasi yang dikirim ke perangkat.");
  out();
  // Isi hanya dicetak bila berbentuk Project ID (lihat FIREBASE_PROJECT_ID_PATTERN). Nilai yang tidak sah menggagalkan
  // uji sebelum permintaan jaringan apa pun; pemeriksaan JSON di bawah tetap berjalan (boolean saja).
  if (FIREBASE_PROJECT_ID_PATTERN.test(projectId)) field("FCM_PROJECT_ID", projectId);
  else {
    field("FCM_PROJECT_ID", "tidak berbentuk Project ID Firebase (isi tidak ditampilkan)");
    problems.push(`FCM_PROJECT_ID: ${invalidProjectIdReason(projectId)}`);
  }

  // 1. Isi JSON akun layanan (boolean saja; tidak ada nilai kunci yang dicetak).
  let account: FcmServiceAccount;
  try {
    account = parseFcmServiceAccount(rawJson);
  } catch (e) {
    field("FCM_SERVICE_ACCOUNT_JSON", "tidak valid");
    problems.push(`FCM_SERVICE_ACCOUNT_JSON: ${(e as Error).message}`);
    return finish();
  }
  const fields = JSON.parse(rawJson) as Record<string, unknown>;
  field("client_email", maskEmail(account.client_email));
  if (typeof fields.private_key_id === "string" && /^[0-9a-f]{8,}$/i.test(fields.private_key_id))
    field("private_key_id (8 karakter awal)", fields.private_key_id.slice(0, 8));
  const isServiceAccount = fields.type === "service_account";
  field("type = service_account", yesNo(isServiceAccount));
  if (!isServiceAccount)
    warnings.push("field type bukan service_account; pakai berkas kunci JSON akun layanan.");
  const jsonProject = typeof fields.project_id === "string" ? fields.project_id : undefined;
  const projectMatches = jsonProject === projectId;
  field(
    "project_id JSON = FCM_PROJECT_ID",
    jsonProject === undefined ? "tidak (project_id tidak ada)" : yesNo(projectMatches),
  );
  if (!projectMatches)
    warnings.push(
      "project_id di JSON berbeda dari FCM_PROJECT_ID. Kunci sebaiknya dibuat di proyek Firebase yang sama " +
        "dengan FCM_PROJECT_ID; token aplikasi selalu harus dari proyek FCM_PROJECT_ID.",
    );
  const key = inspectPrivateKey(account.private_key);
  field("private_key PKCS8 terbaca", yesNo(key.pkcs8));
  if (!key.pkcs8) {
    problems.push(
      key.escapedNewlines && !key.realNewlines
        ? "private_key memuat \\n literal, bukan baris baru (JSON diringkas dua kali atau diberi kutip). " +
            "Salin ulang dengan perintah node di runbook bagian 3."
        : "private_key bukan kunci RSA berformat PKCS8 (berkas kunci JSON dari Google selalu PKCS8).",
    );
  }
  const placeholder = /belum-dikonfigurasi/.test(projectId) || /\.invalid$/i.test(account.client_email);
  if (placeholder) problems.push("nilai FCM masih placeholder lembar operator; isi nilai nyata di Coolify.");
  if (problems.length > 0) {
    field("oauth", "dilewati");
    field("fcm", "dilewati");
    if (deviceToken) field("token stdin", "dilewati");
    return finish();
  }

  // 2. Token akses OAuth persis seperti pengirim push (fetchFcmAccessToken; JWT RS256 jose).
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FcmFetchLike);
  const timeoutMs = deps.timeoutMs ?? 10_000;
  let accessToken: string;
  try {
    accessToken = (
      await fetchFcmAccessToken(account, { fetchImpl, tokenUrl: deps.endpoints?.tokenUrl, timeoutMs })
    ).value;
    record("oauth", { kind: "pass", text: "" });
  } catch (e) {
    record("oauth", oauthOutcome(e));
    field("fcm", "dilewati");
    if (deviceToken) field("token stdin", "dilewati");
    return finish();
  }

  // 3. messages:send validate_only. Token akses hanya dipakai di header permintaan, tidak pernah dicetak.
  const validate = (token: string) =>
    fcmRequest(
      fetchImpl,
      fcmMessagesSendUrl(projectId, deps.endpoints?.apiBaseUrl),
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          validate_only: true,
          message: buildFcmMessage({
            token,
            platform: "android",
            title: "Uji mandiri KAPDH",
            body: "validate_only: tidak dikirim ke perangkat",
            data: { category: "selftest" },
          }),
        }),
      },
      timeoutMs,
      "Batas waktu FCM habis",
    );

  let dummy: Outcome;
  try {
    dummy = interpretDummy(await validate(DUMMY_FCM_TOKEN), projectId);
  } catch (e) {
    dummy = { kind: "error", text: `${networkLabel(e)} ke fcm.googleapis.com` };
  }
  record("fcm", dummy);
  credentialsOk = dummy.kind === "pass";

  // 4. Opsional: token perangkat nyata dari stdin, juga validate_only.
  if (deviceToken) {
    if (!credentialsOk) field("token stdin", "dilewati");
    else {
      let device: Outcome;
      try {
        device = interpretDevice(await validate(deviceToken), projectId);
      } catch (e) {
        device = { kind: "error", text: `${networkLabel(e)} ke fcm.googleapis.com` };
      }
      record("token stdin", device);
    }
  }
  return finish();
}
