import { sql } from "drizzle-orm";
import { integer, numeric, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Semua objek berada di skema `app` (PRD 6.1). UUID v7 dibuat di API/aplikasi (`uuid` v7), bukan di database:
 * PostgreSQL 17 production tidak memiliki `uuidv7()` (ARCHITECTURE §5.2), jadi kolom id tidak memiliki default.
 */
export const app = pgSchema("app");

/** Primary key UUID tanpa default; nilai v7 selalu dikirim aplikasi. */
export const id = () => uuid("id").primaryKey();

/** Timestamp UTC (`timestamptz`). Kolom yang peka waktu diisi eksplisit dari Clock aplikasi (ARCHITECTURE §2.6). */
export const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** `now()` hanya cadangan; layanan mengisi nilai dari Clock agar konsisten dengan TestClock. */
export const createdAt = () => tstz("created_at").notNull().defaultNow();
export const updatedAt = () => tstz("updated_at").notNull().defaultNow();

/** Nominal IDR numeric(14,2); Drizzle mengembalikan string desimal, tidak pernah float (ARCHITECTURE §2.5). */
export const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

/** Versi optimistic concurrency (If-Match / expected_version, AC F15-4). */
export const version = () => integer("version").notNull().default(1);

/** Daftar literal SQL untuk CHECK `kolom in (...)` dari konstanta TypeScript yang sama dengan kontrak. */
export const sqlInList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(","));
