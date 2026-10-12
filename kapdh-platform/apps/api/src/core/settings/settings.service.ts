import { Inject, Injectable } from "@nestjs/common";
import { appSettings } from "@kapdh/database";
import { and, eq, sql } from "drizzle-orm";
import { performance } from "node:perf_hooks";
import type { Clock } from "../adapters/clock.js";
import { AuditService } from "../audit/audit.service.js";
import { ctx } from "../context/request-context.js";
import { afterCommit } from "../db/tx.js";
import type { Db, DbOrTx, Tx } from "../db/types.js";
import { AppException, versionConflict } from "../errors/app-exception.js";
import { CLOCK, DB } from "../tokens.js";
import { fieldErrorsOf } from "../validation/validate.js";
import {
  READ_ONLY_SETTING_KEYS,
  SETTING_DEFAULTS,
  SETTING_KEYS,
  SETTING_SCHEMAS,
  type SettingKey,
  type Settings,
  type SettingValue,
} from "./keys.js";

export interface SettingEntry<K extends SettingKey> {
  key: K;
  value: SettingValue<K>;
  /** Versi baris app_settings; 0 berarti baris belum ada dan nilai bawaan seed dipakai. */
  version: number;
  updatedAt: Date | null;
}

/** Masa cache per instance. Perubahan dari instance lain terlihat paling lambat setelah TTL ini. */
export const SETTINGS_CACHE_TTL_MS = 5_000;

/**
 * Konfigurasi terversi bertipe (PRD 6.2, ARCHITECTURE §5.4): dibaca dengan cache singkat, diperbarui dengan
 * predikat versi (AC F15-4) dan audit before/after dalam transaksi yang sama (AC F15-3, F17-1). Payment menyimpan
 * `version` sebagai settings_version sehingga transaksi lama tidak berubah (AC F03-5).
 */
@Injectable()
export class SettingsService {
  private readonly cache = new Map<SettingKey, { entry: SettingEntry<SettingKey>; expiresAt: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** Nilai bertipe sebuah kunci (memakai cache). */
  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    return (await this.getEntry(key)).value;
  }

  /**
   * Nilai + versi. Dengan `tx`, dibaca langsung dari transaksi tanpa cache (mis. snapshot biaya saat membuat
   * payment); `lock: true` menambahkan FOR SHARE agar versi tidak berubah sampai transaksi selesai.
   */
  async getEntry<K extends SettingKey>(
    key: K,
    options: { tx?: DbOrTx; lock?: boolean } = {},
  ): Promise<SettingEntry<K>> {
    if (!options.tx) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > performance.now()) return cached.entry as SettingEntry<K>;
    }
    const entry = await this.load(options.tx ?? this.db, key, options.lock ? "share" : null);
    if (!options.tx) this.cache.set(key, { entry, expiresAt: performance.now() + SETTINGS_CACHE_TTL_MS });
    return entry;
  }

  /** Semua kunci (untuk web admin dan /public/config). */
  async getAll(): Promise<Settings> {
    const values = await Promise.all(SETTING_KEYS.map(async (key) => [key, await this.get(key)] as const));
    return Object.fromEntries(values) as Settings;
  }

  /** Membuang cache lokal (setelah pembaruan, atau di uji setelah menulis app_settings langsung). */
  invalidate(key?: SettingKey): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  private async load<K extends SettingKey>(
    db: DbOrTx,
    key: K,
    lock: "share" | "update" | null,
  ): Promise<SettingEntry<K>> {
    const query = db
      .select({ value: appSettings.value, version: appSettings.version, updatedAt: appSettings.updatedAt })
      .from(appSettings)
      .where(eq(appSettings.key, key));
    const [row] = lock ? await query.for(lock) : await query;
    if (!row) return { key, value: SETTING_DEFAULTS[key], version: 0, updatedAt: null };
    const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
    if (!parsed.success) {
      // Data tersimpan rusak tidak boleh diam-diam diganti nilai lain: gagal keras agar operator memperbaiki.
      throw new Error(`app_settings ${key} versi ${row.version} tidak sesuai skema`);
    }
    return { key, value: parsed.data as SettingValue<K>, version: row.version, updatedAt: row.updatedAt };
  }

  /**
   * Memperbarui satu kunci dengan predikat versi. `expectedVersion` = versi yang dibaca klien (If-Match); 0 untuk kunci
   * yang belum tersimpan. Menulis audit `settings.updated` dengan before/after dan mengembalikan entri baru.
   */
  async update<K extends SettingKey>(
    tx: Tx,
    key: K,
    value: unknown,
    expectedVersion: number,
    options: { reason?: string | null } = {},
  ): Promise<SettingEntry<K>> {
    if (READ_ONLY_SETTING_KEYS.has(key))
      throw new AppException(403, "FORBIDDEN", "Pengaturan ini ditetapkan PRD dan tidak dapat diubah.");
    const parsed = SETTING_SCHEMAS[key].safeParse(value);
    if (!parsed.success)
      throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
        fieldErrors: fieldErrorsOf(parsed.error),
      });
    const next = parsed.data as SettingValue<K>;
    const now = this.clock.now();
    const actor = ctx().actor;
    const updatedByAdminId = actor.kind === "admin" ? actor.adminId : null;
    // FOR UPDATE (bukan SHARE): dua pembaruan bersamaan berurutan tanpa deadlock peningkatan kunci.
    const current = await this.load(tx, key, "update");
    const toCurrent = (entry: SettingEntry<K>) => ({ key, value: entry.value, version: String(entry.version) });
    if (current.version !== expectedVersion) throw versionConflict(toCurrent(current));

    let version: number;
    if (current.version === 0) {
      const inserted = await tx
        .insert(appSettings)
        .values({ key, value: next, version: 1, updatedByAdminId, updatedAt: now })
        .onConflictDoNothing()
        .returning({ version: appSettings.version });
      if (inserted.length === 0) throw versionConflict(toCurrent(await this.load(tx, key, null)));
      version = 1;
    } else {
      const updated = await tx
        .update(appSettings)
        .set({ value: next, version: sql`${appSettings.version} + 1`, updatedByAdminId, updatedAt: now })
        .where(and(eq(appSettings.key, key), eq(appSettings.version, expectedVersion)))
        .returning({ version: appSettings.version });
      if (updated.length === 0) throw versionConflict(toCurrent(await this.load(tx, key, null)));
      version = updated[0]!.version;
    }

    await this.audit.write(tx, {
      action: "settings.updated",
      entityType: "app_setting",
      entityId: key,
      reason: options.reason ?? null,
      before: { value: current.value, version: current.version },
      after: { value: next, version },
    });
    this.invalidate(key);
    afterCommit(() => this.invalidate(key));
    return { key, value: next, version, updatedAt: now };
  }
}
