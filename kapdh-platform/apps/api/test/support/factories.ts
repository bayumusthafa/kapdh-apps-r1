/**
 * Fixture bersama uji API (ARCHITECTURE §9.1). Data dibuat langsung di database dengan invarian skema yang sama
 * dengan alur produksi (nomor anggota dari nextval dalam transaksi yang sama, periode 12 bulan kalender Jakarta,
 * admin aktif dengan TOTP terverifikasi), lalu masuk lewat endpoint nyata (signInAlumni/signInAdmin).
 *
 *   const t = await createTestApp();
 *   const member = await createAlumni(t, { status: "expired" });
 *   const { accessToken } = await signInAlumni(t, member);
 *   const admin = await createAdmin(t, { permissions: ["payments.read"] });
 *   const session = await signInAdmin(t, admin);
 */
import type { Permission } from "@kapdh/contracts";
import {
  adminPermissions,
  admins,
  alumni,
  appSettings,
  mfaTotp,
  paymentMethods,
  users,
} from "@kapdh/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import { rows } from "../../src/core/db/rows.js";
import type { Db } from "../../src/core/db/types.js";
import { type Gender, memberNumber } from "../../src/core/membership/member-number.js";
import { addCalendarMonthsJakarta } from "../../src/core/membership/period.js";
import { SETTING_SCHEMAS, type SettingKey, type SettingValue } from "../../src/core/settings/keys.js";
import type { SettingsService } from "../../src/core/settings/settings.service.js";
import {
  ADMIN_INVITE_TTL_MS,
  adminInviteTokenHash,
  encryptSecret,
  newAdminInviteToken,
  newTotpSecret,
  totp,
} from "../../src/modules/auth/crypto.js";
import type { TestClock } from "./fakes.js";
import { httpClient } from "./http.js";
import { testEnv } from "./test-app.js";

/** Sandi bawaan fixture (memenuhi aturan PRD 2.5). */
export const DEFAULT_PASSWORD = "Kapdh#2026";
const DAY_MS = 24 * 3600_000;

let sequence = 0;
/** Email unik per pemanggilan (domain .test, data sintetis). */
export function uniqueEmail(prefix = "alumni"): string {
  return `${prefix}-${++sequence}-${uuidv7().slice(-8)}@contoh.test`;
}

const hashCache = new Map<string, Promise<string>>();
function hashPassword(password: string): Promise<string> {
  let hash = hashCache.get(password);
  if (!hash) {
    hash = bcrypt.hash(password, testEnv.BCRYPT_COST);
    hashCache.set(password, hash);
  }
  return hash;
}

interface Fixtures {
  db: Db;
  clock: TestClock;
}

// ------------------------------------------------------------------------------------------------ alumni

/** effective_status yang dihasilkan fixture (PRD 2.2) + pending_otp (belum verifikasi email). */
export type AlumniFixtureStatus =
  "pending_otp" | "unverified" | "verified" | "expiring" | "expired" | "suspended";

export interface CreateAlumniOptions {
  status?: AlumniFixtureStatus;
  email?: string;
  password?: string;
  fullName?: string;
  gender?: Gender;
  cohort?: number;
  classIn?: number;
  classOut?: number;
  city?: string | null;
  showInDirectory?: boolean;
  suspensionMessage?: string;
}

export interface AlumniFixture {
  userId: string;
  email: string;
  password: string;
  status: AlumniFixtureStatus;
  memberSeq: number | null;
  memberNumber: string | null;
  startsAt: Date | null;
  expiresAt: Date | null;
}

function periodFor(status: AlumniFixtureStatus, now: Date): { startsAt: Date; expiresAt: Date } | null {
  switch (status) {
    case "pending_otp":
    case "unverified":
      return null;
    case "verified":
    case "suspended": {
      const startsAt = new Date(now.getTime() - 30 * DAY_MS);
      return { startsAt, expiresAt: addCalendarMonthsJakarta(startsAt, 12) };
    }
    case "expiring": {
      const expiresAt = new Date(now.getTime() + 10 * DAY_MS);
      return { startsAt: addCalendarMonthsJakarta(expiresAt, -12), expiresAt };
    }
    case "expired": {
      const expiresAt = new Date(now.getTime() - DAY_MS);
      return { startsAt: addCalendarMonthsJakarta(expiresAt, -12), expiresAt };
    }
  }
}

/**
 * Alumni dengan effective_status tertentu. Selain pending_otp, akun `active`, email terverifikasi, dan nomor anggota
 * AA.SS.JK.N dialokasikan dari app.membership_no_seq dalam transaksi yang sama (alumni_member_seq_source_chk).
 */
