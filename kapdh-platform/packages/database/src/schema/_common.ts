import { pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

/** Semua tabel berada di skema `app` (PRD 6.1). UUID v7 dibuat di API, bukan di database. */
export const app = pgSchema("app");

export const id = () => uuid("id").primaryKey();
export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
