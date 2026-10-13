/**
 * CLI bootstrap Super Admin pertama (PRD 8.2 langkah 3, F-16): menolak bila Super Admin aktif yang dapat login sudah
 * ada, membuat Super Admin `invited` dengan sandi awal acak yang tidak dapat dipakai, mencetak SATU tautan undangan
 * `${ADMIN_ORIGIN}/invite#t=<token>`, mengaudit `admin.bootstrap`, dan aktivasinya memakai alur undangan + pendaftaran
 * TOTP yang sama dengan admin lain. Tidak ada rute HTTP untuk bootstrap.
 */
import type { PGlite } from "@electric-sql/pglite";
import { PERMISSION_VALUES } from "@kapdh/contracts";
import { admins, auditLogs, mfaTotp, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BootstrapAdminCommandDeps,
  runBootstrapAdminCommand,
} from "../../src/cli/bootstrap-admin-command.js";
import type { Db } from "../../src/core/db/types.js";
import { adminInviteTokenHash, ADMIN_INVITE_TTL_MS } from "../../src/core/identity/crypto.js";
import { expectOperation, registeredRoutes } from "../support/contract.js";
import { createAdmin } from "../support/factories.js";
import { createTestApp, createTestDatabase, type TestApp, TestClock, testEnv } from "../support/test-app.js";
import { activateInvitation, NEW_ADMIN_PASSWORD } from "./helpers.js";