export async function createAlumni(t: Fixtures, options: CreateAlumniOptions = {}): Promise<AlumniFixture> {
  const status = options.status ?? "verified";
  const now = t.clock.now();
  const password = options.password ?? DEFAULT_PASSWORD;
  const passwordHash = await hashPassword(password);
  const email = (options.email ?? uniqueEmail("alumni")).trim().toLowerCase();
  const userId = uuidv7();
  const profile = {
    fullName: options.fullName ?? "Alumni Uji",
    gender: options.gender ?? ("male" as Gender),
    cohort: options.cohort ?? 29,
    classIn: options.classIn ?? 1,
    classOut: options.classOut ?? 6,
  };
  const period = periodFor(status, now);
  return t.db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email,
      passwordHash,
      status: status === "pending_otp" ? "pending_otp" : "active",
      kind: "alumni",
      emailVerifiedAt: status === "pending_otp" ? null : now,
      policyVersion: "1",
      policyAcceptedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    let memberSeq: number | null = null;
    let number: string | null = null;
    if (status !== "pending_otp") {
      const [next] = rows<{ seq: string }>(
        await tx.execute(sql`select nextval('app.membership_no_seq')::text as seq`),
      );
      memberSeq = Number(next!.seq);
      number = memberNumber({ ...profile, seq: memberSeq });
    }
    await tx.insert(alumni).values({
      userId,
      ...profile,
      city: options.city ?? "Bandung",
      showInDirectory: options.showInDirectory ?? true,
      memberSeq,
      memberNumber: number,
      startsAt: period?.startsAt ?? null,
      expiresAt: period?.expiresAt ?? null,
      suspendedAt: status === "suspended" ? new Date(now.getTime() - 3600_000) : null,
      suspensionReason: status === "suspended" ? "Pelanggaran ketentuan komunitas (uji)" : null,
      suspensionMessage:
        status === "suspended" ? (options.suspensionMessage ?? "Akun dibatasi sementara.") : null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      userId,
      email,
      password,
      status,
      memberSeq,
      memberNumber: number,
      startsAt: period?.startsAt ?? null,
      expiresAt: period?.expiresAt ?? null,
    };
  });
}

export interface AlumniSession {
  accessToken: string;
  refreshToken: string;
}

/** Login alumni lewat POST /auth/login (AC F02-1). Gagal bila akun belum terverifikasi (pending_otp). */
export async function signInAlumni(
  t: { app: NestFastifyApplication },
  fixture: Pick<AlumniFixture, "email" | "password">,
  headers: Record<string, string> = {},
): Promise<AlumniSession> {
  const res = await httpClient(t.app).post(
    "/auth/login",
    { email: fixture.email, password: fixture.password },
    { headers },
  );
  expect(res.statusCode, `login alumni ${fixture.email}: ${res.body}`).toBe(200);
  const body = res.json() as { next: string; session?: { access_token: string; refresh_token: string } };
  expect(body.next, "akun pending_otp tidak menerima sesi").toBe("home");
  return { accessToken: body.session!.access_token, refreshToken: body.session!.refresh_token };
}

// ------------------------------------------------------------------------------------------------- admin

export interface CreateAdminOptions {
  role?: "super_admin" | "admin";
  permissions?: Permission[];
  linkedAlumniUserId?: string | null;
  status?: "active" | "disabled" | "invited";
  email?: string;
  password?: string;
  displayName?: string;
}

export interface AdminFixture {
  adminId: string;
  userId: string;
  email: string;
  password: string;
  role: "super_admin" | "admin";
  /** Secret TOTP; null untuk admin `invited` (TOTP didaftarkan saat aktivasi, F-16). */
  totpSecret: string;
  /** Token undangan mentah untuk admin `invited` (tautan /invite/<token>), selain itu null. */
  inviteToken: string | null;
  /** Langkah TOTP terakhir yang dipakai fixture (anti replay di server). */
  lastTotpStep?: number;
}

/**
 * Admin dengan izin tertentu (super_admin = semua izin tanpa baris admin_permissions). Status `active`/`disabled`:
 * TOTP terverifikasi. Status `invited`: belum ada TOTP, token undangan 72 jam dikembalikan (alur aktivasi F-16).
 */
