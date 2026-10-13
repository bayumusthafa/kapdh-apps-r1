import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, DbOrTx, Tx } from "./types.js";

/**
 * Transaksi dengan antrean efek samping setelah commit (ARCHITECTURE §4.2, §4.10): emit socket, invalidasi cache, dan
 * efek lain yang tidak boleh terjadi bila transaksi batal ("Event dikirim sesudah commit", PRD 5.2).
 *
 *   // Bentuk mana pun setara untuk DB yang diinjeksi (token DB sudah commitAwareDb):
 *   const result = await this.db.transaction(async (tx) => { ... });   // transaksi baru
 *   const result = await this.txRunner.run(async (tx) => { ... });     // bergabung bila sudah di dalam withTx
 *   const result = await withTx(this.db, async (tx) => {
 *     ...perubahan, audit, outbox...
 *     afterCommit(() => realtime.emitToUser(userId, …));
 *     return row;
 *   });
 *
 * withTx yang dipanggil di dalam withTx lain (alur async yang sama) MENGGABUNG transaksi luar: fn memakai tx luar dan
 * callback afterCommit baru dijalankan setelah transaksi terluar commit. Tidak ada savepoint implisit. Savepoint
 * (`tx.transaction(...)`) tidak commit-aware dan ditolak kernel core ({@link assertCommitAware}).
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

type TransactionConfig = Parameters<Db["transaction"]>[1];
type BeginTransaction = <T>(callback: (tx: Tx) => Promise<T>, config?: TransactionConfig) => Promise<T>;

const COMMIT_AWARE = Symbol.for("kapdh.commitAwareDb");

/** Transaksi BARU dengan antrean afterCommit sendiri; callback dijalankan hanya bila transaksi ini commit. */
async function runScoped<T>(
  begin: BeginTransaction,
  fn: (tx: Tx) => Promise<T>,
  config?: TransactionConfig,
): Promise<T> {
  const callbacks: (() => unknown)[] = [];
  const result = await begin((tx) => txStorage.run({ tx, callbacks }, () => fn(tx)), config);
  await flush(callbacks);
  return result;
}

export function isCommitAware(db: Db): boolean {
  return (db as unknown as Record<symbol, unknown>)[COMMIT_AWARE] === true;
}

/**
 * Membungkus database sehingga `db.transaction(fn)` SELALU commit-aware (ARCHITECTURE §4.10): setiap panggilan membuka
 * transaksi baru (semantik Drizzle tetap: tidak bergabung dengan transaksi lain) dengan antrean afterCommit sendiri,
 * sehingga layanan modul yang memakai `db.transaction` langsung dapat memanggil kernel core (NotificationService,
 * MembershipKernel, FilesService) dan efek setelah commit menunggu commit transaksi itu. CoreModule memasang versi ini
 * pada token DB. Pembungkus memakai prototipe (Object.create), sehingga semua API Drizzle lain tidak berubah.
 */
export function commitAwareDb(db: Db): Db {
  if (isCommitAware(db)) return db;
  const begin = db.transaction.bind(db) as BeginTransaction;
  const wrapped = Object.create(db) as Db;
  Object.defineProperty(wrapped, "transaction", {
    value: <T>(fn: (tx: Tx) => Promise<T>, config?: TransactionConfig) => runScoped(begin, fn, config),
    enumerable: false,
  });
  Object.defineProperty(wrapped, COMMIT_AWARE, { value: true, enumerable: false });
  return wrapped;
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const outer = txStorage.getStore();
  if (outer) return fn(outer.tx);
  if (isCommitAware(db)) return db.transaction(fn);
  return runScoped(db.transaction.bind(db) as BeginTransaction, fn);
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

/**
 * Gagal cepat bila `tx` bukan transaksi commit-aware: savepoint (`tx.transaction(...)`) atau transaksi dari database
 * yang TIDAK dibungkus {@link commitAwareDb} (mis. instance Drizzle mentah di CLI). Di sana afterCommit tidak dapat
 * menunggu commit sehingga efek samping (emit socket, putus sesi) bisa terjadi untuk data yang akhirnya batal. `db`
 * tanpa transaksi diizinkan (setiap pernyataan langsung commit). Dipanggil layanan core yang menjadwalkan afterCommit
 * (NotificationService, MembershipKernel, FilesService.discard). Transaksi dari DB yang diinjeksi (`this.db.transaction`),
 * TxRunner dan withTx selalu lolos.
 */
export function assertCommitAware(tx: DbOrTx, caller: string): void {
  const isTransaction = typeof (tx as { rollback?: unknown }).rollback === "function";
  if (isTransaction && txStorage.getStore()?.tx !== tx)
    throw new Error(
      `${caller} wajib dipanggil dengan tx commit-aware (this.db.transaction dari DB yang diinjeksi, TxRunner, atau ` +
        "withTx), bukan savepoint atau instance Drizzle mentah, agar efek setelah commit menunggu commit",
    );
}
