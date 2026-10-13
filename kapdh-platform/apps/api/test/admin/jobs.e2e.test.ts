import { admins, deviceTokens, idempotencyKeys, otpCodes, sessions } from "@kapdh/database";
import { eq, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { OutboxService } from "../../src/core/outbox/outbox.service.js";
import { AdminMailJob } from "../../src/modules/admin/admin-mail.job.js";
import {
  MAINTENANCE_CLEANUP_EVERY_MS,
  OTP_RETENTION_MS,
  SESSION_RETENTION_MS,
} from "../../src/modules/admin/maintenance-cleanup.job.js";
import { createAdmin, createAlumni } from "../support/factories.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const DAY = 24 * 3600_000;
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;
const jobCtx = { jobId: "uji", requestId: "uji", logger };

describe("Job maintenance.cleanup harian (ARCHITECTURE §4.8)", () => {
  it("terdaftar harian; menghapus kunci idempotensi, OTP dan sesi lama saja; sesi yang dirujuk token push aktif dipertahankan", async () => {
    expect(t.jobs.registry.scheduledJob("maintenance.cleanup")?.everyMs).toBe(MAINTENANCE_CLEANUP_EVERY_MS);
    expect(MAINTENANCE_CLEANUP_EVERY_MS).toBe(DAY);
    const now = t.clock.now();
    const member = await createAlumni(t, { status: "verified" });
    const ago = (ms: number) => new Date(now.getTime() - ms);

    const keyOld = uuidv7();
    const keyLive = uuidv7();
    await t.db.insert(idempotencyKeys).values([
      { id: keyOld, scope: member.userId, endpoint: "POST /uji", key: uuidv7(), payloadHash: "h", expiresAt: ago(1000) },
      { id: keyLive, scope: member.userId, endpoint: "POST /uji", key: uuidv7(), payloadHash: "h", expiresAt: ago(-DAY) },
    ]);
    const otpOld = uuidv7();
    const otpRecent = uuidv7();
    await t.db.insert(otpCodes).values([
      {
        id: otpOld,
        userId: member.userId,
        purpose: "password_reset",
        codeHmac: "x",
        expiresAt: ago(OTP_RETENTION_MS + 1000),
        resendAvailableAt: ago(OTP_RETENTION_MS + 2000),
        consumedAt: ago(OTP_RETENTION_MS + 1000),
      },
      {
        id: otpRecent,
        userId: member.userId,
        purpose: "deletion",
        codeHmac: "y",
        expiresAt: ago(DAY),
        resendAvailableAt: ago(DAY),
        consumedAt: ago(DAY),
      },
    ]);
    const session = (id: string, expiresAt: Date) => ({
      id,
      userId: member.userId,
      familyId: id,
      refreshHash: `rh-${id}`,
      audience: "mobile",
      expiresAt,
    });
    const oldSession = uuidv7();
    const oldWithPush = uuidv7();
    const recentSession = uuidv7();
    await t.db
      .insert(sessions)
      .values([
        session(oldSession, ago(SESSION_RETENTION_MS + 1000)),
        session(oldWithPush, ago(SESSION_RETENTION_MS + 1000)),
        session(recentSession, ago(DAY)),
      ]);
    await t.db
      .insert(deviceTokens)
      .values({ id: uuidv7(), userId: member.userId, sessionId: oldWithPush, platform: "android", token: `tok-${uuidv7()}` });

    await t.jobs.runScheduled("maintenance.cleanup");

    expect((await t.db.select().from(idempotencyKeys).where(inArray(idempotencyKeys.id, [keyOld, keyLive]))).map((r) => r.id)).toEqual([keyLive]);
    expect((await t.db.select().from(otpCodes).where(inArray(otpCodes.id, [otpOld, otpRecent]))).map((r) => r.id)).toEqual([otpRecent]);
    const left = (
      await t.db.select().from(sessions).where(inArray(sessions.id, [oldSession, oldWithPush, recentSession]))
    ).map((r) => r.id);
    expect(left.sort()).toEqual([oldWithPush, recentSession].sort());
    // Idempoten: eksekusi kedua tidak gagal dan tidak menghapus apa pun lagi.
    await t.jobs.runScheduled("maintenance.cleanup");
    expect(await t.db.select().from(sessions).where(eq(sessions.id, recentSession))).toHaveLength(1);
  });
});

describe("Handler outbox email pengurus (F-16, ARCHITECTURE §4.7)", () => {
  it("F-16: undangan yang sudah diterima, kedaluwarsa, atau rondenya diganti tidak mengirim email dan tidak mengubah hash", async () => {
    const job = t.app.get(AdminMailJob);
    const accepted = await createAdmin(t, { status: "active" });
    const invited = await createAdmin(t, { status: "invited" });
    const [invitedRow] = await t.db.select().from(admins).where(eq(admins.id, invited.adminId));
    const before = t.mailer.messages.length;
    const event = (adminId: string, inviteExpiresAt: Date) => ({
      id: uuidv7(),
      topic: "admin.invitation.requested" as const,
      dedupKey: "uji",
      attempts: 1,
      requestId: null,
      payload: { admin_id: adminId, invite_expires_at: inviteExpiresAt.toISOString() },
    });
    // Admin sudah aktif (undangan diterima).
    await runAsSystem(() => job.invitation(event(accepted.adminId, new Date(t.clock.now().getTime() + DAY)), jobCtx));
    // Ronde lain (invite_expires_at berbeda dari baris).
    await runAsSystem(() =>
      job.invitation(event(invited.adminId, new Date(invitedRow!.inviteExpiresAt!.getTime() - 1)), jobCtx),
    );
    // Ronde yang sama tetapi sudah kedaluwarsa.
    t.clock.advance(73 * 3600_000);
    await runAsSystem(() => job.invitation(event(invited.adminId, invitedRow!.inviteExpiresAt!), jobCtx));
    expect(t.mailer.messages.length).toBe(before);
    const [after] = await t.db.select().from(admins).where(eq(admins.id, invited.adminId));
    expect(after!.inviteTokenHash).toBe(invitedRow!.inviteTokenHash);
  });

  it("F-16: pemberitahuan keamanan ke email login admin; admin yang sudah dihapus dilewati tanpa galat", async () => {
    const admin = await createAdmin(t, { displayName: "Penerima Notis" });
    const outbox = t.app.get(OutboxService);
    await runAsSystem(() =>
      t.db.transaction((tx) =>
        outbox.publish(tx, {
          topic: "admin.security_notice",
          dedupKey: `uji-notice-${admin.adminId}`,
          payload: { admin_id: admin.adminId, kind: "password_changed" },
        }),
      ),
    );
    await runAsSystem(() =>
      t.db.transaction((tx) =>
        outbox.publish(tx, {
          topic: "admin.security_notice",
          dedupKey: `uji-notice-hilang-${uuidv7()}`,
          payload: { admin_id: uuidv7(), kind: "disabled" },
        }),
      ),
    );
    const result = await t.jobs.drainOutbox();
    expect(result.failed + result.dead).toBe(0);
    const message = t.mailer.lastMessage(admin.email);
    expect(message?.subject).toBe("Sandi akun pengurus Anda diubah");
    expect(message?.text).toContain("Yth. Penerima Notis");
    expect(message?.text).toMatch(/WIB/);
    expect(message?.text).not.toMatch(/token|kode TOTP:/i);
  });
});
