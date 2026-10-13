import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { admins, appSettings } from "@kapdh/database";
import { eq, inArray } from "drizzle-orm";
import semver from "semver";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import type { Db, DbOrTx } from "../../core/db/types.js";
import { AppException, fieldError, versionConflict } from "../../core/errors/app-exception.js";
import { normalizeEmail } from "../../core/identity/email.js";
import {
  SETTING_DEFAULTS,
  SETTING_SCHEMAS,
  type SettingKey,
  type SettingValue,
} from "../../core/settings/keys.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { validate } from "../../core/validation/validate.js";

type Schemas = components["schemas"];
type AdminSettingMeta = Schemas["AdminSettingMeta"];
type FeeSettings = Schemas["FeeSettings"];
type AdminAppSettings = Schemas["AdminAppSettings"];

/** Kunci yang tampil di halaman Pengaturan (kunci `legal` dikelola penerbitan halaman F-08, tidak ditampilkan). */
const ADMIN_KEYS = [
  "fees",
  "min_app_version",
  "maintenance",
  "store_links",
  "support",
  "payment_instructions",
  "membership",
  "events",
  "chat",
] as const satisfies readonly SettingKey[];
type AdminKey = (typeof ADMIN_KEYS)[number];

interface StoredSetting<K extends SettingKey> {
  value: SettingValue<K>;
  meta: AdminSettingMeta;
}

// ------------------------------------------------------------------------------------- skema input (kontrak C3)

/** Money numeric(14,2): 0 sampai 999999999999.99 (kontrak FeeSettingsInput). */
const money = z
  .string({ message: "Nominal wajib diisi, contoh 50000.00" })
  .regex(/^\d{1,12}\.\d{2}$/, "Nominal tidak valid. Gunakan dua angka desimal, contoh 50000.00");
const optionalReason = z
  .string()
  .max(500, "Maksimal 500 karakter")
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : null));

export const FeeSettingsInputSchema = z.object({
  registration_fee: money,
  card_fee: money,
  renewal_fee: money,
  reason: optionalReason,
});

const semverInput = z
  .string({ message: "Versi wajib diisi, contoh 1.2.0" })
  .max(32, "Maksimal 32 karakter")
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+$/, "Gunakan format MAJOR.MINOR.PATCH, contoh 1.2.0")
  .refine((v) => semver.valid(v) !== null, "Versi tidak valid (tanpa angka nol di depan), contoh 1.2.0");
export const MinAppVersionInputSchema = z.object({ android: semverInput, ios: semverInput });

export const MaintenanceInputSchema = z.object({
  active: z.boolean({ message: "Pilih aktif atau tidak" }),
  message: z.union([z.string().max(500, "Maksimal 500 karakter"), z.null()], {
    message: "Pesan wajib berupa teks atau null",
  }),
  until: z.union([z.iso.datetime({ offset: true, message: "Format waktu tidak valid" }), z.null()], {
    message: "Waktu wajib berupa tanggal-waktu atau null",
  }),
});

function storeUrl(host: "play.google.com" | "apps.apple.com", label: string) {
  return z.union(
    [
      z
        .string()
        .max(500, "Maksimal 500 karakter")
        .refine((value) => {
          if (!value.startsWith(`https://${host}/`)) return false;
          try {
            return new URL(value).hostname === host;
          } catch {
            return false;
          }
        }, `Gunakan tautan https://${host}/ (${label})`),
      z.null(),
    ],
    { message: `Isi tautan https://${host}/ atau null` },
  );
}
export const StoreLinksInputSchema = z.object({
  android: storeUrl("play.google.com", "Google Play"),
  ios: storeUrl("apps.apple.com", "App Store"),
});

export const PaymentInstructionsInputSchema = z.object({
  dues_hidden_platforms: z
    .array(z.enum(["android", "ios"], { message: "Platform harus android atau ios" }), {
      message: "Daftar platform wajib diisi",
    })
    .max(2, "Maksimal 2 platform")
    .refine((list) => new Set(list).size === list.length, "Platform tidak boleh ganda"),
  reason: optionalReason,
});

export const SupportInputSchema = z.object({
  email: z.email("Email tidak valid").max(254, "Maksimal 254 karakter"),
  whatsapp: z.union(
    [z.string().regex(/^\+[1-9][0-9]{7,14}$/, "Gunakan format E.164, contoh +6281234567890"), z.null()],
    { message: "Isi nomor WhatsApp E.164 atau null" },
  ),
});

// ---------------------------------------------------------------------------------------- aritmetika Money

