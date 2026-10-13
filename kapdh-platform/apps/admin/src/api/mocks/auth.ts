import { PERMISSION_VALUES, type AdminRole, type Permission } from "@kapdh/contracts";
import { error, json, type MockRequest, type MockRoute, noContent, type S } from "./http";

/**
 * Tiruan auth admin mengikuti kontrak admin-auth final (C1): login dua tahap (F-02, AC F02-2), refresh lewat
 * cookie HttpOnly, logout yang membutuhkan access token berlaku (meniru server), /admin/me, dan reautentikasi
 * (ARCHITECTURE §4.3).
 * - POST /admin/auth/login hanya untuk admin `active` dengan TOTP terverifikasi dan selalu
 *   `totp_enrollment_required: false`; admin `invited` ditolak 401 yang sama dengan sandi salah (F-16).
 * - Kode TOTP/backup salah di /admin/auth/mfa dan kredensial salah di /auth/reauth adalah 400 VALIDATION_ERROR
 *   dengan `field_errors` dan sisa percobaan; 401 hanya untuk token/sesi yang tidak berlaku; 5 kegagalan -> 429.
 */
const ADMIN_EMAIL = "admin@kapdh.test";
/**
 * Admin undangan yang belum menyelesaikan aktivasi (F-16): login menolaknya 401 seperti sandi salah. Pendaftaran
 * TOTP hanya lewat token pendaftaran dari penerimaan undangan (/invite#t=<token>), tidak pernah dari login.
 */
const INVITED_EMAIL = "baru@kapdh.test";
const PASSWORD = "Kapdh#2026";
const TOTP = "123456";
const BACKUP_CODE = "A1B2C3D4E5";

export const MOCK_CREDENTIALS = {
  email: ADMIN_EMAIL,
  invitedEmail: INVITED_EMAIL,
  password: PASSWORD,
  totp: TOTP,
  backupCode: BACKUP_CODE,
} as const;

const ACCESS_TTL_MS = 15 * 60_000;
const REAUTH_TTL_MS = 10 * 60_000;
/** mfa_token tahap sandi berumur 5 menit (audience kapdh-admin-mfa). */
const MFA_TOKEN_TTL_MS = 5 * 60_000;
/** Batas kegagalan kode per admin/sesi dalam 15 menit sebelum 429 RATE_LIMITED (kontrak admin-auth, auth). */
const MAX_CODE_FAILURES = 5;
const ADMIN_ID = "0199e000-0000-7000-8000-0000000000ad";

interface ProfileState {
  role: AdminRole;
  permissions: Permission[];
  display_name: string;
  permissions_version: number;
}

const DEFAULT_PROFILE: ProfileState = {
  role: "super_admin",
  permissions: [],
  display_name: "Bayu Musthafa",
  permissions_version: 1,
};

let profile: ProfileState = { ...DEFAULT_PROFILE };
/** Meniru cookie HttpOnly kapdh_admin_rt: sesi hidup sampai logout. */
let sessionActive = false;

/**
 * dev:mock saja: "cookie" sesi tiruan disimpan di sessionStorage agar muat ulang/HMR tidak memaksa login ulang
 * (meniru cookie HttpOnly kapdh_admin_rt). Uji (MODE=test) selalu mulai tanpa sesi.
 */
const PERSIST_KEY = "kapdh_mock_admin_session";
const persist = import.meta.env.MODE === "mock";
function setSessionActive(active: boolean): void {
  sessionActive = active;
  if (!persist) return;
  try {
    if (active) window.sessionStorage.setItem(PERSIST_KEY, "1");
    else window.sessionStorage.removeItem(PERSIST_KEY);
  } catch {
    // penyimpanan diblokir: sesi tiruan hanya di memori
  }
}
if (persist) {
  try {
    sessionActive = window.sessionStorage.getItem(PERSIST_KEY) === "1";
  } catch {
    setSessionActive(false);
  }
}
let pendingMfaToken: { token: string; expiresAt: number } | null = null;
/** Kegagalan kode berturut-turut (MFA dan reautentikasi dihitung terpisah). */
let mfaFailures = 0;
let reauthFailures = 0;
let tokenSeq = 0;
/** Kegagalan buatan POST /auth/refresh (uji): jaringan putus atau status HTTP tertentu, `remaining` kali. */
let refreshFailure: { mode: "network" | number; remaining: number } | null = null;
/** POST /auth/logout ditahan sampai dilepas (uji jaringan menggantung). */
let logoutHold: Promise<void> | null = null;
const validAccess = new Set<string>();
const reauthTokens = new Map<string, number>();
const usedBackupCodes = new Set<string>();

