/**
 * D1-01 pada PostgreSQL 17 nyata: CLI operator `account:status` (PRD 2.2 "disabled: pemulihan yang disetujui", F-14)
 * berjalan sebagai login role production kapdh_worker (infra/db/roles.sql) dan setiap tindakan diaudit. Memakai CLI hasil
 * `pnpm build` (alur verifikasi menjalankan build sebelum test:pg); dilewati bila dist belum ada.
 */
import "reflect-metadata";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Db } from "../../src/core/db/types.js";
import { createAlumni } from "../support/factories.js";
import { TestClock, testEnv } from "../support/test-app.js";
import { createPgTestDatabase, type PgTestDatabase } from "./support.js";

let tdb: PgTestDatabase;
const clock = new TestClock();

beforeAll(async () => {
  tdb = await createPgTestDatabase("account_status", 4);
});
afterAll(async () => {
  await tdb.drop();
});

const cliPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "modules",
  "account",
  "account-status.cli.js",
);

describe("CLI account:status (D1-01, PRD 2.2, runbook alumni-account-disabled)", () => {
  it.skipIf(!existsSync(cliPath))(
    "sebagai kapdh_worker: disable -> enable -> disable -> delete, masing-masing diaudit; penolakan keluar 1 tanpa perubahan",
    async () => {
      const lane = inject("kapdhPg")!;
      const workerUrl = `postgres://kapdh_worker:${lane.rolePassword}@${lane.host}:${lane.port}/${tdb.name}`;
      const member = await createAlumni({ db: tdb.db as unknown as Db, clock }, { status: "verified" });
      const root = mkdtempSync(join(tmpdir(), "kapdh-files-"));
      const env = {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DATABASE_URL: workerUrl,
        FILE_URL_SECRET: testEnv.FILE_URL_SECRET,
        STORAGE_DRIVER: "local",
        STORAGE_LOCAL_ROOT: root,
      };
      const run = (action: string) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
          execFile(
            process.execPath,
            [
              cliPath,
              "--action",
              action,
              "--email",
              member.email,
              "--reason",
              `BANTUAN-2026-0099 ${action}`,
              "--approved-by",
              "Ketua Umum",
            ],
            { env, cwd: root, timeout: 120_000 },
            (error, stdout, stderr) =>
              resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
          );
        });
      const status = async () =>
        (await tdb.sql<{ status: string }[]>`select status from app.users where id = ${member.userId}`)[0]!
          .status;
      try {
        const refused = await run("enable");
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("Gagal:");
        expect(await status()).toBe("active");

        const disabled = await run("disable");
        expect(disabled.code, disabled.stderr).toBe(0);
        expect(disabled.stdout).toContain("active -> disabled");
        expect(disabled.stdout).not.toContain(member.email);
        expect(await status()).toBe("disabled");

        expect((await run("enable")).code).toBe(0);
        expect(await status()).toBe("active");
        expect((await run("disable")).code).toBe(0);

        const deleted = await run("delete");
        expect(deleted.code, deleted.stderr).toBe(0);
        const requestNumber = /DEL-\d{4}-[0-9A-Z]+/.exec(deleted.stdout)?.[0];
        expect(requestNumber).toBeDefined();
        expect(await status()).toBe("deletion_pending");
        const [request] = await tdb.sql<{ source: string; status: string; user_id: string }[]>`
          select source, status, user_id from app.account_deletions where request_number = ${requestNumber!}`;
        expect(request).toMatchObject({ source: "web", status: "pending", user_id: member.userId });
        const outbox = await tdb.sql<{ n: number }[]>`
          select count(*)::int as n from app.outbox_events where topic = 'account.deletion.requested'`;
        expect(outbox[0]!.n).toBe(1);

        const audits = await tdb.sql<{ action: string; effective_role: string; reason: string | null }[]>`
          select action, effective_role, reason from app.audit_logs
          where entity_id = ${member.userId} order by created_at, id`;
        expect(audits.map((row) => row.action)).toEqual([
          "account.disabled",
          "account.enabled",
          "account.disabled",
          "account.deletion_requested",
          "account.deletion_requested_by_operator",
        ]);
        expect(audits.every((row) => row.effective_role === "system")).toBe(true);
        expect(audits[0]!.reason).toBe("BANTUAN-2026-0099 disable");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