/** Menangkap stdout/stderr perintah. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const LINK_PATTERN = /http:\/\/admin\.test\/invite#t=([A-Za-z0-9_-]+)/g;

async function run(db: Db, clock: TestClock, args: string[]) {
  const io = capture();
  const deps: BootstrapAdminCommandDeps = {
    db,
    env: { ADMIN_ORIGIN: testEnv.ADMIN_ORIGIN, BCRYPT_COST: 4 },
    now: clock.now(),
    stdout: io.stdout,
    stderr: io.stderr,
  };
  const code = await runBootstrapAdminCommand(args, deps);
  const links = [...io.out().matchAll(LINK_PATTERN)].map((m) => m[1]!);
  return { code, out: io.out(), err: io.err(), links };
}

describe("PRD 8.2 langkah 3: perintah bootstrap (database)", () => {
  let pg: PGlite;
  let db: Db;
  const clock = new TestClock();

  beforeAll(async () => {
    ({ pg, db } = await createTestDatabase());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("PRD 8.2: argumen kurang → kode keluar 2 dengan petunjuk pemakaian; tidak ada data dibuat", async () => {
    for (const args of [[], ["--email", "a@kapdh.test"], ["--email", "--name", "Bayu"], ["--name", "Bayu"]]) {
      const result = await run(db, clock, args);
      expect(result.code).toBe(2);
      expect(result.err).toContain("Pakai:");
      expect(result.out).toBe("");
    }
    expect(await db.select().from(admins)).toHaveLength(0);
  });

  it("PRD 8.2: Super Admin yang tidak dapat login (invited, disabled, akun users nonaktif) tidak menghalangi bootstrap", async () => {
    // Super Admin aktif dengan akun users `disabled` (disisipkan langsung; trigger hanya menjaga UPDATE/DELETE).
    const userId = uuidv7();
    await db.insert(users).values({
      id: userId,
      email: "nonaktif@kapdh.test",
      passwordHash: await bcrypt.hash("Kapdh#2026", 4),
      status: "disabled",
      kind: "admin",
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    await db.insert(admins).values({
      id: uuidv7(),
      userId,
      displayName: "Super Nonaktif",
      role: "super_admin",
      status: "active",
      activatedAt: clock.now(),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    await createAdmin({ db, clock }, { role: "super_admin", status: "disabled" });

    const result = await run(db, clock, ["--email", "Pemilik@KAPDH.test", "--name", "Bayu Musthafa"]);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toBe("");
    // Tepat satu tautan berbentuk fragmen #t= (kontrak C1); token tidak muncul di tempat lain.
    expect(result.links).toHaveLength(1);
    const token = result.links[0]!;
    expect(result.out.split(token)).toHaveLength(2);
    expect(result.out).not.toContain("/invite/");
    expect(result.out).toContain("pemilik@kapdh.test");

    const [admin] = await db
      .select()
      .from(admins)
      .where(eq(admins.inviteTokenHash, adminInviteTokenHash(token)));
    expect(admin).toMatchObject({
      role: "super_admin",
      status: "invited",
      activatedAt: null,
      displayName: "Bayu Musthafa",
      inviteExpiresAt: new Date(clock.now().getTime() + ADMIN_INVITE_TTL_MS),
    });
    const [user] = await db.select().from(users).where(eq(users.id, admin!.userId));
    expect(user).toMatchObject({ email: "pemilik@kapdh.test", kind: "admin", status: "active" });
    // Sandi awal acak tidak diketahui siapa pun (tidak dapat dipakai untuk masuk).
    for (const guess of ["", "Kapdh#2026", token, NEW_ADMIN_PASSWORD])
      expect(await bcrypt.compare(guess, user!.passwordHash)).toBe(false);
    expect(await db.select().from(mfaTotp).where(eq(mfaTotp.userId, user!.id))).toHaveLength(0);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, admin!.id));
    expect(audit).toMatchObject({
      action: "admin.bootstrap",
      effectiveRole: "system",
      actorAdminId: null,
      actorUserId: null,
    });
    expect(audit!.requestId).toMatch(/^cli-/);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(user!.passwordHash);
  });

  it("PRD 8.2: menjalankan ulang sebelum aktivasi mencetak tautan baru; tautan lama dan pendaftaran yang belum selesai batal", async () => {
    const first = await run(db, clock, ["--email", "ulang@kapdh.test", "--name", "Super Ulang"]);
    expect(first.code).toBe(0);
    const [admin] = await db
      .select()
      .from(admins)
      .where(eq(admins.inviteTokenHash, adminInviteTokenHash(first.links[0]!)));
    await db.insert(mfaTotp).values({
      userId: admin!.userId,
      secretEncrypted: "v1.sisa.pendaftaran.lama",
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    clock.advance(3600_000);
    const second = await run(db, clock, ["--email=ulang@kapdh.test", "--name=Super Ulang"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("diterbitkan ulang");
    expect(second.links).toHaveLength(1);
    expect(second.links[0]).not.toBe(first.links[0]);
    const [after] = await db.select().from(admins).where(eq(admins.id, admin!.id));
    expect(after!.inviteTokenHash).toBe(adminInviteTokenHash(second.links[0]!));
    expect(await db.select().from(mfaTotp).where(eq(mfaTotp.userId, admin!.userId))).toHaveLength(0);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, admin!.id));
    expect(audits.map((a) => a.action).sort()).toEqual(["admin.bootstrap", "admin.bootstrap_reinvited"]);
  });

  it("PRD 8.2: menolak berjalan bila Super Admin aktif yang dapat login sudah ada; tidak ada tautan dicetak", async () => {
    await createAdmin({ db, clock }, { role: "super_admin" });
    const before = (await db.select().from(admins)).length;
    const result = await run(db, clock, ["--email", "kedua@kapdh.test", "--name", "Super Kedua"]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.links).toHaveLength(0);
    expect(result.err).toBe(
      "Gagal: Super Admin aktif sudah ada. Tambahkan admin lain dari web admin (menu Admin).\n",
    );
    expect((await db.select().from(admins)).length).toBe(before);
    expect(await db.select().from(users).where(eq(users.email, "kedua@kapdh.test"))).toHaveLength(0);
  });

  it("PRD 8.2: email yang dipakai identitas admin lain atau masukan tidak valid ditolak dengan pesan aman", async () => {
    // Super Admin aktif dari uji sebelumnya membuat bootstrap menolak lebih dulu; uji ini memakai database baru.
    const fresh = await createTestDatabase();
    try {
      const freshDb = fresh.db;
      const other = await createAdmin({ db: freshDb, clock }, { role: "admin", email: "lain@kapdh.test" });
      const taken = await run(freshDb, clock, ["--email", other.email, "--name", "Super Baru"]);
      expect(taken).toMatchObject({ code: 1, out: "" });
      expect(taken.err).toContain("Email sudah dipakai identitas admin lain.");
      const invalid = await run(freshDb, clock, ["--email", "bukan-email", "--name", "Super Baru"]);
      expect(invalid.err).toBe("Gagal: Email tidak valid.\n");
      const shortName = await run(freshDb, clock, ["--email", "nama@kapdh.test", "--name", " "]);
      expect(shortName.err).toContain("Nama tampilan");
    } finally {
      await fresh.pg.close();
    }
  });
});

describe("PRD 8.2 langkah 3: aktivasi Super Admin bootstrap lewat alur undangan (HTTP)", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  const post = (url: string, payload: object) =>
    t.app.inject({ method: "POST", url: `/api/v1${url}`, payload });

  it("PRD 8.2: tautan CLI → preview → ganti sandi awal → TOTP → Super Admin aktif; bootstrap berikutnya ditolak", async () => {
    const result = await run(t.db, t.clock, ["--email", "bayu@kapdh.test", "--name", "Bayu Musthafa"]);
    expect(result.code).toBe(0);
    const token = result.links[0]!;

    // Sebelum aktivasi: tidak ada akses (sandi awal tidak diketahui; status invited).
    expect(
      (await post("/admin/auth/login", { email: "bayu@kapdh.test", password: "Kapdh#2026" })).statusCode,
    ).toBe(401);
    const preview = await post("/admin/auth/invitations/preview", { invite_token: token });
    expect(preview.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/invitations/preview", preview);
    expect(preview.json()).toMatchObject({
      display_name: "Bayu Musthafa",
      role: "super_admin",
      permissions: [...PERMISSION_VALUES],
      invited_by_display_name: null,
      email_masked: "ba***@kapdh.test",
    });

    const activated = await activateInvitation(t, token);
    const me = await t.app.inject({
      method: "GET",
      url: "/api/v1/admin/me",
      headers: { authorization: `Bearer ${activated.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: "super_admin", email: "bayu@kapdh.test" });

    const again = await run(t.db, t.clock, ["--email", "cadangan@kapdh.test", "--name", "Super Cadangan"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("Super Admin aktif sudah ada");
    expect(again.links).toHaveLength(0);
  });

  it("PRD 8.2 / F-16: bootstrap tidak dapat dijalankan lewat HTTP (tidak ada rute)", async () => {
    const fastify = t.app.getHttpAdapter().getInstance();
    const routes = registeredRoutes(fastify.printRoutes({ commonPrefix: false }));
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.filter((r) => /bootstrap/i.test(r.url))).toEqual([]);
    for (const url of ["/api/v1/admin/bootstrap", "/api/v1/admin/auth/bootstrap", "/api/v1/bootstrap"]) {
      const res = await t.app.inject({
        method: "POST",
        url,
        payload: { email: "x@kapdh.test", name: "X" },
      });
      expect(res.statusCode, url).toBe(404);
    }
    const [created] = await t.db.select().from(users).where(eq(users.email, "x@kapdh.test"));
    expect(created).toBeUndefined();
  });
});
