import { PERMISSION_VALUES, type AdminRole, type Permission } from "@kapdh/contracts";
import { error, json, type MockRequest, type MockRoute, noContent, type S } from "./http";

/**
 * Tiruan auth admin: login dua tahap (F-02, AC F02-2), refresh lewat cookie HttpOnly, logout yang membutuhkan
 * access token berlaku (meniru server), /admin/me, dan reautentikasi (ARCHITECTURE §4.3). Pesan galat disamakan
 * dengan server (apps/api/src/auth/auth.service.ts).
 */
const ADMIN_EMAIL = "admin@kapdh.test";
/** Admin undangan yang belum mendaftarkan TOTP (F-16): login mengembalikan totp_enrollment_required. */
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
let pendingMfaToken: string | null = null;
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
      if ((email === ADMIN_EMAIL || email === INVITED_EMAIL) && body?.password === PASSWORD) {
        tokenSeq += 1;
        pendingMfaToken = `mock-mfa-${tokenSeq}`;
        const res: S["AdminLoginResponse"] = {
          mfa_token: pendingMfaToken,
          mfa_expires_at: new Date(Date.now() + 300_000).toISOString(),
          // Kontrak final C1: login selalu false dan admin undangan ditolak 401; pendaftaran TOTP dibuka dari
          // POST /admin/auth/invitations/accept (halaman /invite fase C). Mock lama mempertahankan jalur ini.
          totp_enrollment_required: email === INVITED_EMAIL,
        };
        return json(200, res);
      }
      return error(401, "UNAUTHENTICATED", "Email atau password salah.");
    },
  },
  {
    method: "POST",
    path: "/admin/auth/mfa",
    handler: ({ body }) => {
      const tokenOk = pendingMfaToken !== null && body?.mfa_token === pendingMfaToken;
      const backup = String(body?.backup_code ?? "").toUpperCase();
      const codeOk = body?.totp_code === TOTP || (backup === BACKUP_CODE && !usedBackupCodes.has(backup));
      if (!tokenOk || !codeOk)
        return error(401, "UNAUTHENTICATED", "Kode autentikator salah atau sesi masuk kedaluwarsa.");
      if (backup) usedBackupCodes.add(backup);
      pendingMfaToken = null;
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
      const me: S["AdminProfile"] = {
        admin_id: "0199e000-0000-7000-8000-0000000000ad",
        display_name: profile.display_name,
        role: profile.role,
        permissions: effectivePermissions(),
        permissions_version: profile.permissions_version,
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
      if (req.body?.password !== PASSWORD || req.body?.totp_code !== TOTP)
        return error(401, "UNAUTHENTICATED", "Sandi atau kode autentikator salah.");
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
