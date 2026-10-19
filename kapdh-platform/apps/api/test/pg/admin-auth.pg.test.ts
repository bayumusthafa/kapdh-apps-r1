/**
 * Admin-auth di bawah konkurensi nyata PostgreSQL 17 (F-02, F-16, PRD 8.2; ARCHITECTURE §2 butir 11, §9.2). API
 * berjalan dengan login role kapdh_app (grant production), sehingga transaksi benar-benar paralel (bukan diserialkan
 * seperti PGlite):
 *   - backup code yang sama dikirim bersamaan → tepat satu sesi (penghapusan jsonb bersyarat, sekali pakai);
 *   - mfa_token yang sama dipakai bersamaan dengan kode berbeda → tepat satu sesi, kode lain tidak dikonsumsi;
 *   - kode TOTP yang sama bersamaan → tepat satu sesi (last_used_step, anti replay);
 *   - penerimaan undangan dan konfirmasi TOTP bersamaan → tepat satu pemenang;
 *   - bootstrap CLI bersamaan untuk email yang sama → satu Super Admin (advisory lock);
 *   - login MFA bersamaan dengan reset MFA (urutan kunci admins → users → mfa_totp) → menunggu, bukan deadlock;
 *   - bootstrap ulang bersamaan dengan aktivasi /totp/confirm → menolak, Super Admin yang baru aktif utuh.
 */
import "reflect-metadata";
import { admins, auditLogs, mfaTotp, sessions, users } from "@kapdh/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { runBootstrapAdminCommand } from "../../src/cli/bootstrap-admin-command.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import {
  backupCodeHash,
  encryptSecret,
  newBackupCode,
  newTotpSecret,
  totp,
} from "../../src/core/identity/crypto.js";
import { MemoryRateLimitStore } from "../../src/core/rate-limit/store.js";
import { createAdmin, type EnrolledAdminFixture } from "../support/factories.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, createPgTestDatabase, type PgTestDatabase, withLockWaitGate } from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
const clock = new TestClock();
const limits = new MemoryRateLimitStore();
let owner: { db: Db; clock: TestClock };

beforeAll(async () => {
  tdb = await createPgTestDatabase("admin_auth", 8);
  api = connectAs(tdb, "kapdh_app", 12);
  owner = { db: tdb.db as unknown as Db, clock };
  app = await createApp(
    {
      env: testEnv,
      db: api.db as unknown as Db,
      mailer: new MemoryMailer(),
      clock,
      push: new FakePush(),
      redis: null,
    },
    { logger: false, rateLimitStore: limits },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});

const post = (url: string, payload: object, remoteAddress = "198.51.100.40") =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload, remoteAddress });

