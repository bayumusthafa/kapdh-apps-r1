import { HttpException } from "@nestjs/common";
import { pgErrorInfo } from "../db/errors.js";
import { AppException } from "../errors/app-exception.js";

/**
 * Bentuk galat yang aman dicatat (N-14, PRD 5.5: log tanpa PII, sandi, OTP, token). Pesan galat umum TIDAK pernah
 * dicatat karena bisa memuat data: DrizzleQueryError memuat SQL + parameter terikat (email, hash), SyntaxError
 * JSON.parse memuat potongan input, ERR_INVALID_ARG_TYPE memuat nilai yang diterima, galat SMTP memuat alamat.
 * Yang dicatat: tipe, kode (SQLSTATE/kode Node), constraint/tabel, status, dan frame stack TANPA baris pesan.
 *
 * Nama field sengaja `error_code` (bukan `code`) karena kunci `code` disensor logger (kode OTP).
 */
export interface SafeErrorLog {
  type: string;
  error_code?: string;
  constraint?: string;
  table?: string;
  status?: number;
  /** Hanya untuk AppException: pesan Bahasa Indonesia yang memang ditampilkan ke pengguna. */
  message?: string;
  frames?: string[];
}

const MAX_FRAMES = 15;

function frames(error: Error): string[] | undefined {
  if (typeof error.stack !== "string") return undefined;
  // Pesan bisa multi-baris (DrizzleQueryError: "Failed query …\nparams: …"); hanya baris "at …" yang diambil.
  const lines = error.stack
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim());
  return lines.length > 0 ? lines : undefined;
}

function typeName(error: Error): string {
  const e = error as Error & { query?: unknown; params?: unknown };
  // DrizzleQueryError tidak menetapkan `name`; dikenali dari properti query/params.
  if (e.query !== undefined && e.params !== undefined) return "DrizzleQueryError";
  if (error.name && error.name !== "Error") return error.name;
  return error.constructor?.name || "Error";
}

/**
 * Objek hasil safeError. Serializer logger (`error`/`err`) menerima objek ini apa adanya sehingga pemanggil boleh
 * menulis `{ error: safeError(e) }` maupun `{ error: e }` tanpa serialisasi ganda (yang dulu mengubah hasil menjadi
 * `{type: "object"}` dan menghilangkan SQLSTATE/constraint dari log).
 */
const produced = new WeakSet<object>();

/** Serializer logger: Error/nilai apa pun → bentuk aman; hasil safeError diteruskan tanpa diubah. */
export function serializeError(value: unknown): SafeErrorLog {
  if (value !== null && typeof value === "object" && produced.has(value)) return value as SafeErrorLog;
  return safeError(value);
}

export function safeError(error: unknown): SafeErrorLog {
  if (error !== null && typeof error === "object" && produced.has(error)) return error as SafeErrorLog;
  const log = buildSafeError(error);
  produced.add(log);
  return log;
}

function buildSafeError(error: unknown): SafeErrorLog {
  if (error instanceof AppException) {
    return { type: "AppException", error_code: error.code, status: error.status, message: error.message };
  }
  if (!(error instanceof Error)) {
    return { type: error === null ? "null" : typeof error };
  }
  const log: SafeErrorLog = { type: typeName(error) };
  if (error instanceof HttpException) log.status = error.getStatus();
  const pg = pgErrorInfo(error);
  if (pg) {
    log.error_code = pg.code;
    if (pg.constraint) log.constraint = pg.constraint;
    if (pg.table) log.table = pg.table;
  } else {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)) log.error_code = code;
  }
  const stackFrames = frames(error);
  if (stackFrames) log.frames = stackFrames;
  return log;
}
