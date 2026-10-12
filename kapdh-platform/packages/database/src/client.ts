import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as community from "./schema/community.js";
import * as content from "./schema/content.js";
import * as events from "./schema/events.js";
import * as identity from "./schema/identity.js";
import * as membership from "./schema/membership.js";
import * as notifications from "./schema/notifications.js";
import * as payments from "./schema/payments.js";
import * as platform from "./schema/platform.js";
import * as relations from "./schema/relations.js";
import * as settings from "./schema/settings.js";

/** Seluruh tabel dan relasi skema `app` untuk `db.query.*` (ARCHITECTURE §5.3). Modul baru wajib didaftarkan di sini. */
export const schema = {
  ...identity,
  ...membership,
  ...payments,
  ...settings,
  ...content,
  ...events,
  ...community,
  ...notifications,
  ...platform,
  ...relations,
};

export interface CreateDbOptions {
  /** Ukuran pool koneksi postgres-js (default 10). */
  max?: number;
  /** Nama aplikasi di pg_stat_activity, misalnya `kapdh-api` atau `kapdh-worker` (N-14). */
  applicationName?: string;
}

/** Membuat koneksi postgres-js + Drizzle. Pemanggil wajib menutup `sql.end()` saat shutdown. */
export function createDb(url: string, options: CreateDbOptions = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    prepare: true,
    onnotice: () => {},
    ...(options.applicationName ? { connection: { application_name: options.applicationName } } : {}),
  });
  return { db: drizzle(sql, { schema }), sql };
}

export type Database = ReturnType<typeof createDb>["db"];
