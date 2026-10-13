import { appSettings, auditLogs } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "../../src/core/audit/audit.service.js";
import { runInContext, SYSTEM_ACTOR } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import { SETTING_DEFAULTS, SETTING_KEYS } from "../../src/core/settings/keys.js";
import { createAdmin } from "../support/factories.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

/** Menjalankan fn sebagai admin tertentu (seperti setelah AuthGuard mengisi aktor request). */
function asAdmin<T>(admin: { adminId: string; userId: string }, fn: () => Promise<T>): Promise<T> {
  return runInContext(
    {
      requestId: "req-settings-1",
      jobId: null,
      clientRequestId: null,
      actor: {
        kind: "admin",
        userId: admin.userId,
        adminId: admin.adminId,
        adminRole: "super_admin",
        sessionId: null,
      },
      ip: null,
      appVersion: null,
      appPlatform: null,
      source: "test",
    },
    fn,
  );
}

describe("SettingsService (ARCHITECTURE §5.4, PRD 6.2)", () => {
  it("semua kunci terbaca bertipe dari seed referensi (versi 1)", async () => {
    const all = await t.settings.getAll();
    expect(Object.keys(all).sort()).toEqual([...SETTING_KEYS].sort());
    expect(all.fees).toEqual({ registration_fee: "50000.00", card_fee: "10000.00", renewal_fee: "10000.00" });
    expect(all.membership).toEqual({ period_months: 12, expiring_days: 30, renewal_window_days: 30 });
    const entry = await t.settings.getEntry("fees");
    expect(entry.version).toBe(1);
    expect(SETTING_DEFAULTS.fees).toEqual(all.fees);
  });

  it("AC F15-3, F15-4: update dengan versi benar menaikkan versi, menulis audit before/after, dan membuang cache", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const before = await t.settings.get("fees");
    const updated = await asAdmin(admin, () =>
      withTx(t.db, (tx) =>
        t.settings.update(
          tx,
          "fees",
          { registration_fee: "55000.00", card_fee: "10000.00", renewal_fee: "12000.00" },
          1,
          undefined,
          {
            reason: "Keputusan rapat pengurus",
          },
        ),
      ),
    );
    expect(updated).toMatchObject({ key: "fees", version: 2, value: { registration_fee: "55000.00" } });
    // Cache dibuang setelah commit: pembacaan berikutnya melihat nilai baru.
    expect(await t.settings.get("fees")).toEqual(updated.value);
    const [row] = await t.db.select().from(appSettings).where(eq(appSettings.key, "fees"));
    expect(row).toMatchObject({ version: 2, updatedByAdminId: admin.adminId });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "settings.updated"), eq(auditLogs.entityId, "fees")));
    expect(audit).toMatchObject({
      actorAdminId: admin.adminId,
      actorUserId: admin.userId,
      effectiveRole: "super_admin",
      requestId: "req-settings-1",
      reason: "Keputusan rapat pengurus",
      before: { value: before, version: 1 },
      after: { value: updated.value, version: 2 },
    });
  });

  it("versi kedaluwarsa → 409 VERSION_CONFLICT dengan nilai terbaru; nilai tidak berubah", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const current = await t.settings.getEntry("support");
    await expect(
      asAdmin(admin, () =>
        withTx(t.db, (tx) =>
          t.settings.update(
            tx,
            "support",
            { email: "lain@kapdh.or.id", whatsapp: null },
            current.version + 5,
          ),
        ),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      extra: { current: { key: "support", value: current.value, version: String(current.version) } },
    });
    expect((await t.settings.getEntry("support")).version).toBe(current.version);
  });

  it("nilai di luar skema → 400 VALIDATION_ERROR dengan field_errors; kunci membership hanya baca (403)", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    await expect(
      asAdmin(admin, () =>
        withTx(t.db, (tx) =>
          t.settings.update(tx, "fees", { registration_fee: 50000, card_fee: "-1", renewal_fee: "1e5" }, 2),
        ),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      extra: {
        fieldErrors: {
          registration_fee: expect.any(Array),
          card_fee: expect.any(Array),
          renewal_fee: expect.any(Array),
        },
      },
    });
    await expect(
      asAdmin(admin, () =>
        withTx(t.db, (tx) =>
          t.settings.update(
            tx,
            "membership",
            { period_months: 12, expiring_days: 30, renewal_window_days: 30 },
            1,
          ),
        ),
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      asAdmin(admin, () =>
        withTx(t.db, (tx) => t.settings.update(tx, "min_app_version", { android: "satu", ios: "1.0.0" }, 1)),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      extra: { fieldErrors: { android: expect.any(Array) } },
    });
  });

  it("transaksi batal tidak mengubah nilai maupun audit", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const current = await t.settings.getEntry("chat");
    await expect(
      asAdmin(admin, () =>
        withTx(t.db, async (tx) => {
          await t.settings.update(
            tx,
            "chat",
            { max_text_chars: 2000, max_group_members: 50 },
            current.version,
          );
          throw new Error("batal setelah update");
        }),
      ),
    ).rejects.toThrow("batal setelah update");
    t.settings.invalidate();
    expect(await t.settings.getEntry("chat")).toMatchObject({
      version: current.version,
      value: current.value,
    });
  });

  it("aktor eksplisit menggantikan aktor konteks (mis. job pemulihan oleh system)", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const current = await t.settings.getEntry("maintenance");
    const updated = await asAdmin(admin, () =>
      withTx(t.db, (tx) =>
        t.settings.update(
          tx,
          "maintenance",
          { active: false, message: "Selesai", until: null },
          current.version,
          {
            ...SYSTEM_ACTOR,
          },
        ),
      ),
    );
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "settings.updated"), eq(auditLogs.entityId, "maintenance")));
    expect(audit).toMatchObject({ effectiveRole: "system", actorAdminId: null, requestId: "req-settings-1" });
    const [row] = await t.db.select().from(appSettings).where(eq(appSettings.key, "maintenance"));
    expect(row).toMatchObject({ version: updated.version, updatedByAdminId: null });
  });

  it("AuditService.write di luar konteks request/job ditolak (audit tidak pernah tanpa korelasi)", async () => {
    await expect(
      withTx(t.db, (tx) =>
        t.app.get(AuditService).write(tx, { action: "uji.tanpa_konteks", entityType: "uji" }),
      ),
    ).rejects.toThrow(/konteks/);
  });
});
