import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseEnv } from "@kapdh/config";
import { MemoryDriver, S3Driver } from "@kapdh/storage";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import {
  appendLedgerEntry,
  type LedgerEntry,
  mergeLedgerEntries,
  offsiteLedgerObjectKey,
  readLedgerDirectory,
} from "../../src/modules/account/deletion-ledger.js";
import { argValues } from "../../src/modules/account/ledger-reapply-args.js";
import {
  createOffsiteLedgerDriver,
  OffsiteDeletionLedger,
  OffsiteLedgerWriteError,
} from "../../src/modules/account/offsite-deletion-ledger.js";

/**
 * Deletion ledger luar VPS (AC F14-6, PRD 5.5, D9; audit D5-07): key append-only, penggabungan entri dari beberapa
 * salinan, penolakan di production tanpa konfigurasi, dan argumen CLI ledger-reapply.
 */

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    v: 1,
    kind: "kapdh.account_deletion",
    deletion_id: "0192f0d2-7c1e-7d5a-9a51-1f1c2b3d4e5f",
    request_number: "DEL-2026-ABCD1234",
    user_id: "0192f0d2-7c1e-7d5a-9a51-1f1c2b3d4e60",
    source: "app",
    requested_at: "2026-10-13T02:00:00.000Z",
    state: "requested",
    completed_at: null,
    object_keys: [],
    written_at: "2026-10-13T02:00:01.000Z",
    ...overrides,
  };
}

const testEnv = { NODE_ENV: "test" } as BaseEnv;

describe("Store deletion ledger luar VPS (AC F14-6, D5-07)", () => {
  it("setiap penulisan memakai key baru (append-only) per permintaan; isi tervalidasi tanpa data pribadi", async () => {
    const storage = new MemoryDriver();
    const writeId = uuidv7();
    const key = await appendLedgerEntry(storage, entry(), writeId);
    expect(key).toBe(`account-deletions/2026/10/del-2026-abcd1234/requested-${writeId}.json`);
    const second = await appendLedgerEntry(storage, entry(), uuidv7());
    expect(second).not.toBe(key);
    expect(storage.keys()).toHaveLength(2);
    expect(() => offsiteLedgerObjectKey(entry(), "../x")).toThrow();
    await expect(
      appendLedgerEntry(storage, { ...entry(), email: "a@b.test" } as unknown as LedgerEntry, uuidv7()),
    ).rejects.toThrow();
  });

  it("penggabungan: completed mengalahkan requested, object key dari semua versi digabung; entri bertentangan ditolak", () => {
    const merged = mergeLedgerEntries([
      entry({ object_keys: ["avatar/2026/10/a"] }),
      entry({
        state: "completed",
        completed_at: "2026-10-14T02:00:00.000Z",
        object_keys: ["payment_proof/2026/10/b"],
      }),
      entry({
        state: "completed",
        completed_at: "2026-10-14T03:00:00.000Z",
        object_keys: ["chat_image/2026/10/c"],
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      state: "completed",
      completed_at: "2026-10-14T02:00:00.000Z",
      object_keys: ["avatar/2026/10/a", "chat_image/2026/10/c", "payment_proof/2026/10/b"],
    });
    expect(() =>
      mergeLedgerEntries([entry(), entry({ user_id: "0192f0d2-7c1e-7d5a-9a51-1f1c2b3d4e61" })]),
    ).toThrow(/bertentangan/);
  });

  it("salinan bucket luar VPS dibaca rekursif seperti hasil rclone copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "kapdh-offsite-"));
    try {
      const folder = join(dir, "2026", "10", "del-2026-abcd1234");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `requested-${uuidv7()}.json`), JSON.stringify(entry()));
      writeFileSync(
        join(folder, `completed-${uuidv7()}.json`),
        JSON.stringify(
          entry({
            state: "completed",
            completed_at: "2026-10-14T02:00:00.000Z",
            object_keys: ["avatar/2026/10/a"],
          }),
        ),
      );
      expect(readLedgerDirectory(dir)).toEqual([
        expect.objectContaining({ state: "completed", object_keys: ["avatar/2026/10/a"] }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tanpa konfigurasi: dilewati di development/test, DITOLAK di production; galat penyedia menjadi OffsiteLedgerWriteError dengan kode aman", async () => {
    expect(createOffsiteLedgerDriver(testEnv)).toBeNull();
    expect(await new OffsiteDeletionLedger(testEnv).append(entry())).toBeNull();
    const production = new OffsiteDeletionLedger({ NODE_ENV: "production" } as BaseEnv);
    expect(production.configured).toBe(false);
    await expect(production.append(entry())).rejects.toBeInstanceOf(OffsiteLedgerWriteError);

    const memory = new MemoryDriver();
    production.useDriver(memory);
    expect(await production.append(entry())).toMatch(/^account-deletions\/2026\/10\/del-2026-abcd1234\//);
    memory.failNext("put", 1);
    const failure = await production.append(entry()).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OffsiteLedgerWriteError);
    expect((failure as OffsiteLedgerWriteError).code).toBeUndefined();
    const denied = new OffsiteLedgerWriteError(
      "x",
      Object.assign(new Error("rahasia"), { name: "AccessDenied" }),
    );
    expect(denied.code).toBe("AccessDenied");
    expect(denied.message).not.toContain("rahasia");
  });

  it("dengan konfigurasi: driver S3 bucket ledger memakai Content-MD5 (bucket object lock)", () => {
    const driver = createOffsiteLedgerDriver({
      NODE_ENV: "production",
      DELETION_LEDGER_S3_ENDPOINT: "https://akun.r2.cloudflarestorage.com",
      DELETION_LEDGER_S3_REGION: "auto",
      DELETION_LEDGER_S3_BUCKET: "kapdh-prod-deletion-ledger",
      DELETION_LEDGER_S3_ACCESS_KEY_ID: "ledger-writer",
      DELETION_LEDGER_S3_SECRET_ACCESS_KEY: "rahasia",
    } as BaseEnv);
    expect(driver).toBeInstanceOf(S3Driver);
    expect((driver as unknown as { contentMd5: boolean }).contentMd5).toBe(true);
    driver!.destroy();
  });
});

describe("Argumen CLI ledger-reapply (runbook restore)", () => {
  it("--dir boleh diulang; argumen tanpa nilai ditolak", () => {
    expect(argValues(["--dir", "/a", "--dir", "/b"], "dir")).toEqual(["/a", "/b"]);
    expect(argValues([], "dir")).toEqual([]);
    expect(() => argValues(["--dir"], "dir")).toThrow(/membutuhkan nilai/);
    expect(() => argValues(["--dir", "--dir", "/a"], "dir")).toThrow(/membutuhkan nilai/);
  });
});
