import type * as schema from "@kapdh/database";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/** Tipe database aplikasi. Di uji, instance PGlite dengan API yang sama dipasang di token DB. */
export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
