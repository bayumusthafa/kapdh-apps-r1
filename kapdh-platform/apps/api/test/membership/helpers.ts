/**
 * Bantuan uji modul membership (ARCHITECTURE §9.1): penerapan payment paid lewat MembershipKernel (alur persetujuan
 * modul payments tanpa modul payments), token reautentikasi admin, dan pemanggil endpoint yang sering dipakai.
 */
import type { Permission } from "@kapdh/contracts";
import { sessions } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { TokenService } from "../../src/core/identity/token.service.js";
import { MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { expectOperation } from "../support/contract.js";
import {
  type AdminSessionFixture,
  createAdmin,
  createMembershipPayment,
  type EnrolledAdminFixture,
  signInAdmin,
} from "../support/factories.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";

/** Persetujuan iuran seperti modul payments: payment paid lalu MembershipKernel.applyPaidPayment (AC F04-1). */
export async function approveMembershipPayment(
  t: TestApp,
  userId: string,
  type: "registration" | "renewal",
  approvedAt = t.clock.now(),
) {
  const payment = await createMembershipPayment(t, { userId, type, status: "paid", decidedAt: approvedAt });
  const kernel = t.app.get(MembershipKernel);
  const applied = await runAsSystem(() =>
    t.db.transaction((tx) => kernel.applyPaidPayment(tx, { id: payment.id }, approvedAt)),
  );
  return { payment, applied };
}

export interface AdminActor {
  admin: EnrolledAdminFixture;
  session: AdminSessionFixture;
  token: string;
}

/** Admin aktif ber-TOTP dengan izin tertentu yang sudah masuk (AC F02-2). */
export async function adminWith(
  t: TestApp,
  permissions: Permission[],
  options: { role?: "super_admin" | "admin"; linkedAlumniUserId?: string | null } = {},
): Promise<AdminActor> {
  const admin = await createAdmin(t, {
    permissions,
    role: options.role ?? "admin",
    linkedAlumniUserId: options.linkedAlumniUserId ?? null,
    displayName: `Pengurus ${uuidv7().slice(-4)}`,
  });
  const session = await signInAdmin(t, admin);
  return { admin, session, token: session.accessToken };
}

/** X-Reauth-Token seperti POST /auth/reauth (kontrak C1): `sid` = keluarga sesi pemanggil, level 2 untuk admin. */
export async function reauthTokenFor(t: TestApp, accessToken: string, level = 2): Promise<string> {
  const claims = decodeJwt(accessToken);
  const [row] = await t.db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.id, String(claims.sid)));
  return (
    await t.app.get(TokenService).signReauth({ userId: String(claims.sub), familyId: row!.familyId, level })
  ).token;
}

/** GET /me/card yang wajib 200 dan sesuai kontrak MemberCard. */
export async function getCard(t: TestApp, token: string) {
  const res = await httpClient(t.app).get("/me/card", { token });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/me/card", res) as {
    status_label: string;
    member_number: string;
    qr: { url: string; token_expires_at: string } | null;
    expires_at: string | null;
    action: string | null;
    open_payment_id: string | null;
    renewal_opens_at: string | null;
    offline_valid_until: string | null;
    synced_at: string;
    profession_label: string | null;
    city: string | null;
    avatar_url: string | null;
    cohort: number;
    cohort_code: string;
    graduation_year: number;
    full_name: string;
  };
}

/** Token dan nomor dari isi QR `${PUBLIC_WEB_URL}/kta/<nomor>#t=<token>`. */
export function parseQr(url: string): { memberNumber: string; token: string } {
  const match = /\/kta\/([^#]+)#t=(.+)$/.exec(url);
  expect(match, `isi QR tidak berbentuk /kta/<nomor>#t=<token>: ${url}`).not.toBeNull();
  return { memberNumber: decodeURIComponent(match![1]!), token: match![2]! };
}

/** POST /public/kta/verify (tanpa autentikasi) beserta validasi kontrak. */
export async function verifyKta(
  t: TestApp,
  memberNumber: string,
  token: string,
  headers: Record<string, string> = {},
) {
  const res = await httpClient(t.app).post(
    "/public/kta/verify",
    { member_number: memberNumber, token },
    { headers },
  );
  const body = expectOperation("post", "/public/kta/verify", res) as {
    result: string;
    checked_at: string;
    expiring: boolean;
    member: {
      full_name: string;
      cohort_code: string;
      member_number: string;
      expires_at: string;
      avatar_url: string | null;
    } | null;
  };
  return { res, body };
}