/** "60000.00" -> 6000000n (sen); tanpa floating point (ARCHITECTURE §2.5). */
function toCents(value: string): bigint {
  const [whole = "0", fraction = "00"] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function fromCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = cents % 100n;
  return `${whole.toString()}.${fraction.toString().padStart(2, "0")}`;
}

export function addMoney(...values: string[]): string {
  return fromCents(values.reduce((sum, value) => sum + toCents(value), 0n));
}

/**
 * Pengaturan aplikasi terversi dan teraudit (F-15, AC F15-3, F15-4, F03-5, D4, D13, PRD 4.5): baca semua kunci beserta
 * versi dan pengurus terakhir; pembaruan per kunci lewat SettingsService.update (predikat versi If-Match, audit
 * `settings.updated` before/after dan snapshot versi dalam transaksi yang sama). Biaya baru hanya dipakai payment yang
 * dibuat sesudahnya karena payment menyimpan snapshot baris dan `settings_version` (AC F03-5).
 */
@Injectable()
export class AdminSettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  // ------------------------------------------------------------------------------------------------- baca

  private async load<K extends AdminKey>(db: DbOrTx, keys: readonly K[]): Promise<Map<K, StoredSetting<K>>> {
    const rows = await db
      .select({
        key: appSettings.key,
        value: appSettings.value,
        version: appSettings.version,
        updatedAt: appSettings.updatedAt,
        adminId: admins.id,
        displayName: admins.displayName,
      })
      .from(appSettings)
      .leftJoin(admins, eq(admins.id, appSettings.updatedByAdminId))
      .where(inArray(appSettings.key, [...keys]));
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const result = new Map<K, StoredSetting<K>>();
    for (const key of keys) {
      const row = byKey.get(key);
      if (!row) {
        // Kunci belum diseed: nilai bawaan versi 0 (If-Match 0 membuat baris pertama).
        result.set(key, {
          value: SETTING_DEFAULTS[key],
          meta: { version: "0", updated_at: this.clock.now().toISOString(), updated_by: null },
        });
        continue;
      }
      const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
      // Data tersimpan rusak tidak diganti diam-diam (sama dengan SettingsService).
      if (!parsed.success) throw new Error(`app_settings ${key} versi ${row.version} tidak sesuai skema`);
      result.set(key, {
        value: parsed.data as SettingValue<K>,
        meta: {
          version: String(row.version),
          updated_at: row.updatedAt.toISOString(),
          updated_by:
            row.adminId && row.displayName ? { admin_id: row.adminId, display_name: row.displayName } : null,
        },
      });
    }
    return result;
  }

  private async one<K extends AdminKey>(key: K, db: DbOrTx = this.db): Promise<StoredSetting<K>> {
    return (await this.load(db, [key])).get(key)!;
  }

  async all(): Promise<AdminAppSettings> {
    const map = await this.load(this.db, ADMIN_KEYS);
    const get = <K extends AdminKey>(key: K) => map.get(key) as StoredSetting<K>;
    return {
      fees: toFeeSettings(get("fees")),
      min_app_version: { ...get("min_app_version").meta, ...get("min_app_version").value },
      maintenance: { ...get("maintenance").meta, ...get("maintenance").value },
      store_links: { ...get("store_links").meta, ...get("store_links").value },
      support: { ...get("support").meta, ...get("support").value },
      payment_instructions: {
        ...get("payment_instructions").meta,
        dues_hidden_platforms: [...get("payment_instructions").value.dues_hidden_platforms],
      },
      membership: { ...get("membership").meta, ...get("membership").value },
      events: { ...get("events").meta, ...get("events").value },
      chat: { ...get("chat").meta, ...get("chat").value },
    };
  }

  async fees(): Promise<FeeSettings> {
    return toFeeSettings(await this.one("fees"));
  }

  // ---------------------------------------------------------------------------------------------- ubah

  /**
   * Satu transaksi: validasi lintas kunci (opsional), SettingsService.update (FOR UPDATE + predikat versi + audit),
   * lalu metadata dibaca ulang dalam transaksi yang sama. 409 VERSION_CONFLICT membawa `current` berbentuk respons
   * operasi (AC F15-4), bukan bentuk internal SettingsService.
   */
  private async apply<K extends AdminKey, R>(
    key: K,
    expectedVersion: number,
    build: (tx: DbOrTx) => Promise<unknown> | unknown,
    reason: string | null,
    toResponse: (stored: StoredSetting<K>) => R,
  ): Promise<R> {
    try {
      return await this.db.transaction(async (tx) => {
        const value = await build(tx);
        await this.settings.update(tx, key, value, expectedVersion, undefined, { reason });
        return toResponse(await this.one(key, tx));
      });
    } catch (error) {
      if (error instanceof AppException && error.code === "VERSION_CONFLICT")
        throw versionConflict(toResponse(await this.one(key)));
      throw error;
    }
  }

  async updateFees(body: unknown, expectedVersion: number): Promise<FeeSettings> {
    const input = validate(FeeSettingsInputSchema, body);
    return this.apply(
      "fees",
      expectedVersion,
      () => ({
        registration_fee: input.registration_fee,
        card_fee: input.card_fee,
        renewal_fee: input.renewal_fee,
      }),
      input.reason,
      toFeeSettings,
    );
  }

  async updateMinAppVersion(
    body: unknown,
    expectedVersion: number,
  ): Promise<Schemas["AdminMinAppVersionSetting"]> {
    const input = validate(MinAppVersionInputSchema, body);
    return this.apply(
      "min_app_version",
      expectedVersion,
      async (tx) => {
        // PRD 8.4: versi minimum hanya dinaikkan setelah versi baru dapat diunduh (tautan toko terisi).
        const current = await this.settings.getEntry("min_app_version", { tx });
        const links = await this.settings.getEntry("store_links", { tx, lock: true });
        for (const platform of ["android", "ios"] as const) {
          if (semver.gt(input[platform], current.value[platform]) && !links.value[platform])
            throw fieldError(
              platform,
              `Isi tautan toko ${platform === "android" ? "Google Play" : "App Store"} sebelum menaikkan versi minimum.`,
            );
        }
        return { android: input.android, ios: input.ios };
      },
      null,
      (stored) => ({ ...stored.meta, ...stored.value }),
    );
  }

  async updateMaintenance(body: unknown, expectedVersion: number): Promise<Schemas["AdminMaintenanceSetting"]> {
    const input = validate(MaintenanceInputSchema, body);
    const message = input.message && input.message.trim() !== "" ? input.message.trim() : null;
    const until = input.until ? new Date(input.until) : null;
    if (input.active) {
      // PRD 4.5: saat aktif, pesan berisi estimasi dan kanal dukungan wajib; perkiraan selesai di masa depan.
      if (!message) throw fieldError("message", "Pesan maintenance wajib diisi saat mode maintenance aktif.");
      if (until && until.getTime() <= this.clock.now().getTime())
        throw fieldError("until", "Perkiraan selesai harus di masa depan.");
    }
    return this.apply(
      "maintenance",
      expectedVersion,
      () => ({ active: input.active, message, until: until ? until.toISOString() : null }),
      null,
      (stored) => ({ ...stored.meta, ...stored.value }),
    );
  }

  async updateStoreLinks(body: unknown, expectedVersion: number): Promise<Schemas["AdminStoreLinksSetting"]> {
    const input = validate(StoreLinksInputSchema, body);
    return this.apply(
      "store_links",
      expectedVersion,
      () => ({ android: input.android, ios: input.ios }),
      null,
      (stored) => ({ ...stored.meta, ...stored.value }),
    );
  }

  async updatePaymentInstructions(
    body: unknown,
    expectedVersion: number,
  ): Promise<Schemas["AdminPaymentInstructionsSetting"]> {
    const input = validate(PaymentInstructionsInputSchema, body);
    return this.apply(
      "payment_instructions",
      expectedVersion,
      () => ({ dues_hidden_platforms: [...input.dues_hidden_platforms] }),
      input.reason,
      (stored) => ({ ...stored.meta, dues_hidden_platforms: [...stored.value.dues_hidden_platforms] }),
    );
  }

  async updateSupport(body: unknown, expectedVersion: number): Promise<Schemas["AdminSupportSetting"]> {
    const input = validate(SupportInputSchema, body);
    return this.apply(
      "support",
      expectedVersion,
      () => ({ email: normalizeEmail(input.email), whatsapp: input.whatsapp }),
      null,
      (stored) => ({ ...stored.meta, ...stored.value }),
    );
  }
}

/** FeeSettings kontrak: registration_total dihitung aritmetika desimal; effective_from = waktu versi ini. */
function toFeeSettings(stored: StoredSetting<"fees">): FeeSettings {
  const fees = stored.value;
  return {
    registration_fee: fees.registration_fee,
    card_fee: fees.card_fee,
    renewal_fee: fees.renewal_fee,
    registration_total: addMoney(fees.registration_fee, fees.card_fee),
    version: stored.meta.version,
    effective_from: stored.meta.updated_at,
    updated_by: stored.meta.updated_by,
  };
}
