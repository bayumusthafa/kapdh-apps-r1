import { APP_SETTING_KEYS, type AppSettingKey } from "@kapdh/database";
import { REFERENCE_SETTINGS } from "@kapdh/database/seeds/reference";
import semver from "semver";
import { z } from "zod";

/**
 * Skema bertipe app_settings (ARCHITECTURE §5.4, PRD 6.2). Nilai di database selalu divalidasi skema ini saat dibaca
 * dan ditulis; Money berupa string desimal (ARCHITECTURE §2.5).
 */
const money = z.string().regex(/^\d{1,12}\.\d{2}$/, "Nominal tidak valid, contoh 50000.00");
const appVersion = z
  .string()
  .max(32)
  .refine((v) => semver.valid(v) !== null, "Versi harus semver, contoh 1.2.0");
const storeUrl = z.union([z.url({ protocol: /^https$/, message: "Tautan toko wajib https" }), z.null()]);
/** Versi tayang halaman legal = pages.published_version (bilangan bulat >= 1) sebagai string; null = belum terbit. */
const legalVersion = z.union([
  z.string().regex(/^[1-9][0-9]{0,8}$/, "Versi legal berupa bilangan bulat >= 1"),
  z.null(),
]);

export const SETTING_SCHEMAS = {
  // D4: biaya pendaftaran + pembuatan KTA, perpanjangan per tahun.
  fees: z.object({ registration_fee: money, card_fee: money, renewal_fee: money }).strict(),
  // PRD 2.1/3.7 (D4): 12 bulan kalender, expiring 30 hari, jendela renewal 30 hari. Ditetapkan PRD, hanya baca.
  membership: z
    .object({
      period_months: z.literal(12),
      expiring_days: z.literal(30),
      renewal_window_days: z.literal(30),
    })
    .strict(),
  // D5/D6: hold 24 jam, check-in 2 jam sebelum mulai, batal mandiri sampai H-3, eskalasi 2 hari kerja.
  events: z
    .object({
      hold_hours: z.number().int().min(1).max(72),
      checkin_before_hours: z.number().int().min(0).max(24),
      self_cancel_days: z.number().int().min(0).max(30),
      review_escalation_business_days: z.number().int().min(1).max(10),
    })
    .strict(),
  // v3.2: teks 4.000 karakter, grup maksimal 100 anggota.
  chat: z
    .object({
      max_text_chars: z.number().int().min(1).max(4000),
      max_group_members: z.number().int().min(2).max(100),
    })
    .strict(),
  // PRD 4.5: mutasi dari versi di bawah minimum ditolak 426 UPGRADE_REQUIRED.
  min_app_version: z.object({ android: appVersion, ios: appVersion }).strict(),
  // PRD 4.5: mode pemeliharaan menolak mutasi (503 MAINTENANCE); baca tetap terkendali.
  maintenance: z
    .object({
      active: z.boolean(),
      message: z.union([z.string().trim().min(1).max(500), z.null()]),
      until: z.union([z.iso.datetime({ offset: true }), z.null()]),
    })
    .strict(),
  store_links: z.object({ android: storeUrl, ios: storeUrl }).strict(),
  // PRD 8.3: kanal dukungan.
  support: z
    .object({
      email: z.email("Email tidak valid"),
      whatsapp: z.union([z.string().regex(/^\+?[0-9]{8,15}$/, "Nomor WhatsApp tidak valid"), z.null()]),
    })
    .strict(),
  // Mencerminkan pages.published_version halaman legal (F-01, F-08); null selama belum diterbitkan.
  legal: z
    .object({ privacy_version: legalVersion, terms_version: legalVersion, community_version: legalVersion })
    .strict(),
  // D13 (PRD 10.2 rencana cadangan iOS): platform aplikasi yang tidak menampilkan instruksi bayar iuran
  // (registration/renewal); tiket tidak terpengaruh. Dibaca per request dari header X-App-Platform (kontrak C3).
  payment_instructions: z
    .object({
      dues_hidden_platforms: z
        .array(z.enum(["android", "ios"]))
        .max(2)
        .refine((platforms) => new Set(platforms).size === platforms.length, "Platform tidak boleh ganda"),
    })
    .strict(),
} as const satisfies Record<AppSettingKey, z.ZodType>;

export type SettingKey = AppSettingKey;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;
export type Settings = { [K in SettingKey]: SettingValue<K> };

export const SETTING_KEYS: readonly SettingKey[] = APP_SETTING_KEYS;

/** Kunci yang ditetapkan PRD dan tidak dapat diubah lewat API (PRD 2.1, 3.7). */
export const READ_ONLY_SETTING_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>(["membership"]);

/**
 * Nilai bawaan = seed referensi production (packages/database seeds/reference.ts, PRD 8.2 langkah 4). Dipakai bila
 * baris belum ada (versi 0); divalidasi saat modul dimuat agar seed dan skema tidak pernah menyimpang.
 */
export const SETTING_DEFAULTS: Settings = Object.fromEntries(
  SETTING_KEYS.map((key) => [key, SETTING_SCHEMAS[key].parse(REFERENCE_SETTINGS[key])]),
) as Settings;

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}