export async function createAdmin(t: Fixtures, options: CreateAdminOptions = {}): Promise<AdminFixture> {
  const now = t.clock.now();
  const role = options.role ?? "admin";
  const status = options.status ?? "active";
  const password = options.password ?? DEFAULT_PASSWORD;
  const email = (options.email ?? uniqueEmail("admin")).trim().toLowerCase();
  const userId = uuidv7();
  const adminId = uuidv7();
  const totpSecret = newTotpSecret();
  const inviteToken = status === "invited" ? newAdminInviteToken() : null;
  await t.db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email,
      passwordHash: await hashPassword(password),
      status: "active",
      kind: "admin",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(admins).values({
      id: adminId,
      userId,
      linkedAlumniUserId: options.linkedAlumniUserId ?? null,
      displayName: options.displayName ?? "Admin Uji",
      role,
      status,
      activatedAt: status === "invited" ? null : now,
      disabledAt: status === "disabled" ? now : null,
      inviteTokenHash: inviteToken ? adminInviteTokenHash(inviteToken) : null,
      inviteExpiresAt: inviteToken ? new Date(now.getTime() + ADMIN_INVITE_TTL_MS) : null,
      createdAt: now,
      updatedAt: now,
    });
    if (options.permissions?.length)
      await tx
        .insert(adminPermissions)
        .values(options.permissions.map((permission) => ({ adminId, permission, createdAt: now })));
    if (status !== "invited")
      await tx.insert(mfaTotp).values({
        userId,
        secretEncrypted: encryptSecret(totpSecret, testEnv.TOTP_ENC_KEY),
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
  });
  return { adminId, userId, email, password, role, totpSecret, inviteToken };
}

export interface AdminSessionFixture {
  accessToken: string;
  /** Nilai cookie kapdh_admin_rt (refresh). */
  refreshCookie: string;
}

/**
 * Login admin dua tahap (AC F02-2): sandi → TOTP langkah waktu saat ini. Server menolak replay langkah yang sama,
 * jadi bila langkah ini sudah dipakai fixture, TestClock dimajukan ke langkah berikutnya.
 */
export async function signInAdmin(
  t: { app: NestFastifyApplication; clock: TestClock },
  admin: AdminFixture,
): Promise<AdminSessionFixture> {
  const api = httpClient(t.app);
  const login = await api.post("/admin/auth/login", { email: admin.email, password: admin.password });
  expect(login.statusCode, `login admin: ${login.body}`).toBe(200);
  let step = Math.floor(t.clock.now().getTime() / 30_000);
  if (admin.lastTotpStep !== undefined && step <= admin.lastTotpStep) {
    t.clock.advance((admin.lastTotpStep - step + 1) * 30_000);
    step = Math.floor(t.clock.now().getTime() / 30_000);
  }
  const mfa = await api.post("/admin/auth/mfa", {
    mfa_token: login.json().mfa_token,
    totp_code: totp(admin.totpSecret, t.clock.now()),
  });
  expect(mfa.statusCode, `MFA admin: ${mfa.body}`).toBe(200);
  admin.lastTotpStep = step;
  const cookie = /kapdh_admin_rt=([^;]+)/.exec(String(mfa.headers["set-cookie"] ?? ""));
  return { accessToken: mfa.json().access_token, refreshCookie: cookie?.[1] ?? "" };
}

// ------------------------------------------------------------------------------------------ data referensi

export interface CreatePaymentMethodOptions {
  kind?: "bank" | "ewallet";
  provider?: string;
  accountNumber?: string;
  accountHolder?: string;
  instructions?: string | null;
  active?: boolean;
  sortOrder?: number;
}

/** Metode bayar transfer manual (F-03); data sintetis. */
export async function createPaymentMethod(t: Fixtures, options: CreatePaymentMethodOptions = {}) {
  const now = t.clock.now();
  const [row] = await t.db
    .insert(paymentMethods)
    .values({
      id: uuidv7(),
      kind: options.kind ?? "bank",
      provider: options.provider ?? "Bank Syariah Uji",
      accountNumber: options.accountNumber ?? "7000123456",
      accountHolder: options.accountHolder ?? "Keluarga Alumni PDH (Uji)",
      instructions: options.instructions ?? null,
      active: options.active ?? true,
      sortOrder: options.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

/**
 * Menetapkan app_settings langsung (versi naik) dan membuang cache SettingsService. Nilai divalidasi skema yang sama
 * dengan API. Untuk menguji alur admin beraudit, pakai endpoint/SettingsService.update.
 */
export async function setSetting<K extends SettingKey>(
  t: { db: Db; clock: TestClock; settings: SettingsService },
  key: K,
  value: SettingValue<K>,
): Promise<number> {
  const parsed = SETTING_SCHEMAS[key].parse(value);
  const now = t.clock.now();
  const [row] = await t.db
    .insert(appSettings)
    .values({ key, value: parsed, version: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: parsed, version: sql`${appSettings.version} + 1`, updatedAt: now },
    })
    .returning({ version: appSettings.version });
  t.settings.invalidate(key);
  return row!.version;
}

/** Membaca versi app_settings saat ini (0 bila belum ada). */
export async function settingVersion(t: { db: Db }, key: SettingKey): Promise<number> {
  const [row] = await t.db
    .select({ version: appSettings.version })
    .from(appSettings)
    .where(eq(appSettings.key, key));
  return row?.version ?? 0;
}
