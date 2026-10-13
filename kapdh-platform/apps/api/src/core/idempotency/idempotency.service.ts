import { Inject, Injectable } from "@nestjs/common";
import { idempotencyKeys } from "@kapdh/database";
import { and, eq, lte } from "drizzle-orm";
import { createHmac, hkdfSync } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../adapters/clock.js";
import type { Db } from "../db/types.js";
import { AppException } from "../errors/app-exception.js";
import { CLOCK, DB, ENV } from "../tokens.js";

/** Masa simpan kunci (PRD 4.3: usulan 24 jam). */
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
/**
 * Kunci `in_progress` lebih tua dari ini dianggap terbengkalai (proses mati setelah commit tetapi sebelum mencatat
 * hasil) dan boleh diambil alih. Jauh di atas batas waktu request mana pun.
 */
export const IDEMPOTENCY_STALE_MS = 2 * 60_000;

export type IdempotencyBegin =
  { kind: "proceed"; recordId: string } | { kind: "replay"; status: number; body: unknown };

export interface IdempotencyScope {
  /** id pengguna aktor, atau `anon` untuk endpoint tanpa autentikasi. */
  scope: string;
  /** Metode + pola rute, mis. `POST /api/v1/auth/register`. */
  endpoint: string;
  /** Nilai header Idempotency-Key (UUID). */
  key: string;
  payloadHash: string;
}

/** JSON kanonik (kunci objek terurut) agar hash payload stabil terhadap urutan field. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, inner]) => `${JSON.stringify(k)}:${canonicalJson(inner)}`).join(",")}}`;
}

/** Label HKDF kunci hash payload; memisahkan kunci ini dari pemakaian OTP_HMAC_SECRET untuk OTP. */
const PAYLOAD_KEY_INFO = "kapdh:idempotency-payload:v1";

/**
 * Hash payload ber-kunci (HMAC-SHA256 dengan kunci turunan HKDF dari secret server). Payload bisa memuat sandi
 * (POST /auth/register): SHA-256 polos atas payload yang sebagian besar mudah ditebak sama dengan menyimpan hash cepat
 * sandi di samping bcrypt, sehingga kebocoran tabel idempotency_keys memungkinkan tebakan sandi offline.
 */
export function keyedPayloadHash(secret: string, payload: unknown): string {
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), PAYLOAD_KEY_INFO, 32));
  return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
}

/**
 * Idempotency-Key (PRD 4.3, ARCHITECTURE §4.2): permintaan ulang dengan key dan payload sama mengembalikan hasil
 * pertama; payload berbeda dengan key sama, atau permintaan sama yang masih diproses, menghasilkan
 * 409 IDEMPOTENCY_CONFLICT. Keunikan (scope, endpoint, key) dijamin indeks unik database, sehingga aman lintas
 * replica dan permintaan bersamaan (PRD 9.2 "idempotent replay under concurrency").
 *
 * Hanya respons sukses (2xx) yang disimpan; galat melepas kunci agar klien dapat mencoba ulang dengan key yang sama
 * (mis. setelah 429 atau gangguan jaringan). Kunci domain (keputusan payment, client_message_id) tetap menjamin
 * deduplikasi setelah masa simpan berakhir.
 */
@Injectable()
export class IdempotencyService {
  private readonly payloadKeySecret: string | undefined;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    // ApiEnv di API; WorkerEnv tidak memegang OTP_HMAC_SECRET (worker hanya membersihkan kunci kedaluwarsa).
    @Inject(ENV) env: { OTP_HMAC_SECRET?: string },
  ) {
    this.payloadKeySecret = env.OTP_HMAC_SECRET;
  }

  /** Hash payload (body + parameter path) yang dibandingkan antarpermintaan dengan key yang sama. */
  hashPayload(payload: unknown): string {
    if (!this.payloadKeySecret) throw new Error("Hash payload idempotensi hanya tersedia di runtime API");
    return keyedPayloadHash(this.payloadKeySecret, payload);
  }

  async begin(input: IdempotencyScope): Promise<IdempotencyBegin> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = this.clock.now();
      const id = uuidv7();
      const inserted = await this.db
        .insert(idempotencyKeys)
        .values({
          id,
          scope: input.scope,
          endpoint: input.endpoint,
          key: input.key,
          payloadHash: input.payloadHash,
          status: "in_progress",
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [idempotencyKeys.scope, idempotencyKeys.endpoint, idempotencyKeys.key],
        })
        .returning({ id: idempotencyKeys.id });
      if (inserted.length > 0) return { kind: "proceed", recordId: id };

      const [existing] = await this.db
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.scope, input.scope),
            eq(idempotencyKeys.endpoint, input.endpoint),
            eq(idempotencyKeys.key, input.key),
          ),
        )
        .limit(1);
      if (!existing) continue; // dilepas permintaan lain di antara insert dan select
      if (existing.expiresAt <= now) {
        await this.db
          .delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.id, existing.id), lte(idempotencyKeys.expiresAt, now)));
        continue;
      }
      if (existing.payloadHash !== input.payloadHash)
        throw new AppException(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Kunci permintaan ini sudah dipakai untuk data yang berbeda. Mulai ulang tindakan.",
        );
      if (existing.status === "completed")
        return { kind: "replay", status: existing.responseStatus ?? 200, body: existing.responseBody };

      if (now.getTime() - existing.updatedAt.getTime() > IDEMPOTENCY_STALE_MS) {
        const taken = await this.db
          .update(idempotencyKeys)
          .set({ updatedAt: now })
          .where(
            and(
              eq(idempotencyKeys.id, existing.id),
              eq(idempotencyKeys.status, "in_progress"),
              eq(idempotencyKeys.updatedAt, existing.updatedAt),
            ),
          )
          .returning({ id: idempotencyKeys.id });
        if (taken.length > 0) return { kind: "proceed", recordId: existing.id };
      }
      throw new AppException(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Permintaan yang sama masih diproses. Coba lagi sebentar.",
        {
          retryAfterSeconds: 2,
        },
      );
    }
    throw new AppException(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Permintaan yang sama masih diproses. Coba lagi sebentar.",
      {
        retryAfterSeconds: 2,
      },
    );
  }

  /** Mencatat hasil sukses untuk diputar ulang. */
  async complete(recordId: string, status: number, body: unknown): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({
        status: "completed",
        responseStatus: status,
        responseBody: body === undefined ? null : body,
        updatedAt: this.clock.now(),
      })
      .where(and(eq(idempotencyKeys.id, recordId), eq(idempotencyKeys.status, "in_progress")));
  }

  /** Melepas kunci setelah galat sehingga key yang sama dapat dicoba ulang. */
  async abandon(recordId: string): Promise<void> {
    await this.db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.id, recordId), eq(idempotencyKeys.status, "in_progress")));
  }

  /** Pembersihan kunci kedaluwarsa (job maintenance.cleanup harian, ARCHITECTURE §4.8). */
  async purgeExpired(now = this.clock.now()): Promise<number> {
    const deleted = await this.db
      .delete(idempotencyKeys)
      .where(lte(idempotencyKeys.expiresAt, now))
      .returning({ id: idempotencyKeys.id });
    return deleted.length;
  }
}
