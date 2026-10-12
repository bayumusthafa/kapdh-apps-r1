import { Inject, Injectable, type LoggerService } from "@nestjs/common";
import { type DestinationStream, type Logger, pino } from "pino";
import { tryCtx } from "../context/request-context.js";
import { ROOT_LOGGER } from "../tokens.js";
import { safeError } from "./safe-error.js";

/**
 * Logger JSON pino (ARCHITECTURE §4.2, N-14): level dari LOG_LEVEL, request_id/job_id terikat, dan redaksi kunci
 * rahasia di kedalaman mana pun (sampai 4 tingkat). Header, body, dan query string request tidak pernah dicatat;
 * redaksi adalah lapis pertahanan kedua bila objek berisi rahasia ikut di-log.
 */
export const REDACTED_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-reauth-token",
  "password",
  "new_password",
  "current_password",
  "password_hash",
  "code",
  "otp",
  "code_hmac",
  "totp_code",
  "totp_secret",
  "backup_code",
  "backup_codes",
  "mfa_token",
  "access_token",
  "refresh_token",
  "refresh_hash",
  "reauth_token",
  "reset_token",
  "invite_token",
  "token",
  "secret",
  "private_key",
] as const;

const REDACT_DEPTH = 4;

/** Path fast-redact untuk setiap kunci di kedalaman 0..REDACT_DEPTH (`k`, `*.k`, `*.*.k`, …). */
export function redactPaths(keys: readonly string[] = REDACTED_KEYS, depth = REDACT_DEPTH): string[] {
  const paths: string[] = [];
  for (const key of keys) {
    const simple = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
    for (let level = 0; level <= depth; level++) {
      const prefix = Array.from({ length: level }, () => "*").join(".");
      if (simple) paths.push(level === 0 ? key : `${prefix}.${key}`);
      else paths.push(level === 0 ? `["${key}"]` : `${prefix}["${key}"]`);
    }
  }
  return paths;
}

interface SerializableRequest {
  method?: string;
  url?: string;
  routeOptions?: { url?: string };
}

/** Request dicatat tanpa query string (bisa berisi kata kunci pencarian nama/token) dan tanpa IP/header (PRD 5.5). */
function requestSerializer(req: SerializableRequest) {
  return {
    method: req?.method,
    url: typeof req?.url === "string" ? req.url.split("?")[0] : undefined,
    route: req?.routeOptions?.url,
  };
}

function responseSerializer(reply: { statusCode?: number }) {
  return { status_code: reply?.statusCode };
}

export interface RootLoggerOptions {
  level: string;
  service: "kapdh-api" | "kapdh-worker" | "kapdh-cli";
  /** Tujuan tulis (default stdout). Uji memakai stream memori untuk memeriksa redaksi. */
  destination?: DestinationStream;
}

export function createRootLogger(options: RootLoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: redactPaths(), censor: "[REDACTED]" },
      serializers: {
        req: requestSerializer,
        res: responseSerializer,
        err: safeError,
        error: safeError,
      },
    },
    options.destination,
  );
}

/** Ikatan korelasi dari konteks request/job aktif (N-14). */
function contextBindings(): Record<string, string> {
  const context = tryCtx();
  if (!context) return {};
  return context.jobId ? { request_id: context.requestId, job_id: context.jobId } : { request_id: context.requestId };
}

type Level = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/**
 * Logger untuk service dan job: `this.log.info("pesan", { payment_id })`. Data tambahan tetap melewati redaksi;
 * galat dicatat lewat `{ error }` yang diserialisasi aman (safeError).
 */
export class ContextLogger {
  constructor(private readonly logger: Logger) {}

  private write(level: Level, message: string, data?: Record<string, unknown>) {
    this.logger[level]({ ...contextBindings(), ...data }, message);
  }
  fatal(message: string, data?: Record<string, unknown>) {
    this.write("fatal", message, data);
  }
  error(message: string, data?: Record<string, unknown>) {
    this.write("error", message, data);
  }
  warn(message: string, data?: Record<string, unknown>) {
    this.write("warn", message, data);
  }
  info(message: string, data?: Record<string, unknown>) {
    this.write("info", message, data);
  }
  debug(message: string, data?: Record<string, unknown>) {
    this.write("debug", message, data);
  }
  child(module: string): ContextLogger {
    return new ContextLogger(this.logger.child({ module }));
  }
}

/** Fabrik logger injectable: `constructor(logs: AppLogger) { this.log = logs.for("PaymentsService"); }`. */
@Injectable()
export class AppLogger {
  constructor(@Inject(ROOT_LOGGER) private readonly root: Logger) {}

  for(module: string): ContextLogger {
    return new ContextLogger(this.root.child({ module }));
  }
}

/**
 * Jembatan LoggerService Nest ke pino agar log kerangka (startup, DI) juga JSON dengan level yang sama. Galat yang
 * diteruskan Nest sebagai objek Error diserialisasi aman.
 */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly root: Logger) {}

  private write(level: Level, message: unknown, optional: unknown[]) {
    const params = [...optional];
    const context = typeof params[params.length - 1] === "string" ? (params.pop() as string) : undefined;
    const data: Record<string, unknown> = { ...contextBindings(), ...(context ? { module: context } : {}) };
    if (message instanceof Error) {
      this.root[level]({ ...data, error: safeError(message) }, "galat");
      return;
    }
    // Nest meneruskan stack sebagai string tambahan pada error(); stack mentah tidak dicatat (bisa memuat pesan).
    this.root[level](data, typeof message === "string" ? message : JSON.stringify(message));
  }

  log(message: unknown, ...optional: unknown[]) {
    this.write("info", message, optional);
  }
  error(message: unknown, ...optional: unknown[]) {
    this.write("error", message, optional.length > 1 ? optional.slice(-1) : optional.filter((o) => !isStack(o)));
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.write("warn", message, optional);
  }
  debug(message: unknown, ...optional: unknown[]) {
    this.write("debug", message, optional);
  }
  verbose(message: unknown, ...optional: unknown[]) {
    this.write("trace", message, optional);
  }
  fatal(message: unknown, ...optional: unknown[]) {
    this.write("fatal", message, optional);
  }
}

function isStack(value: unknown): boolean {
  return typeof value === "string" && /\n\s+at /.test(value);
}
