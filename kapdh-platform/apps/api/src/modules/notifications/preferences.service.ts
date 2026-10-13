import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { notificationPreferences } from "@kapdh/database";
import { eq, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import type { Db, DbOrTx } from "../../core/db/types.js";
import { CLOCK, DB } from "../../core/tokens.js";
import {
  EMAIL_PREFERENCE_CATEGORIES,
  MANDATORY_CATEGORIES,
  PUSH_PREFERENCE_CATEGORIES,
} from "./channel-policy.js";

type NotificationPreferences = components["schemas"]["NotificationPreferences"];
type NotificationPreferencesUpdate = components["schemas"]["NotificationPreferencesUpdate"];

/**
 * Preferensi push/email per kategori (F-13, AC F13-2; ARCHITECTURE §4.7). Baris yang tidak ada berarti aktif; security
 * dan account wajib (tanpa baris, dilaporkan di `mandatory_categories`). Mematikan kategori hanya menghentikan
 * push/email berikutnya: inbox in-app tetap ditulis, dan pengiriman yang sudah dijadwalkan dibatalkan worker saat klaim
 * (`preference_disabled`).
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(userId: string, db: DbOrTx = this.db): Promise<NotificationPreferences> {
    const rows = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));
    const stored = (channel: "push" | "email", category: string) =>
      rows.find((row) => row.channel === channel && row.category === category)?.enabled;
    const push = Object.fromEntries(
      PUSH_PREFERENCE_CATEGORIES.map((category) => [category, stored("push", category) !== false]),
    ) as NotificationPreferences["push"];
    const email = Object.fromEntries(
      EMAIL_PREFERENCE_CATEGORIES.map((category) => [category, stored("email", category) !== false]),
    ) as NotificationPreferences["email"];
    const updatedAt = rows.reduce<Date | null>(
      (latest, row) => (latest === null || row.updatedAt > latest ? row.updatedAt : latest),
      null,
    );
    return {
      push,
      email,
      mandatory_categories: [...MANDATORY_CATEGORIES],
      updated_at: updatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Penggantian penuh (PUT): seluruh saklar ditulis dalam SATU pernyataan upsert berurutan kunci sama, sehingga dua PUT
   * bersamaan tidak menghasilkan campuran (yang terakhir commit menang untuk semua baris) dan tidak deadlock.
   */
  async replace(userId: string, input: NotificationPreferencesUpdate): Promise<NotificationPreferences> {
    const now = this.clock.now();
    const values = [
      ...PUSH_PREFERENCE_CATEGORIES.map((category) => ({
        userId,
        category,
        channel: "push" as const,
        enabled: input.push[category],
        updatedAt: now,
      })),
      ...EMAIL_PREFERENCE_CATEGORIES.map((category) => ({
        userId,
        category,
        channel: "email" as const,
        enabled: input.email[category],
        updatedAt: now,
      })),
    ];
    return this.db.transaction(async (tx) => {
      await tx
        .insert(notificationPreferences)
        .values(values)
        .onConflictDoUpdate({
          target: [
            notificationPreferences.userId,
            notificationPreferences.category,
            notificationPreferences.channel,
          ],
          set: { enabled: sql`excluded.enabled`, updatedAt: sql`excluded.updated_at` },
        });
      return this.get(userId, tx);
    });
  }
}