export interface RecordedRequest {
  method: string;
  path: string;
  background: boolean;
}

/** Log permintaan ke endpoint auth/profil, untuk uji (mis. "Tetap masuk" harus ping tanpa header latar). */
export const authRequests: RecordedRequest[] = [];

export function reset(): void {
  profile = { ...DEFAULT_PROFILE };
  setSessionActive(false);
  pendingMfaToken = null;
  mfaFailures = 0;
  reauthFailures = 0;
  refreshFailure = null;
  logoutHold = null;
  validAccess.clear();
  reauthTokens.clear();
  usedBackupCodes.clear();
  authRequests.length = 0;
}

function effectivePermissions(): Permission[] {
  // Server memberi super_admin SEMUA izin (auth.service.ts ALL_PERMISSIONS).
  return profile.role === "super_admin" ? [...PERMISSION_VALUES] : [...profile.permissions];
}

function issueAccess(): S["AdminSession"] {
  tokenSeq += 1;
  const token = `mock-access-${tokenSeq}`;
  validAccess.add(token);
  return {
    access_token: token,
    access_expires_at: new Date(Date.now() + ACCESS_TTL_MS).toISOString(),
    idle_timeout_seconds: 1800,
  };
}

/** Kembalikan respons 401 bila access token tidak berlaku; null bila berlaku. */
export function requireAdmin(req: MockRequest): Response | null {
  const token = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!sessionActive || !validAccess.has(token))
    return error(401, "UNAUTHENTICATED", "Sesi berakhir. Silakan masuk kembali.");
  return null;
}

/** Izin efektif admin tiruan; gunakan di area lain untuk meniru 403 FORBIDDEN. */
export function requirePermission(req: MockRequest, permission: Permission): Response | null {
  const unauth = requireAdmin(req);
  if (unauth) return unauth;
  if (!effectivePermissions().includes(permission))
    return error(403, "FORBIDDEN", "Anda tidak memiliki izin untuk tindakan ini.");
  return null;
}

/**
 * Izin efektif admin tiruan yang sedang masuk, untuk field yang dihitung server per pemanggil (mis.
 * `AdminPaymentDetail.actions`, PRD 2.3).
 */
export function mockHasPermission(permission: Permission): boolean {
  return effectivePermissions().includes(permission);
}

/** Identitas admin tiruan yang sedang masuk sebagai pelaku (decided_by, actor_admin, updated_by; F-17). */
export function mockAdminRef(): { admin_id: string; display_name: string } {
  return { admin_id: ADMIN_ID, display_name: profile.display_name };
}

/** Respons 429 setelah batas kegagalan kode terlampaui (PRD 2.5). */
function tooManyFailures(): Response {
  return error(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.", {
    retry_after_seconds: 900,
  });
}

/** Pesan galat isian kode salah beserta sisa percobaan, seperti server. */
function wrongCode(label: string, failures: number): string {
  return `${label} salah. Sisa percobaan ${Math.max(0, MAX_CODE_FAILURES - failures)}.`;
}

/** 403 REAUTH_REQUIRED bila header X-Reauth-Token tidak ada/kedaluwarsa (AC F15-3, F16-1). */
export function requireReauth(req: MockRequest): Response | null {
  const token = req.headers.get("X-Reauth-Token");
  const expiresAt = token ? reauthTokens.get(token) : undefined;
  if (!expiresAt || expiresAt < Date.now())
    return error(403, "REAUTH_REQUIRED", "Konfirmasi ulang identitas Anda untuk melanjutkan tindakan ini.");
  return null;
}

