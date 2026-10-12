import { Controller, Get, Header, HttpCode, Inject, Res } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { outboxEvents } from "@kapdh/database";
import { and, eq, min, sql } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { Clock } from "../../core/adapters/clock.js";
import type { RedisClient } from "../../core/adapters/redis.js";
import type { Db } from "../../core/db/types.js";
import { Public } from "../../core/guards/decorators.js";
import { CLOCK, DB, REDIS } from "../../core/tokens.js";

type HealthStatus = components["schemas"]["HealthStatus"];
type HealthReadiness = components["schemas"]["HealthReadiness"];

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref()),
  ]);
}

/**
 * Health check (PRD 5.5, N-05): /health = liveness proses (tanpa dependensi, untuk orkestrator), /health/ready =
 * kesiapan melayani (ping PostgreSQL, Redis bila dipakai, dan umur outbox tertua yang belum terkirim sebagai sinyal
 * worker macet). Tidak memuat data pribadi.
 */
@Controller("health")
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: RedisClient | null,
  ) {}

  @Get()
  @Public()
  @Header("cache-control", "no-store")
  health(): HealthStatus {
    return { status: "ok", time: this.clock.now().toISOString() };
  }

  @Get("ready")
  @Public()
  @HttpCode(200)
  @Header("cache-control", "no-store")
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthReadiness> {
    const now = this.clock.now();
    let database: "ok" | "unavailable" = "ok";
    let oldestPendingSeconds: number | null = null;
    try {
      await withTimeout(this.db.execute(sql`select 1`), CHECK_TIMEOUT_MS);
      const [row] = await withTimeout(
        this.db
          .select({ oldest: min(outboxEvents.createdAt) })
          .from(outboxEvents)
          .where(and(eq(outboxEvents.status, "pending"))),
        CHECK_TIMEOUT_MS,
      );
      if (row?.oldest) oldestPendingSeconds = Math.max(0, Math.floor((now.getTime() - row.oldest.getTime()) / 1000));
    } catch {
      database = "unavailable";
    }
    let redis: "ok" | "unavailable" | "not_configured" = "not_configured";
    if (this.redis) {
      try {
        await withTimeout(this.redis.ping(), CHECK_TIMEOUT_MS);
        redis = "ok";
      } catch {
        redis = "unavailable";
      }
    }
    const ready = database === "ok" && redis !== "unavailable";
    if (!ready) void reply.status(503);
    return {
      status: ready ? "ok" : "unavailable",
      time: now.toISOString(),
      checks: { database, redis, outbox_oldest_pending_seconds: oldestPendingSeconds },
    };
  }
}
