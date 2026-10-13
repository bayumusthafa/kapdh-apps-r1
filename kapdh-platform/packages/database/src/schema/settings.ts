import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, text, uuid } from "drizzle-orm/pg-core";
import { app, tstz } from "./_common.js";
import { admins } from "./identity.js";

/** Kunci app_settings final (ARCHITECTURE §5.4). Skema nilai divalidasi zod di API (core/settings/keys.ts). */
export const APP_SETTING_KEYS = [
  "fees",
  "membership",
  "events",
  "chat",
  "min_app_version",
  "maintenance",
  "store_links",
  "support",
  "legal",
  "payment_instructions",
] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];

/**
 * Konfigurasi terversi (PRD 6.2): biaya (D4), periode, jendela, kebijakan, versi aplikasi minimum, maintenance.
 * Menggantikan fee_settings. Setiap perubahan menaikkan version, diaudit, dan payment menyimpan settings_version
 * sehingga transaksi lama tidak berubah (AC F15-3, F03-5).
 */
export const appSettings = app.table(
  "app_settings",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    version: integer("version").notNull().default(1),
    updatedByAdminId: uuid("updated_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("app_settings_updated_by_admin_id_idx")
      .on(t.updatedByAdminId)
      .where(sql`${t.updatedByAdminId} is not null`),
    check("app_settings_key_chk", sql`${t.key} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    check("app_settings_value_chk", sql`jsonb_typeof(${t.value}) = 'object'`),
    check("app_settings_version_chk", sql`${t.version} >= 1`),
  ],
);
