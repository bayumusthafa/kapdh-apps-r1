import type { schema } from "@kapdh/database";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Tipe database aplikasi (skema `app` lengkap untuk `db.query.*`). Di uji, instance PGlite dengan API kueri yang sama
 * dipasang di token DB.
 */
export type Db = PostgresJsDatabase<typeof schema>;
/** Transaksi Drizzle (`db.transaction(async (tx) => …)`). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Helper yang boleh berjalan di dalam atau di luar transaksi. */
export type DbOrTx = Db | Tx;
