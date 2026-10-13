import type { BaseEnv } from "@kapdh/config";
import type { FastifyReply } from "fastify";

/**
 * Cookie refresh web admin (PRD 5.2): HttpOnly, SameSite=Strict, path hanya /api/v1/auth sehingga cookie tidak
 * terkirim ke endpoint lain. Diterbitkan modul admin-auth (tahap TOTP) dan diputar/dihapus modul auth
 * (POST /auth/refresh, /auth/logout), karena itu milik core.
 */
export const ADMIN_REFRESH_COOKIE = "kapdh_admin_rt";
export const ADMIN_REFRESH_COOKIE_PATH = "/api/v1/auth";

/** Cookie `Secure` di semua lingkungan kecuali development/test (HTTP lokal). */
export function secureCookies(env: Pick<BaseEnv, "NODE_ENV">): boolean {
  return env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
}

export function setAdminRefreshCookie(reply: FastifyReply, token: string, expires: Date, secure: boolean) {
  reply.setCookie(ADMIN_REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: ADMIN_REFRESH_COOKIE_PATH,
    expires,
  });
}

export function clearAdminRefreshCookie(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(ADMIN_REFRESH_COOKIE, {
    path: ADMIN_REFRESH_COOKIE_PATH,
    httpOnly: true,
    secure,
    sameSite: "strict",
  });
}