function tally(responses: { statusCode: number; json(): { code?: string } }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const res of responses) {
    const key = `${res.statusCode}:${res.json().code ?? "ok"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function mfaTokens(admin: EnrolledAdminFixture, count: number): Promise<string[]> {
  const tokens: string[] = [];
  for (let i = 0; i < count; i++) {
    const login = await post("/admin/auth/login", { email: admin.email, password: admin.password });
    expect(login.statusCode, login.body).toBe(200);
    tokens.push(login.json().mfa_token as string);
  }
  return tokens;
}

async function withBackupCodes(admin: EnrolledAdminFixture, count: number): Promise<string[]> {
  const codes = Array.from({ length: count }, () => newBackupCode());
  await owner.db
    .update(mfaTotp)
    .set({ backupCodeHashes: codes.map((c) => backupCodeHash(testEnv.OTP_HMAC_SECRET, c)) })
    .where(eq(mfaTotp.userId, admin.userId));
  return codes;
}

async function liveSessions(userId: string) {
  return owner.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** Menjalankan perintah bootstrap CLI (PRD 8.2) terhadap database lain; kode keluar dan seluruh keluaran. */
function runBootstrapCli(db: Db, email = "pemilik@kapdh.test"): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  return runBootstrapAdminCommand(["--email", email, "--name", "Fikri Ramadhan"], {
    db,
    env: { ADMIN_ORIGIN: testEnv.ADMIN_ORIGIN, BCRYPT_COST: 4 },
    now: clock.now(),
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => out.push(text) },
  }).then((code) => ({ code, out: out.join("") }));
}

async function loginAudits(adminId: string) {
  return owner.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, adminId), eq(auditLogs.action, "admin.login")));
}

describe("F-02 (PG 17): backup code dan mfa_token sekali pakai di bawah konkurensi", () => {
  it("F-02: backup code yang sama dikirim bersamaan dengan 5 mfa_token berbeda → tepat satu 200, empat 400", async () => {
    limits.clear();
    const admin = await createAdmin(owner, { role: "super_admin" });
    const [code] = await withBackupCodes(admin, 3);
    const tokens = await mfaTokens(admin, 5);
    const responses = await Promise.all(
      tokens.map((mfa_token) => post("/admin/auth/mfa", { mfa_token, backup_code: code })),
    );
    expect(tally(responses)).toEqual({ "200:ok": 1, "400:VALIDATION_ERROR": 4 });
    const [row] = await owner.db.select().from(mfaTotp).where(eq(mfaTotp.userId, admin.userId));
    expect(row!.backupCodeHashes).toHaveLength(2);
    expect(row!.backupCodeHashes).not.toContain(backupCodeHash(testEnv.OTP_HMAC_SECRET, code!));
    expect(await liveSessions(admin.userId)).toHaveLength(1);
    expect(await loginAudits(admin.adminId)).toHaveLength(1);
  });

  it("F-02: satu mfa_token dipakai bersamaan dengan 5 backup code berbeda → satu sesi; empat 401 dan kodenya tetap utuh", async () => {
    limits.clear();
    const admin = await createAdmin(owner, { role: "super_admin" });
    const codes = await withBackupCodes(admin, 10);
    const [token] = await mfaTokens(admin, 1);
    const responses = await Promise.all(
      codes.slice(0, 5).map((backup_code) => post("/admin/auth/mfa", { mfa_token: token, backup_code })),
    );
    expect(tally(responses)).toEqual({ "200:ok": 1, "401:UNAUTHENTICATED": 4 });
    // Hanya kode pemenang yang dikonsumsi; transaksi yang kalah dibatalkan (kode tidak terbuang).
    const [row] = await owner.db.select().from(mfaTotp).where(eq(mfaTotp.userId, admin.userId));
    expect(row!.backupCodeHashes).toHaveLength(9);
    expect(await liveSessions(admin.userId)).toHaveLength(1);
  });

  it("AC F02-2 RFC 6238 §5.2: kode TOTP yang sama bersamaan dengan 5 mfa_token berbeda → tepat satu sesi (last_used_step)", async () => {
    limits.clear();
    const admin = await createAdmin(owner, { role: "super_admin" });
    const tokens = await mfaTokens(admin, 5);
    const code = totp(admin.totpSecret, clock.now());
    const responses = await Promise.all(
      tokens.map((mfa_token) => post("/admin/auth/mfa", { mfa_token, totp_code: code })),
    );
    expect(tally(responses)).toEqual({ "200:ok": 1, "400:VALIDATION_ERROR": 4 });
    const [row] = await owner.db.select().from(mfaTotp).where(eq(mfaTotp.userId, admin.userId));
    expect(row!.lastUsedStep).toBe(Math.floor(clock.now().getTime() / 30_000));
    expect(await liveSessions(admin.userId)).toHaveLength(1);
  });

  it("ARCHITECTURE §2 butir 11 AC F02-2: login MFA bersamaan dengan reset MFA (admins → users → mfa_totp) → menunggu lalu 401, bukan deadlock 500", async () => {
    limits.clear();
    const admin = await createAdmin(owner, { role: "admin" });
    const [token] = await mfaTokens(admin, 1);
    const code = totp(admin.totpSecret, clock.now());
    const { result, lockWaitObserved } = await withLockWaitGate(tdb, async (hold) => {
      let signalLocked!: () => void;
      const locked = new Promise<void>((resolve) => (signalLocked = resolve));
      // Transaksi reset MFA seperti C7 (urutan kunci identitas admin): admins → users → mfa_totp.
      const reset = tdb.sql
        .begin(async (tx) => {
          await tx`select id from app.admins where id = ${admin.adminId} for update`;
          await tx`update app.users set session_version = session_version + 1 where id = ${admin.userId}`;
          signalLocked();
          // Ditahan sampai login MFA terlihat menunggu kunci, baru mfa_totp disentuh.
          await hold();
          await tx`delete from app.mfa_totp where user_id = ${admin.userId}`;
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await locked;
      const login = post("/admin/auth/mfa", { mfa_token: token, totp_code: code });
      const [resetError, response] = await Promise.all([reset, login]);
      return { resetError, response };
    });
    expect(lockWaitObserved, "login MFA benar-benar menunggu kunci transaksi reset").toBe(true);
    expect(result.resetError).toBeNull();
    // Setelah reset commit: autentikator sudah dihapus → mfa_token tidak lagi sah (401), tanpa sesi.
    expect(result.response.statusCode, result.response.body).toBe(401);
    expect(result.response.json().code).toBe("UNAUTHENTICATED");
    expect(await liveSessions(admin.userId)).toHaveLength(0);
    expect(await loginAudits(admin.adminId)).toHaveLength(0);
  });
});

describe("F-16 / PRD 8.2 (PG 17): undangan, aktivasi dan bootstrap bersamaan", () => {
  it("F-16: 5 penerimaan undangan bersamaan dengan token yang sama → tepat satu 200, sisanya 410", async () => {
    limits.clear();
    const invited = await createAdmin(owner, { status: "invited" });
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        post(
          "/admin/auth/invitations/accept",
          { invite_token: invited.inviteToken, password: `Pengurus#202${n}` },
          `198.51.100.${50 + n}`,
        ),
      ),
    );
    expect(tally(responses)).toEqual({ "200:ok": 1, "410:OTP_EXPIRED": 4 });
    const accepted = await owner.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, invited.adminId), eq(auditLogs.action, "admin.invitation_accepted")));
    expect(accepted).toHaveLength(1);
    const [admin] = await owner.db.select().from(admins).where(eq(admins.id, invited.adminId));
    expect(admin).toMatchObject({ status: "invited", inviteTokenHash: null });
  });

  it("F-16: 4 konfirmasi TOTP bersamaan → tepat satu aktivasi; yang kalah 403 'Aktivasi sudah selesai'", async () => {
    limits.clear();
    const invited = await createAdmin(owner, { status: "invited" });
    const accept = await post("/admin/auth/invitations/accept", {
      invite_token: invited.inviteToken,
      password: "Pengurus#2026",
    });
    const enrollToken = accept.json().mfa_token as string;
    const secret = (await post("/admin/auth/totp/enroll", { mfa_token: enrollToken })).json()
      .secret as string;
    const code = totp(secret, clock.now());
    const responses = await Promise.all(
      [1, 2, 3, 4].map(() => post("/admin/auth/totp/confirm", { mfa_token: enrollToken, totp_code: code })),
    );
    expect(tally(responses)).toEqual({ "200:ok": 1, "403:FORBIDDEN": 3 });
    const activated = await owner.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, invited.adminId), eq(auditLogs.action, "admin.activated")));
    expect(activated).toHaveLength(1);
    expect(await liveSessions(invited.userId)).toHaveLength(1);
  });

  it("PRD 8.2: dua bootstrap CLI bersamaan untuk email yang sama → satu Super Admin; tautan terakhir yang berlaku", async () => {
    // Database kosong sendiri: uji lain di berkas ini sudah membuat Super Admin aktif (bootstrap akan menolak).
    const fresh = await createPgTestDatabase("admin_bootstrap", 2);
    const cli = connectAs(fresh, "kapdh_app", 4);
    try {
      const run = () => runBootstrapCli(cli.db as unknown as Db);
      const results = await Promise.all([run(), run()]);
      expect(
        results.map((r) => r.code),
        results.map((r) => r.out).join("\n"),
      ).toEqual([0, 0]);
      expect(results.filter((r) => r.out.includes("diterbitkan ulang"))).toHaveLength(1);
      const accounts = await fresh.db.select().from(users).where(eq(users.email, "pemilik@kapdh.test"));
      expect(accounts).toHaveLength(1);
      const rows = await fresh.db.select().from(admins).where(eq(admins.userId, accounts[0]!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ role: "super_admin", status: "invited" });
      const audits = await fresh.db.select().from(auditLogs).where(eq(auditLogs.entityId, rows[0]!.id));
      expect(audits.map((a) => a.action).sort()).toEqual(["admin.bootstrap", "admin.bootstrap_reinvited"]);

      // Setelah ada Super Admin aktif yang dapat login, bootstrap menolak (exit 1, tanpa tautan).
      await createAdmin({ db: fresh.db as unknown as Db, clock }, { role: "super_admin" });
      const refused = await run();
      expect(refused.code).toBe(1);
      expect(refused.out).toContain("Super Admin aktif sudah ada");
      expect(refused.out).not.toContain("/invite#t=");
    } finally {
      await cli.sql.end({ timeout: 5 });
      await fresh.drop();
    }
  });

  it("PRD 8.2 ARCHITECTURE §2 butir 11: bootstrap ulang bersamaan dengan aktivasi /totp/confirm → menolak; Super Admin yang baru aktif tetap utuh", async () => {
    const fresh = await createPgTestDatabase("admin_bootstrap_race", 4);
    const cli = connectAs(fresh, "kapdh_app", 4);
    try {
      const first = await runBootstrapCli(cli.db as unknown as Db);
      expect(first.code, first.out).toBe(0);
      const [account] = await fresh.db.select().from(users).where(eq(users.email, "pemilik@kapdh.test"));
      const [invitedRow] = await fresh.db.select().from(admins).where(eq(admins.userId, account!.id));
      const adminId = invitedRow!.id;
      // Undangan sudah diterima (token dikonsumsi, sandi pilihan pemilik), seperti adminAcceptInvitation.
      const chosenHash = await bcrypt.hash("Pengurus#2026", 4);
      await fresh.db
        .update(admins)
        .set({ inviteTokenHash: null, inviteExpiresAt: null })
        .where(eq(admins.id, adminId));
      await fresh.db.update(users).set({ passwordHash: chosenHash }).where(eq(users.id, account!.id));
      const [userBefore] = await fresh.db.select().from(users).where(eq(users.id, account!.id));
      const secretEncrypted = encryptSecret(newTotpSecret(), testEnv.TOTP_ENC_KEY);

      const { result: rerun, lockWaitObserved } = await withLockWaitGate(fresh, async (hold) => {
        let signalLocked!: () => void;
        const locked = new Promise<void>((resolve) => (signalLocked = resolve));
        // /totp/confirm: baris admins dikunci (lockEnrollment), aktivasi commit setelah CLI terlihat menunggu.
        const confirm = fresh.db.transaction(async (tx) => {
          await tx.select({ id: admins.id }).from(admins).where(eq(admins.id, adminId)).for("update");
          signalLocked();
          await hold();
          const now = clock.now();
          await tx.insert(mfaTotp).values({
            userId: account!.id,
            secretEncrypted,
            verifiedAt: now,
            lastUsedStep: null,
            backupCodeHashes: [],
            createdAt: now,
            updatedAt: now,
          });
          await tx.update(admins).set({ status: "active", activatedAt: now }).where(eq(admins.id, adminId));
        });
        await locked;
        const cliRun = runBootstrapCli(cli.db as unknown as Db);
        await confirm;
        return cliRun;
      });
      expect(lockWaitObserved, "CLI benar-benar menunggu kunci baris admins").toBe(true);
      expect(rerun.code, rerun.out).toBe(1);
      expect(rerun.out).toContain("Super Admin aktif sudah ada");
      expect(rerun.out).not.toContain("/invite#t=");

      // Tidak ada yang direset: Super Admin aktif, TOTP terverifikasi, sandi pilihan pemilik, tanpa undangan baru.
      const [adminAfter] = await fresh.db.select().from(admins).where(eq(admins.id, adminId));
      expect(adminAfter).toMatchObject({ status: "active", inviteTokenHash: null });
      const totpAfter = await fresh.db.select().from(mfaTotp).where(eq(mfaTotp.userId, account!.id));
      expect(totpAfter).toHaveLength(1);
      expect(totpAfter[0]!.verifiedAt).not.toBeNull();
      const [userAfter] = await fresh.db.select().from(users).where(eq(users.id, account!.id));
      expect(userAfter!.passwordHash).toBe(chosenHash);
      expect(userAfter!.sessionVersion).toBe(userBefore!.sessionVersion);
      const audits = await fresh.db.select().from(auditLogs).where(eq(auditLogs.entityId, adminId));
      expect(audits.map((a) => a.action)).toEqual(["admin.bootstrap"]);

      // Bootstrap berikutnya tetap menolak (Super Admin aktif yang dapat login ada).
      const third = await runBootstrapCli(cli.db as unknown as Db);
      expect(third.code).toBe(1);
      expect(third.out).toContain("Super Admin aktif sudah ada");
    } finally {
      await cli.sql.end({ timeout: 5 });
      await fresh.drop();
    }
  });
});