function record(req: MockRequest) {
  authRequests.push({
    method: req.method,
    path: req.path,
    background: req.headers.get("X-Background-Request") === "1",
  });
}

/** Kendali server tiruan untuk uji dan dev:mock. */
export const mockAuth = {
  /** Ubah peran/izin admin yang login; menaikkan permissions_version seperti perubahan oleh Super Admin. */
  setAdmin(next: Partial<Pick<ProfileState, "role" | "permissions" | "display_name">>): void {
    profile = { ...profile, ...next, permissions_version: profile.permissions_version + 1 };
  },
  /** Semua access token yang sudah terbit menjadi kedaluwarsa; cookie refresh tetap berlaku. */
  expireAccessTokens(): void {
    validAccess.clear();
  },
  /** Cabut sesi dari sisi server (mis. idle 30 menit atau logout perangkat lain). */
  revokeSession(): void {
    setSessionActive(false);
    validAccess.clear();
  },
  isSessionActive(): boolean {
    return sessionActive;
  },
  /**
   * POST /auth/refresh gagal `times` kali berikutnya tanpa menyentuh sesi: "network" meniru koneksi putus
   * (fetch ditolak), angka meniru status HTTP (mis. 502/503 dari proxy saat deploy, 429). null = normal lagi.
   */
  failRefresh(mode: "network" | number | null, times = Number.POSITIVE_INFINITY): void {
    refreshFailure = mode === null ? null : { mode, remaining: times };
  },
  /** Tahan POST /auth/logout (koneksi menggantung); fungsi yang dikembalikan melepasnya. */
  holdLogout(): () => void {
    let release: () => void = () => undefined;
    logoutHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      logoutHold = null;
      release();
    };
  },
};

