/**
 * Bantuan uji modul admin-auth (F-02, F-16, PRD 8.2): menjalankan alur aktivasi undangan nyata lewat HTTP dan
 * menerbitkan token reautentikasi untuk keluarga sesi admin.
 */
import { sessions } from "@kapdh/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import type { Db } from "../../src/core/db/types.js";
import { totp } from "../../src/core/identity/crypto.js";
import { TokenService } from "../../src/core/identity/token.service.js";
import type { TestClock } from "../support/fakes.js";
import { httpClient } from "../support/http.js";

/** Sandi baru pilihan admin saat menerima undangan (memenuhi aturan PRD 2.5). */
export const NEW_ADMIN_PASSWORD = "Pengurus#2026";

export const stepOf = (at: Date) => Math.floor(at.getTime() / 30_000);

export interface ActivatedAdmin {
  secret: string;
  accessToken: string;
  refreshCookie: string;
  backupCodes: string[];
  /** Langkah TOTP terakhir yang dipakai (server menolak langkah <= ini). */
  lastStep: number;
}

/** Menerima undangan lalu mengembalikan mfa_token pendaftaran (kontrak adminAcceptInvitation). */
export async function acceptInvitation(
  app: NestFastifyApplication,
  inviteToken: string,
  password = NEW_ADMIN_PASSWORD,
): Promise<string> {
  const res = await httpClient(app).post("/admin/auth/invitations/accept", {
    invite_token: inviteToken,
    password,
  });
  expect(res.statusCode, `accept: ${res.body}`).toBe(200);
  return res.json().mfa_token as string;
}

/** Alur undangan lengkap: accept → /totp/enroll → /totp/confirm (PRD 8.2 langkah 3, F-16). */
export async function activateInvitation(
  t: { app: NestFastifyApplication; clock: TestClock },
  inviteToken: string,
  password = NEW_ADMIN_PASSWORD,
): Promise<ActivatedAdmin> {
  const api = httpClient(t.app);
  const enrollToken = await acceptInvitation(t.app, inviteToken, password);
  const enroll = await api.post("/admin/auth/totp/enroll", { mfa_token: enrollToken });
  expect(enroll.statusCode, `enroll: ${enroll.body}`).toBe(200);
  const secret = enroll.json().secret as string;
  const confirm = await api.post("/admin/auth/totp/confirm", {
    mfa_token: enrollToken,
    totp_code: totp(secret, t.clock.now()),
  });
  expect(confirm.statusCode, `confirm: ${confirm.body}`).toBe(200);
  const cookie = /kapdh_admin_rt=([^;]+)/.exec(String(confirm.headers["set-cookie"] ?? ""));
  return {
    secret,
    accessToken: confirm.json().session.access_token as string,
    refreshCookie: cookie?.[1] ?? "",
    backupCodes: confirm.json().backup_codes as string[],
    lastStep: stepOf(t.clock.now()),
  };
}

/** Memajukan TestClock ke langkah TOTP berikutnya yang belum dipakai lalu menghitung kodenya. */
export function freshTotp(
  clock: TestClock,
  secret: string,
  lastStep: number,
): { code: string; step: number } {
  if (stepOf(clock.now()) <= lastStep) clock.advance((lastStep - stepOf(clock.now()) + 1) * 30_000);
  return { code: totp(secret, clock.now()), step: stepOf(clock.now()) };
}

/** Kode 6 digit yang pasti TIDAK cocok dengan langkah -1, 0, +1 (toleransi jam RFC 6238) pada waktu `at`. */
export function wrongTotpFor(secret: string, at: Date, offset = 1): string {
  const accepted = new Set([-30_000, 0, 30_000].map((d) => totp(secret, new Date(at.getTime() + d))));
  for (let n = Number(totp(secret, at)) + offset; ; n++) {
    const code = String(n % 1_000_000).padStart(6, "0");
    if (!accepted.has(code)) return code;
  }
}

/** Isi klaim JWT tanpa verifikasi (hanya untuk uji). */
export function jwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/** Keluarga sesi (Session.id) dari access token: klaim `sid` adalah id baris sesi. */
export async function familyIdOf(db: Db, accessToken: string): Promise<string> {
  const [row] = await db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.id, String(jwtClaims(accessToken).sid)));
  return row!.familyId;
}

/** Token X-Reauth-Token (setara POST /auth/reauth) untuk keluarga sesi access token dengan tingkat faktor tertentu. */
export async function reauthTokenFor(
  t: { app: NestFastifyApplication; db: Db },
  userId: string,
  accessToken: string,
  level = 2,
): Promise<string> {
  const tokens = t.app.get(TokenService);
  const familyId = await familyIdOf(t.db, accessToken);
  return (await tokens.signReauth({ userId, familyId, level })).token;
}
