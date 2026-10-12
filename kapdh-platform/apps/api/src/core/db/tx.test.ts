import { afterEach, describe, expect, it } from "vitest";
import { afterCommit, assertCommitAware, currentTx, setAfterCommitErrorReporter, withTx } from "../index.js";
import type { Db, Tx } from "./types.js";

/** Db tiruan: transaction() menjalankan fn dengan objek tx unik; galat fn = rollback (dilempar ulang). */
function fakeDb() {
  const log: string[] = [];
  let counter = 0;
  const db = {
    async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const tx = { id: ++counter } as unknown as Tx;
      log.push(`begin:${counter}`);
      try {
        const result = await fn(tx);
        log.push(`commit:${(tx as unknown as { id: number }).id}`);
        return result;
      } catch (error) {
        log.push(`rollback:${(tx as unknown as { id: number }).id}`);
        throw error;
      }
    },
  } as unknown as Db;
  return { db, log };
}

afterEach(() => setAfterCommitErrorReporter(() => {}));

describe("withTx + afterCommit (ARCHITECTURE §4.2, PRD 5.2 'event dikirim sesudah commit')", () => {
  it("callback afterCommit berjalan setelah commit, berurutan", async () => {
    const { db, log } = fakeDb();
    const result = await withTx(db, async () => {
      afterCommit(() => log.push("efek-1"));
      afterCommit(async () => {
        await Promise.resolve();
        log.push("efek-2");
      });
      log.push("kerja");
      return 42;
    });
    expect(result).toBe(42);
    expect(log).toEqual(["begin:1", "kerja", "commit:1", "efek-1", "efek-2"]);
  });

  it("transaksi batal membuang callback afterCommit", async () => {
    const { db, log } = fakeDb();
    await expect(
      withTx(db, async () => {
        afterCommit(() => log.push("tidak-boleh"));
        throw new Error("gagal");
      }),
    ).rejects.toThrow("gagal");
    expect(log).toEqual(["begin:1", "rollback:1"]);
  });

  it("withTx bersarang menggabung transaksi luar; efek dalam menunggu commit terluar", async () => {
    const { db, log } = fakeDb();
    await withTx(db, async (outer) => {
      await withTx(db, async (inner) => {
        expect(inner).toBe(outer);
        expect(currentTx()).toBe(outer);
        afterCommit(() => log.push("efek-dalam"));
      });
      log.push("setelah-dalam");
    });
    expect(log).toEqual(["begin:1", "setelah-dalam", "commit:1", "efek-dalam"]);
    expect(currentTx()).toBeUndefined();
  });

  it("di luar withTx, afterCommit langsung dijalankan", async () => {
    const seen: string[] = [];
    afterCommit(() => seen.push("langsung"));
    await Promise.resolve();
    expect(seen).toEqual(["langsung"]);
  });

  it("galat callback setelah commit dilaporkan tanpa menggagalkan hasil (data sudah tersimpan)", async () => {
    const { db, log } = fakeDb();
    const reported: unknown[] = [];
    setAfterCommitErrorReporter((error) => reported.push(error));
    const result = await withTx(db, async () => {
      afterCommit(() => {
        throw new Error("socket mati");
      });
      afterCommit(() => log.push("tetap-jalan"));
      return "ok";
    });
    expect(result).toBe("ok");
    expect(reported).toHaveLength(1);
    expect(log).toContain("tetap-jalan");
  });
});

describe("assertCommitAware (efek setelah commit wajib menunggu commit)", () => {
  /** Tx tiruan dengan rollback() seperti PgTransaction Drizzle. */
  function txLike(id: number): Tx {
    return { id, rollback: () => undefined } as unknown as Tx;
  }

  it("menerima tx dari withTx dan db tanpa transaksi", async () => {
    const db = {
      transaction: <T>(fn: (tx: Tx) => Promise<T>) => fn(txLike(1)),
    } as unknown as Db;
    await withTx(db, async (tx) => {
      expect(() => assertCommitAware(tx, "Uji")).not.toThrow();
    });
    expect(() => assertCommitAware(db, "Uji")).not.toThrow();
  });

  it("menolak transaksi mentah di luar withTx dan savepoint di dalam withTx", async () => {
    expect(() => assertCommitAware(txLike(7), "Uji.layanan")).toThrow(/Uji\.layanan wajib dipanggil/);
    const db = {
      transaction: <T>(fn: (tx: Tx) => Promise<T>) => fn(txLike(2)),
    } as unknown as Db;
    await withTx(db, async () => {
      expect(() => assertCommitAware(txLike(3), "Uji")).toThrow();
    });
  });
});
