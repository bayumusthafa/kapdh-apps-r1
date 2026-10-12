import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, Tx } from "./types.js";

/**
 * Transaksi dengan antrean efek samping setelah commit (ARCHITECTURE §4.2): emit socket, invalidasi cache, dan efek
 * lain yang tidak boleh terjadi bila transaksi batal ("Event dikirim sesudah commit", PRD 5.2).
 *
 *   const result = await withTx(db, async (tx) => {
 *     ...perubahan, audit, outbox...
 *     afterCommit(() => realtime.emitToUser(userId, …));
 *     return row;
 *   });
 *
 * withTx yang dipanggil di dalam withTx lain (alur async yang sama) MENGGABUNG transaksi luar: fn memakai tx luar dan
 * callback afterCommit baru dijalankan setelah transaksi terluar commit. Tidak ada savepoint implisit.
 */
interface TxScope {
  tx: Tx;
  callbacks: (() => unknown)[];
}

const txStorage = new AsyncLocalStorage<TxScope>();

type AfterCommitErrorReporter = (error: unknown) => void;
let reportAfterCommitError: AfterCommitErrorReporter = () => {};

/** Dipasang CoreModule: galat callback setelah commit dicatat aman tanpa menggagalkan request (data sudah commit). */
export function setAfterCommitErrorReporter(reporter: AfterCommitErrorReporter): void {
  reportAfterCommitError = reporter;
}

async function flush(callbacks: (() => unknown)[]): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      reportAfterCommitError(error);
    }
  }
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const outer = txStorage.getStore();
  if (outer) return fn(outer.tx);
  const callbacks: (() => unknown)[] = [];
  const result = await db.transaction((tx) => txStorage.run({ tx, callbacks }, () => fn(tx)));
  await flush(callbacks);
  return result;
}

/**
 * Menjadwalkan efek samping setelah transaksi withTx yang sedang berjalan commit; dibuang bila transaksi batal.
 * Di luar withTx, callback dijalankan segera (tidak ada transaksi yang ditunggu).
 */
export function afterCommit(callback: () => unknown): void {
  const scope = txStorage.getStore();
  if (scope) {
    scope.callbacks.push(callback);
    return;
  }
  void flush([callback]);
}

/** Transaksi withTx yang sedang aktif pada alur async ini, atau undefined. */
export function currentTx(): Tx | undefined {
  return txStorage.getStore()?.tx;
}