export const routes: MockRoute[] = [
  {
    method: "POST",
    path: "/admin/auth/login",
    handler: ({ body }) => {
      const email = String(body?.email ?? "").toLowerCase();
      // Hanya admin aktif dengan TOTP terverifikasi; admin undangan ditolak sama dengan sandi salah (F-16).
      if (email === ADMIN_EMAIL && body?.password === PASSWORD) {
        tokenSeq += 1;
        pendingMfaToken = { token: `mock-mfa-${tokenSeq}`, expiresAt: Date.now() + MFA_TOKEN_TTL_MS };
        mfaFailures = 0;
        const res: S["AdminLoginResponse"] = {
          mfa_token: pendingMfaToken.token,
          mfa_expires_at: new Date(pendingMfaToken.expiresAt).toISOString(),
          totp_enrollment_required: false,
        };
        return json(200, res);
      }
      return error(401, "UNAUTHENTICATED", "Email atau sandi salah.");
    },
  },
  {
    method: "POST",
    path: "/admin/auth/mfa",
    handler: ({ body }) => {
      const tokenOk =
        pendingMfaToken !== null &&
        body?.mfa_token === pendingMfaToken.token &&
        pendingMfaToken.expiresAt > Date.now();
      // 401 hanya untuk mfa_token yang tidak sah/kedaluwarsa: UI kembali ke halaman masuk.
      if (!tokenOk)
        return error(401, "UNAUTHENTICATED", "Sesi masuk kedaluwarsa. Mulai lagi dari halaman masuk.");
      const hasTotp = typeof body?.totp_code === "string";
      const hasBackup = typeof body?.backup_code === "string";
      if (hasTotp === hasBackup)
        return error(400, "VALIDATION_ERROR", "Isi tepat satu: kode autentikator atau backup code.", {
          field_errors: { totp_code: ["Isi kode autentikator atau backup code."] },
        });
      if (mfaFailures >= MAX_CODE_FAILURES) return tooManyFailures();
      const backup = hasBackup ? String(body?.backup_code).toUpperCase() : "";
      const codeOk = hasTotp
        ? body?.totp_code === TOTP
        : backup === BACKUP_CODE && !usedBackupCodes.has(backup);
      if (!codeOk) {
        // Kode salah adalah galat formulir (400), bukan 401: mfa_token tetap berlaku (kontrak C1).
        mfaFailures += 1;
        const field = hasTotp ? "totp_code" : "backup_code";
        return error(400, "VALIDATION_ERROR", "Kode salah.", {
          field_errors: { [field]: [wrongCode(hasTotp ? "Kode autentikator" : "Backup code", mfaFailures)] },
        });
      }
      if (backup) usedBackupCodes.add(backup);
      pendingMfaToken = null;
      mfaFailures = 0;
      setSessionActive(true);
      return json(200, issueAccess());
    },
  },
  {
    method: "POST",
    path: "/auth/refresh",
    handler: (req) => {
      record(req);
      if (refreshFailure && refreshFailure.remaining > 0) {
        refreshFailure.remaining -= 1;
        if (refreshFailure.mode === "network") throw new TypeError("Failed to fetch");
        // Proxy/gateway membalas halaman HTML, bukan body kontrak `Error`.
        return new Response("<html><body>Bad Gateway</body></html>", {
          status: refreshFailure.mode,
          headers: { "content-type": "text/html" },
        });
      }
      if (!sessionActive) return error(401, "UNAUTHENTICATED", "Sesi berakhir. Silakan masuk kembali.");
      const { access_token, access_expires_at } = issueAccess();
      return json(200, { access_token, access_expires_at } satisfies S["TokenPair"]);
    },
  },
  {
    method: "POST",
    path: "/auth/logout",
    handler: async (req) => {
      record(req);
      if (logoutHold) await logoutHold;
      // Server: RequireAuth — logout dengan access token kedaluwarsa ditolak 401 dan sesi TIDAK dicabut.
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      setSessionActive(false);
      validAccess.clear();
      return noContent();
    },
  },
  {
    method: "GET",
    path: "/admin/me",
    handler: (req) => {
      record(req);
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      // email, has_linked_alumni dan backup_codes_remaining selalu dikirim server (deskripsi AdminProfile).
      const me: S["AdminProfile"] = {
        admin_id: ADMIN_ID,
        display_name: profile.display_name,
        email: ADMIN_EMAIL,
        role: profile.role,
        permissions: effectivePermissions(),
        permissions_version: profile.permissions_version,
        has_linked_alumni: true,
        backup_codes_remaining: 10 - usedBackupCodes.size,
        previous_login_at: null,
      };
      return json(200, me);
    },
  },
  {
    method: "POST",
    path: "/auth/reauth",
    handler: (req) => {
      record(req);
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      if (reauthFailures >= MAX_CODE_FAILURES) return tooManyFailures();
      // Kredensial salah = 400 VALIDATION_ERROR dengan field_errors (kontrak auth: bukan 401).
      // Admin: sandi DAN tepat satu dari totp_code atau backup_code (sekali pakai).
      const backup =
        typeof req.body?.backup_code === "string" ? String(req.body.backup_code).toUpperCase() : null;
      const fieldErrors: Record<string, string[]> = {};
      if (req.body?.password !== PASSWORD) fieldErrors.password = ["Sandi salah."];
      else if (backup !== null && (backup !== BACKUP_CODE || usedBackupCodes.has(backup)))
        fieldErrors.backup_code = ["Backup code salah."];
      else if (backup === null && req.body?.totp_code !== TOTP)
        fieldErrors.totp_code = ["Kode autentikator salah."];
      if (Object.keys(fieldErrors).length > 0) {
        reauthFailures += 1;
        const remaining = `Sisa percobaan ${Math.max(0, MAX_CODE_FAILURES - reauthFailures)}.`;
        for (const messages of Object.values(fieldErrors)) messages.push(remaining);
        return error(400, "VALIDATION_ERROR", "Sandi atau kode autentikator salah.", {
          field_errors: fieldErrors,
        });
      }
      reauthFailures = 0;
      if (backup !== null) usedBackupCodes.add(backup);
      tokenSeq += 1;
      const token = `mock-reauth-${tokenSeq}`;
      const expiresAt = Date.now() + REAUTH_TTL_MS;
      reauthTokens.set(token, expiresAt);
      return json(200, {
        reauth_token: token,
        expires_at: new Date(expiresAt).toISOString(),
      } satisfies S["ReauthResponse"]);
    },
  },
];
