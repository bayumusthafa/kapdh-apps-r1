import { Controller, Get, Header, HttpCode, Inject, Res } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { BaseEnv } from "@kapdh/config";
import type { StorageDriver } from "@kapdh/storage";
import { outboxEvents } from "@kapdh/database";
import { eq, min, sql } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { Clock } from "../../core/adapters/clock.js";
import type { RedisClient } from "../../core/adapters/redis.js";
import type { Db } from "../../core/db/types.js";
import { Public } from "../../core/guards/decorators.js";
import { CLOCK, DB, ENV, REDIS, STORAGE } from "../../core/tokens.js";
import { DeletionLedgerGate } from "../account/deletion-ledger-gate.js";

type HealthStatus = components["schemas"]["HealthStatus"];
type HealthReadiness = components["schemas"]["HealthReadiness"];
type CheckState = components["schemas"]["HealthCheckState"];

/** Batas waktu setiap pemeriksaan agar probe orkestrator tidak menggantung saat dependensi macet. */
const CHECK_TIMEOUT_MS = 2_000;
/** Key yang hanya di-stat (tidak pernah ditulis) untuk membuktikan storage dapat dijangkau. */
const STORAGE_PROBE_KEY = "health/ready-probe";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function probe(check: () => Promise<unknown>): Promise<CheckState> {
  try {
    await withTimeout(check(), CHECK_TIMEOUT_MS);
    return "ok";
  } catch {
    return "fail";
  }
}

/**
 * Health check (PRD 5.5, N-05): /health = liveness proses (tanpa dependensi, untuk orkestrator), /health/ready =
 * kesiapan melayani: ping PostgreSQL, Redis bila dikonfigurasi, storage bila dipasang, deletion ledger sudah
 * diterapkan ke database (AC F14-6: database pulihan yang belum menjalankan ledger-reapply tidak dibuka), ditambah umur
 * outbox pending tertua sebagai sinyal worker macet (tidak memengaruhi status API). Tidak memuat pesan galat, host,
 * atau data pribadi. /health juga melaporkan commit sumber image (KAPDH_COMMIT dari build arg CI) agar uji asap deploy
 * membuktikan digest yang dipromosikan benar-benar berjalan (PRD 5.5, infra/ci/smoke.mjs).
 */
@Controller("health")
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: RedisClient | null,
    @Inject(STORAGE) private readonly storage: StorageDriver | null,
    private readonly deletionLedger: DeletionLedgerGate,
    @Inject(ENV) private readonly env: Pick<BaseEnv, "KAPDH_COMMIT">,
  ) {}

  @Get()
  @Public()
  @Header("cache-control", "no-store")
  health(): HealthStatus {
    return { status: "ok", time: this.clock.now().toISOString(), commit: this.env.KAPDH_COMMIT ?? null };
  }

  @Get("ready")
  @Public()
  @HttpCode(200)
  @Header("cache-control", "no-store")
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthReadiness> {
    const now = this.clock.now();
    const redis = this.redis;
    const storage = this.storage;
    const [database, redisState, storageState] = await Promise.all([
      probe(() => this.db.execute(sql`select 1`)),
      redis ? probe(() => redis.ping()) : Promise.resolve<CheckState>("skipped"),
      storage ? probe(() => storage.stat(STORAGE_PROBE_KEY)) : Promise.resolve<CheckState>("skipped"),
    ]);
    const oldestPendingSeconds = database === "ok" ? await this.oldestPendingOutboxSeconds(now) : null;
    // Deletion ledger dinilai hanya bila database dan storage terjangkau (selain itu readiness sudah gagal).
    const deletionLedger: CheckState =
      database === "ok" && storageState === "ok" ? await this.deletionLedgerState() : "skipped";
    const ready =
      database === "ok" && redisState !== "fail" && storageState !== "fail" && deletionLedger !== "fail";
    if (!ready) void reply.status(503);
    return {
      status: ready ? "ok" : "unavailable",
      time: now.toISOString(),
      checks: {
        database,
        redis: redisState,
        storage: storageState,
        deletion_ledger: deletionLedger,
        outbox_oldest_pending_seconds: oldestPendingSeconds,
      },
    };
  }

  private async deletionLedgerState(): Promise<CheckState> {
    try {
      return await withTimeout(this.deletionLedger.check(), CHECK_TIMEOUT_MS);
    } catch {
      return "fail";
    }
  }

  /** Umur event outbox `pending` tertua (detik), null bila tidak ada atau kueri gagal. */
  private async oldestPendingOutboxSeconds(now: Date): Promise<number | null> {
    try {
      const [row] = await withTimeout(
        this.db
          .select({ oldest: min(outboxEvents.createdAt) })
          .from(outboxEvents)
          .where(eq(outboxEvents.status, "pending")),
        CHECK_TIMEOUT_MS,
      );
      return row?.oldest ? Math.max(0, Math.floor((now.getTime() - row.oldest.getTime()) / 1000)) : null;
    } catch {
      return null;
    }
  }
}
