import { accountDeletions, auditLogs, sessions, users } from "@kapdh/database";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { runAccountStatusCommand } from "../../src/modules/account/account-status-command.js";
import { deletedEmailFor, remainingPersonalData } from "../../src/modules/account/deletion-steps.js";
import {
  AccountStatusRefusedError,
  AccountStatusService,
  type AccountStatusInput,
} from "../../src/modules/account/account-status.service.js";
import { createAdmin, createAlumni, DEFAULT_PASSWORD, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { ensureAuditPurgeRole, runDeletion, userRow } from "./support.js";

/**
 * D1-01 (PRD 2.2 "disabled: pemulihan yang disetujui"; F-14): status akun alumni `disabled` dapat dimasuki, dipulihkan
 * dan dihapus lewat CLI operator `account:status` yang diaudit (runbook docs/runbooks/alumni-account-disabled.md),
 * bukan hanya lewat edit database langsung.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await ensureAuditPurgeRole(t.db);
});
afterAll(async () => {
  await t.app.close();
});

const api = () => httpClient(t.app);
const apply = (input: AccountStatusInput) => runAsSystem(() => t.app.get(AccountStatusService).apply(input));

function capture() {
  const out: string[] = [];
  return { out, write: (text: string) => out.push(text) };
}

async function audits(userId: string, action: string) {
  return t.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, userId), eq(auditLogs.action, action)));
}

describe("D1-01: siklus akun alumni disabled lewat CLI operator yang diaudit (PRD 2.2, F-14)", () => {
  it("disable: sesi dicabut, login next account_disabled tanpa sesi; enable: pemilik masuk lagi dengan sandinya", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    expect((await api().get("/me", { token: session.accessToken })).statusCode).toBe(200);

    const disabled = await apply({
      action: "disable",
      email: member.email.toUpperCase(),
      reason: "Tiket BANTUAN-2026-0001: akun dilaporkan disalahgunakan",
      approvedBy: "Ketua Umum",
    });
    expect(disabled).toMatchObject({ before: "active", after: "disabled", requestNumber: null });
    expect(disabled.sessionsRevoked).toBeGreaterThan(0);
    expect((await userRow(t.db, member.userId))!.status).toBe("disabled");
    expect(
      await t.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, member.userId), isNull(sessions.revokedAt))),
    ).toEqual([]);
    expect((await api().get("/me", { token: session.accessToken })).statusCode).toBe(401);
    const login = await api().post("/auth/login", { email: member.email, password: DEFAULT_PASSWORD });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ next: "account_disabled" });
    const [disableAudit] = await audits(member.userId, "account.disabled");
    expect(disableAudit).toMatchObject({
      effectiveRole: "system",
      actorUserId: null,
      reason: "Tiket BANTUAN-2026-0001: akun dilaporkan disalahgunakan",
      before: { status: "active" },
      after: { status: "disabled", approved_by: "Ketua Umum", channel: "operator_cli" },
    });

    // Mengulang disable ditolak tanpa perubahan.
    await expect(
      apply({ action: "disable", email: member.email, reason: "ulang", approvedBy: "Ketua Umum" }),
    ).rejects.toBeInstanceOf(AccountStatusRefusedError);

    const enabled = await apply({
      action: "enable",
      email: member.email,
      reason: "Tiket BANTUAN-2026-0001: identitas pemilik diverifikasi, pemulihan disetujui",
      approvedBy: "Ketua Umum",
    });
    expect(enabled).toMatchObject({ before: "disabled", after: "active" });
    const again = await api().post("/auth/login", { email: member.email, password: DEFAULT_PASSWORD });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ next: "home" });
    expect(await audits(member.userId, "account.enabled")).toHaveLength(1);
  });

  it("delete: akun disabled -> deletion_pending dengan permintaan web, job F-14 menghapus seluruh data pribadi", async () => {
    const member = await createAlumni(t, { status: "verified", accountStatus: "disabled" });
    const result = await apply({
      action: "delete",
      email: member.email,
      reason: "Tiket BANTUAN-2026-0002: pemilik meminta penghapusan, identitas diverifikasi lewat email akun",
      approvedBy: "Sekretaris",
    });
    expect(result).toMatchObject({ before: "disabled", after: "deletion_pending" });
    expect(result.requestNumber).toMatch(/^DEL-\d{4}-/);
    const [row] = await t.db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.requestNumber, result.requestNumber!));
    expect(row).toMatchObject({ userId: member.userId, source: "web", status: "pending" });
    const [requested] = await audits(member.userId, "account.deletion_requested");
    expect(requested).toMatchObject({ effectiveRole: "system", after: { source: "web" } });
    expect(await audits(member.userId, "account.deletion_requested_by_operator")).toHaveLength(1);

    // Login akun deletion_pending menampilkan status penghapusan tanpa sesi (PRD 2.2).
    const login = await api().post("/auth/login", { email: member.email, password: DEFAULT_PASSWORD });
    expect(login.json()).toMatchObject({ next: "deletion_pending" });

    expect(await runDeletion(t, row!.id)).toMatchObject({ outcome: "completed" });
    expect(await userRow(t.db, member.userId)).toMatchObject({
      status: "deleted",
      email: deletedEmailFor(member.userId),
    });
    const remaining = await remainingPersonalData(t.db, member.userId);
    expect(
      Object.values(remaining).every((value) => value === 0),
      JSON.stringify(remaining),
    ).toBe(true);
  });

  it("menolak akun yang tidak memenuhi syarat: email tak dikenal, akun admin, status lain; alasan wajib", async () => {
    const active = await createAlumni(t, { status: "verified" });
    const pending = await createAlumni(t, { status: "verified", accountStatus: "deletion_pending" });
    const admin = await createAdmin(t, { permissions: [] });
    const refused = async (input: AccountStatusInput) => {
      await expect(apply(input)).rejects.toBeInstanceOf(AccountStatusRefusedError);
    };
    await refused({ action: "disable", email: "tidak-ada@contoh.test", reason: "x", approvedBy: "y" });
    await refused({ action: "disable", email: admin.email, reason: "x", approvedBy: "y" });
    await refused({ action: "enable", email: active.email, reason: "x", approvedBy: "y" });
    await refused({ action: "delete", email: active.email, reason: "x", approvedBy: "y" });
    await refused({ action: "disable", email: pending.email, reason: "x", approvedBy: "y" });
    await refused({ action: "disable", email: active.email, reason: "   ", approvedBy: "y" });
    await refused({ action: "disable", email: active.email, reason: "x", approvedBy: "" });
    expect((await t.db.select().from(users).where(eq(users.id, active.userId)))[0]!.status).toBe("active");
    expect((await userRow(t.db, pending.userId))!.status).toBe("deletion_pending");
  });

  it("perintah CLI: argumen salah -> 2, ditolak -> 1 dengan pesan aman, berhasil -> 0 tanpa email di keluaran", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const service = t.app.get(AccountStatusService);
    const run = (args: string[]) => {
      const stdout = capture();
      const stderr = capture();
      return runAsSystem(() => runAccountStatusCommand(args, { service, stdout, stderr })).then((code) => ({
        code,
        stdout: stdout.out.join(""),
        stderr: stderr.out.join(""),
      }));
    };
    expect((await run(["--action", "disable", "--email", member.email])).code).toBe(2);
    expect(
      (await run(["--action", "hapus", "--email", member.email, "--reason", "x", "--approved-by", "y"])).code,
    ).toBe(2);
    const refused = await run([
      "--action",
      "enable",
      "--email",
      member.email,
      "--reason",
      "Tiket BANTUAN-2026-0003",
      "--approved-by",
      "Ketua Umum",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("hanya untuk akun disabled");
    const ok = await run([
      "--action=disable",
      `--email=${member.email}`,
      "--reason=Tiket BANTUAN-2026-0003",
      "--approved-by=Ketua Umum",
    ]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("active -> disabled");
    expect(ok.stdout).not.toContain(member.email);
    expect((await userRow(t.db, member.userId))!.status).toBe("disabled");
  });
});
