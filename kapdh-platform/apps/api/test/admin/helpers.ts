/**
 * Utilitas uji modul admin (F-15..F-17): sesi admin ber-MFA lewat endpoint nyata dan token X-Reauth-Token setara
 * POST /auth/reauth kontrak C1 (sid = keluarga sesi, level 2 untuk admin).
 */
import type { Permission } from "@kapdh/contracts";
import { sessions } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { TokenService } from "../../src/core/identity/token.service.js";
import { type CreateAdminOptions, createAdmin, type EnrolledAdminFixture, signInAdmin } from "../support/factories.js";
import type { TestApp } from "../support/test-app.js";

export interface AdminActor {
  admin: EnrolledAdminFixture;
  token: string;
  /** Header X-Reauth-Token baru (berlaku 10 menit sejak Clock uji saat ini). */
  reauth(): Promise<string>;
  /** Header lengkap untuk operasi sensitif: Authorization + X-Reauth-Token (+ If-Match bila diberikan). */
  sensitive(ifMatch?: string | number): Promise<{ token: string; headers: Record<string, string> }>;
}

export async function reauthTokenFor(t: TestApp, accessToken: string, level = 2): Promise<string> {
  const claims = decodeJwt(accessToken);
  const [row] = await t.db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.id, String(claims.sid)));
  const signed = await t.app
    .get(TokenService)
    .signReauth({ userId: String(claims.sub), familyId: row!.familyId, level });
  return signed.token;
}

/** Admin aktif ber-TOTP yang sudah masuk (AC F02-2). */
export async function adminActor(
  t: TestApp,
  options: CreateAdminOptions & { permissions?: Permission[] } = {},
): Promise<AdminActor> {
  const admin = await createAdmin(t, { ...options, status: "active" });
  const session = await signInAdmin(t, admin);
  const reauth = () => reauthTokenFor(t, session.accessToken);
  return {
    admin,
    token: session.accessToken,
    reauth,
    sensitive: async (ifMatch) => ({
      token: session.accessToken,
      headers: {
        "x-reauth-token": await reauth(),
        ...(ifMatch === undefined ? {} : { "if-match": String(ifMatch) }),
      },
    }),
  };
}

export const superAdminActor = (t: TestApp, options: CreateAdminOptions = {}) =>
  adminActor(t, { ...options, role: "super_admin" });
