import { checkPassword } from "@kapdh/shared";
import {
  mockAuth,
  mockCheckPassword,
  mockReplaceBackupCodes,
  mockSetPassword,
  requireAdmin,
  requireReauth,
} from "./auth";
import { error, json, type MockRequest, type MockRoute, noContent, paginate, type S } from "./http";

/**
 * Tiruan keamanan akun admin sendiri (kontrak auth + admin-auth C1, F-02, AC F02-4, F02-6, N-08):
 * - GET /auth/sessions: satu item per keluarga sesi admin yang masih berlaku (tanpa token/IP), urut created_at
 *   menurun; `current` menandai sesi pemanggil.
 * - DELETE /auth/sessions/{id}: cabut satu perangkat; sesi saat ini = logout; tidak ada/milik orang lain = 404.
 * - POST /auth/logout-all: semua sesi dicabut termasuk sesi ini (AC F02-6).
 * - POST /admin/auth/password/change: sandi lama wajib (salah = 400 `field_errors.current_password`, 5 kegagalan
 *   = 429), aturan byte PRD 2.5 untuk sandi baru, sesi lain dicabut, sesi ini tetap (AC F02-4).
 * - POST /admin/auth/backup-codes: wajib reautentikasi; 10 kode baru menggantikan semua kode lama.
 * Data contoh bukan bukti AC (PRD 7.3).
 */
type Session = S["Session"];

export const CURRENT_SESSION_ID = "0199e000-0000-7000-8000-00000000c501";
const MAX_FAILURES = 5;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HOUR = 3_600_000;

export interface AccountRequestLog {
  method: string;
  path: string;
  reauth: boolean;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
}

/** Log permintaan akun (uji: header reautentikasi, isi body tanpa disimpan di tempat lain). */
export const accountRequests: AccountRequestLog[] = [];

let others: Session[] = [];
let passwordFailures = 0;
let failNextSessions: number | null = null;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fixtures(): Session[] {
  return [
    {
      id: "0199e000-0000-7000-8000-00000000c502",
      audience: "admin",
      device_name: "Firefox di Ubuntu",
      platform: "web",
      app_version: null,
      created_at: iso(-3 * 24 * HOUR),
      last_seen_at: iso(-5 * HOUR),
      expires_at: iso(4 * 24 * HOUR),
      current: false,
    },
    {
      id: "0199e000-0000-7000-8000-00000000c503",
      audience: "admin",
      device_name: "Safari di macOS",
      platform: "web",
      app_version: null,
      created_at: iso(-6 * 24 * HOUR),
      last_seen_at: iso(-2 * 24 * HOUR),
      expires_at: iso(1 * 24 * HOUR),
      current: false,
    },
  ];
}

export function reset(): void {
  others = fixtures();
  passwordFailures = 0;
  failNextSessions = null;
  accountRequests.length = 0;
}
reset();

function log(req: MockRequest): void {
  accountRequests.push({
    method: req.method,
    path: req.path,
    reauth: req.headers.has("X-Reauth-Token"),
    idempotencyKey: req.headers.get("Idempotency-Key"),
    body: req.body,
  });
}

function currentSession(): Session {
  return {
    id: CURRENT_SESSION_ID,
    audience: "admin",
    device_name: "Chrome di Windows",
    platform: "web",
    app_version: null,
    created_at: iso(-1 * HOUR),
    last_seen_at: iso(0),
    expires_at: iso(7 * 24 * HOUR),
    current: true,
  };
}

function newBackupCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    let raw = "";
    for (let i = 0; i < 10; i += 1) raw += BASE32[Math.floor(Math.random() * BASE32.length)];
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Kendali server tiruan untuk uji dan dev:mock. */
export const mockAccount = {
  /** GET /auth/sessions berikutnya gagal dengan status ini (uji keadaan galat). */
  failNextSessions(status: number): void {
    failNextSessions = status;
  },
  /** Jumlah sesi lain milik admin yang masih berlaku. */
  otherSessionCount(): number {
    return others.length;
  },
  /** Tambah sesi lain (mis. login dari perangkat kedua) untuk uji paging. */
  addSessions(count: number): void {
    for (let i = 0; i < count; i += 1)
      others.push({
        id: `0199e000-0000-7000-8000-${(0xd00 + i).toString(16).padStart(12, "0")}`,
        audience: "admin",
        device_name: `Peramban ${i + 1}`,
        platform: "web",
        app_version: null,
        created_at: iso(-(10 + i) * 24 * HOUR),
        last_seen_at: iso(-(10 + i) * 24 * HOUR),
        expires_at: iso(HOUR),
        current: false,
      });
  },
};

export const routes: MockRoute[] = [
  {
    method: "GET",
    path: "/auth/sessions",
    handler: (req) => {
      log(req);
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      if (failNextSessions !== null) {
        failNextSessions = null;
        return error(500, "INTERNAL_ERROR", "Terjadi kesalahan. Coba lagi.");
      }
      // Urut created_at menurun lalu id (kontrak listSessions); sesi saat ini dibuat paling akhir.
      const all = [currentSession(), ...others].sort(
        (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
      );
      const { items, next_cursor } = paginate(all, req.url);
      return json(200, { items, next_cursor } satisfies S["SessionPage"]);
    },
  },
  {
    method: "DELETE",
    path: "/auth/sessions/{sessionId}",
    handler: (req) => {
      log(req);
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      const id = req.params.sessionId ?? "";
      if (id === CURRENT_SESSION_ID) {
        mockAuth.revokeSession();
        return noContent();
      }
      const before = others.length;
      others = others.filter((s) => s.id !== id);
      return others.length < before ? noContent() : error(404, "NOT_FOUND", "Sesi tidak ditemukan.");
    },
  },
  {
    method: "POST",
    path: "/auth/logout-all",
    handler: (req) => {
      log(req);
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      others = [];
      mockAuth.revokeSession();
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/admin/auth/password/change",
    handler: (req) => {
      log(req);
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      if (passwordFailures >= MAX_FAILURES)
        return error(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.", {
          retry_after_seconds: 900,
        });
      const current = req.body?.current_password;
      const next = req.body?.new_password;
      if (typeof current !== "string" || !mockCheckPassword(current)) {
        passwordFailures += 1;
        return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          field_errors: {
            current_password: [`Sandi saat ini salah. Sisa percobaan ${MAX_FAILURES - passwordFailures}.`],
          },
        });
      }
      if (typeof next !== "string" || !checkPassword(next).valid)
        return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          field_errors: {
            new_password: ["Sandi wajib 8-72 byte dengan huruf besar, huruf kecil, angka, dan simbol."],
          },
        });
      passwordFailures = 0;
      mockSetPassword(next);
      // Sesi lain dicabut; sesi saat ini tetap (AC F02-4).
      others = [];
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/admin/auth/backup-codes",
    handler: (req) => {
      log(req);
      const denied = requireAdmin(req) ?? requireReauth(req);
      if (denied) return denied;
      const codes = newBackupCodes();
      mockReplaceBackupCodes(codes);
      return json(200, {
        backup_codes: codes,
        generated_at: new Date().toISOString(),
      } satisfies S["AdminBackupCodes"]);
    },
  },
];
