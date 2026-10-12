import type { PGlite } from "@electric-sql/pglite";
import { admins, auditLogs, mfaTotp, users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapSuperAdmin } from "../../src/cli/bootstrap-super-admin.js";
import type { Db } from "../../src/core/db/types.js";
import { adminInviteTokenHash, ADMIN_INVITE_TTL_MS } from "../../src/modules/auth/crypto.js";
import { createAdmin } from "../support/factories.js";
import { createTestDatabase, TestClock } from "../support/test-app.js";

let pg: PGlite;
let db: Db;
const clock = new TestClock();

beforeAll(async () => {
  ({ pg, db } = await createTestDatabase());
});
afterAll(async () => {
  await pg.close();
});

const run = (email: string, displayName = "Bayu Musthafa") =>
  bootstrapSuperAdmin(db, { email, displayName, now: clock.now(), bcryptCost: 4, requestId: "cli-uji" });

describe("PRD 8.2 langkah 3: bootstrap Super Admin pertama", () => {
  it("membuat Super Admin berstatus invited dengan token undangan 72 jam; tanpa TOTP sampai aktivasi", async () => {
    const result = await run("  Pemilik@KAPDH.test ");
    expect(result).toMatchObject({ email: "pemilik@kapdh.test", reissued: false });
    expect(result.inviteExpiresAt.getTime()).toBe(clock.now().getTime() + ADMIN_INVITE_TTL_MS);
    const [admin] = await db.select().from(admins).where(eq(admins.id, result.adminId));
    expect(admin).toMatchObject({
      role: "super_admin",
      status: "invited",
      activatedAt: null,
      inviteTokenHash: adminInviteTokenHash(result.inviteToken),
    });
    // Hanya hash yang disimpan; token mentah tidak pernah ada di database.
    expect(admin!.inviteTokenHash).not.toBe(result.inviteToken);
    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user).toMatchObject({ kind: "admin", status: "active", email: "pemilik@kapdh.test" });
    expect(await db.select().from(mfaTotp).where(eq(mfaTotp.userId, result.userId))).toHaveLength(0);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, result.adminId));
    expect(audit).toMatchObject({
      action: "admin.bootstrap",
      effectiveRole: "system",
      actorAdminId: null,
      requestId: "cli-uji",
    });
    expect(JSON.stringify(audit)).not.toContain(result.inviteToken);
  });

  it("menjalankan ulang untuk email yang sama sebelum undangan diterima menerbitkan token baru (token lama batal)", async () => {
    const first = await run("ulang@kapdh.test");
    clock.advance(3600_000);
    const second = await run("ulang@kapdh.test");
    expect(second).toMatchObject({ adminId: first.adminId, reissued: true });
    expect(second.inviteToken).not.toBe(first.inviteToken);
    const [admin] = await db.select().from(admins).where(eq(admins.id, first.adminId));
    expect(admin!.inviteTokenHash).toBe(adminInviteTokenHash(second.inviteToken));
    expect(admin!.inviteExpiresAt).toEqual(second.inviteExpiresAt);
  });

  it("menolak email yang dipakai identitas admin lain dan masukan tidak valid", async () => {
    const other = await createAdmin({ db, clock }, { role: "admin", status: "disabled" });
    await expect(run(other.email)).rejects.toThrow(/admin lain/);
    await expect(run("bukan-email")).rejects.toThrow(/Email/);
    await expect(run("nama@kapdh.test", " ")).rejects.toThrow(/Nama/);
  });

  it("menolak berjalan bila Super Admin aktif sudah ada", async () => {
    await createAdmin({ db, clock }, { role: "super_admin" });
    await expect(run("kedua@kapdh.test")).rejects.toThrow(/Super Admin aktif sudah ada/);
    expect(await db.select().from(users).where(eq(users.email, "kedua@kapdh.test"))).toHaveLength(0);
  });
});
