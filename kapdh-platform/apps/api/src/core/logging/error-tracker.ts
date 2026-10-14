import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Writable } from "node:stream";

/**
 * Pelacak galat kompatibel Sentry untuk GlitchTip (PRD 7.1 observabilitas, PRD 5.5 monitoring; docs/runbooks/
 * monitoring.md bagian 5). Dipasang sebagai stream pino tambahan untuk level `error`/`fatal`, sehingga setiap galat yang
 * sudah dicatat aman (safeError + redaksi logger, N-14) juga dikirim sebagai event, tanpa memanggil SDK di setiap tempat.
 *
 * Event dibangun dari DAFTAR PUTIH field log saja: pesan log (teks statis), tipe galat, kode (SQLSTATE/kode Node/kode
 * AppException), constraint, tabel, status, frame stack TANPA baris pesan, service, module, route, request_id/job_id.
 * Field lain di baris log (termasuk yang lolos redaksi) tidak pernah dikirim. Pengiriman fire-and-forget dengan batas
 * laju dan batas in-flight; kegagalan tidak pernah memengaruhi logging maupun request.
 */
export interface ErrorTrackingOptions {
  /** DSN Sentry/GlitchTip: https://<kunci-publik>@<host>[/<path>]/<id-proyek>. */
  dsn: string;
  environment: string;
  release?: string;
  /** Maksimal event per menit per proses (bawaan 30); kelebihannya dibuang dan dihitung. */
  maxPerMinute?: number;
  /** Untuk uji: fetch pengganti. */
  fetchImpl?: typeof fetch;
}

export interface ParsedDsn {
  envelopeUrl: string;
  publicKey: string;
  projectId: string;
}

/** Mengurai DSN; galat berisi pesan aman (kunci publik tidak dicetak). */
export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error("SENTRY_DSN bukan URL yang valid");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!url.username || !projectId || !/^\d+$/.test(projectId) || !/^https?:$/.test(url.protocol))
    throw new Error("SENTRY_DSN harus berbentuk https://<kunci>@<host>/<id-proyek>");
  const prefix = segments.length ? `/${segments.join("/")}` : "";
  return {
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    publicKey: decodeURIComponent(url.username),
    projectId,
  };
}

interface LogRecord {
  level?: string | number;
  time?: string | number;
  msg?: unknown;
  service?: unknown;
  module?: unknown;
  request_id?: unknown;
  job_id?: unknown;
  route?: unknown;
  req?: { route?: unknown };
  error?: unknown;
  err?: unknown;
}

const SAFE_TOKEN = /^[A-Za-z0-9 ._:/@()[\]{}<>,'"#$*+=?!-]{1,200}$/;
const str = (v: unknown, max = 200): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : typeof v === "number" ? String(v) : undefined;

/** Frame "at fungsi (berkas:baris:kolom)" -> frame Sentry (urutan Sentry: terlama lebih dahulu). */
function toFrames(
  frames: unknown,
): { function?: string; filename?: string; lineno?: number; colno?: number }[] {
  if (!Array.isArray(frames)) return [];
  return frames
    .filter((f): f is string => typeof f === "string")
    .slice(0, 30)
    .map((line) => {
      const m = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line.trim());
      if (!m) return { function: line.slice(0, 200) };
      return {
        ...(m[1] ? { function: m[1].slice(0, 200) } : {}),
        filename: m[2]!.slice(0, 300),
        lineno: Number(m[3]),
        colno: Number(m[4]),
      };
    })
    .reverse();
}

/** Event Sentry dari baris log pino (daftar putih). Diekspor untuk uji. */
export function eventFromLog(
  record: LogRecord,
  options: Pick<ErrorTrackingOptions, "environment" | "release">,
) {
  const error = (record.error ?? record.err ?? {}) as Record<string, unknown>;
  const type = str(error.type) ?? "LoggedError";
  const code = str(error.error_code, 64);
  const message = str(record.msg) ?? "galat";
  const route = str(record.route) ?? str(record.req?.route);
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    service: str(record.service, 64),
    module: str(record.module, 64),
    route,
    error_code: code,
    constraint: str(error.constraint, 64),
    table: str(error.table, 64),
    status: str(error.status, 8),
    request_id: str(record.request_id, 64),
    job_id: str(record.job_id, 200),
  }))
    if (value !== undefined && SAFE_TOKEN.test(value)) tags[key] = value;
  const time = typeof record.time === "string" ? Date.parse(record.time) : Number(record.time ?? Date.now());
  const frames = toFrames(error.frames);
  return {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: (Number.isFinite(time) ? time : Date.now()) / 1000,
    platform: "node",
    level: record.level === "fatal" || record.level === 60 ? "fatal" : "error",
    logger: tags.service ?? "kapdh",
    server_name: hostname().slice(0, 64),
    environment: options.environment,
    ...(options.release ? { release: options.release } : {}),
    message: { formatted: message.slice(0, 200) },
    // Pengelompokan: tipe + kode + pesan log (statis) + rute, bukan isi galat.
    fingerprint: [type, code ?? "-", message.slice(0, 100), route ?? "-"],
    exception: {
      values: [
        {
          type,
          value: code ? `${code}: ${message}`.slice(0, 200) : message.slice(0, 200),
          ...(frames.length ? { stacktrace: { frames } } : {}),
        },
      ],
    },
    tags,
  };
}

/** Stream pino tujuan level error: mengubah baris JSON menjadi envelope Sentry dan mengirimnya. */
export class ErrorTrackerStream extends Writable {
  private readonly dsn: ParsedDsn;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPerMinute: number;
  private windowStart = Date.now();
  private sentInWindow = 0;
  private inFlight = 0;
  /** Jumlah event yang dibuang (batas laju/in-flight) atau gagal dikirim; untuk uji/diagnosis. */
  dropped = 0;
  failed = 0;
  readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: ErrorTrackingOptions) {
    super();
    this.dsn = parseDsn(options.dsn);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxPerMinute = options.maxPerMinute ?? 30;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        this.capture(JSON.parse(line) as LogRecord);
      } catch {
        // Baris tidak dapat diurai: abaikan, logging utama tetap berjalan.
      }
    }
    callback();
  }

  private capture(record: LogRecord): void {
    const level = record.level;
    if (!(level === "error" || level === "fatal" || (typeof level === "number" && level >= 50))) return;
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.sentInWindow = 0;
    }
    if (this.sentInWindow >= this.maxPerMinute || this.inFlight >= 5) {
      this.dropped += 1;
      return;
    }
    this.sentInWindow += 1;
    const event = eventFromLog(record, this.options);
    const header = { event_id: event.event_id, sent_at: new Date(now).toISOString() };
    const body = `${JSON.stringify(header)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
    this.inFlight += 1;
    const sending = this.fetchImpl(this.dsn.envelopeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${this.dsn.publicKey}, sentry_client=kapdh-error-tracker/1`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => {
        if (!res.ok) this.failed += 1;
        return res.body?.cancel();
      })
      .catch(() => {
        this.failed += 1;
      })
      .finally(() => {
        this.inFlight -= 1;
        this.pending.delete(sending);
      });
    this.pending.add(sending);
  }

  /** Menunggu pengiriman yang sedang berjalan (uji, shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}

/** Opsi pelacakan galat dari env (SENTRY_DSN kosong = nonaktif). */
export function errorTrackingFromEnv(env: {
  NODE_ENV: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
}): ErrorTrackingOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    release: env.SENTRY_RELEASE,
  };
}
