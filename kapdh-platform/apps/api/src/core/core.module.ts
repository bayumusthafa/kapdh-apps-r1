import { type DynamicModule, Inject, Module, type OnModuleInit, type Provider } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { BaseEnv } from "@kapdh/config";
import type { StorageDriver } from "@kapdh/storage";
import type { Logger } from "pino";
import { TokenService } from "../modules/auth/token.service.js";
import type { Clock } from "./adapters/clock.js";
import type { Mailer } from "./adapters/mailer.js";
import type { PushSender } from "./adapters/push.js";
import type { RedisClient } from "./adapters/redis.js";
import { AuditService } from "./audit/audit.service.js";
import { tryCtx } from "./context/request-context.js";
import { TxRunner } from "./db/tx-runner.js";
import { setAfterCommitErrorReporter } from "./db/tx.js";
import type { Db } from "./db/types.js";
import { ErrorFilter } from "./errors/error.filter.js";
import { FilesService } from "./files/files.service.js";
import { AuthGuard } from "./guards/auth.guard.js";
import { SessionValidator } from "./guards/session-validator.js";
import { RequestGate } from "./http/request-gate.js";
import { IdempotencyService } from "./idempotency/idempotency.service.js";
import { IdempotencyInterceptor } from "./idempotency/idempotent.js";
import { JobRegistry } from "./jobs/job-registry.js";
import { JobRunner } from "./jobs/job-runner.js";
import { AppLogger } from "./logging/logger.js";
import { safeError } from "./logging/safe-error.js";
import { MembershipKernel } from "./membership/membership.kernel.js";
import { NotificationService } from "./notifications-kernel/notification.service.js";
import { OutboxService } from "./outbox/outbox.service.js";
import {
  MembershipPaymentHandlers,
  PaymentHandlerRegistry,
} from "./payments-kernel/payment-handler.registry.js";
import { BlockPolicy } from "./policy/block.policy.js";
import { QrTokenService } from "./qr/qr-token.service.js";
import { RateLimitService } from "./rate-limit/rate-limit.service.js";
import { RedisRateLimitStore } from "./rate-limit/redis-store.js";
import { MemoryRateLimitStore, type RateLimitStore } from "./rate-limit/store.js";
import { RealtimeGateway } from "./realtime/realtime.gateway.js";
import { RealtimeService } from "./realtime/realtime.service.js";
import { RedisEmitterTransport } from "./realtime/transports.js";
import { SettingsService } from "./settings/settings.service.js";
import {
  CLOCK,
  DB,
  ENV,
  MAILER,
  PUSH,
  RATE_LIMIT_STORE,
  REDIS,
  ROOT_LOGGER,
  RUNTIME_MODE,
  STORAGE,
} from "./tokens.js";

/** Adapter eksternal yang dipasang ke CoreModule (bagian bersama AppDeps dan WorkerDeps). */
export interface CoreDeps<Env extends BaseEnv = BaseEnv> {
  env: Env;
  db: Db;
  mailer: Mailer;
  clock: Clock;
  push: PushSender;
  /**
   * Driver berkas (PRD 5.4): main.ts/worker memasang createStorageDriver(env), uji memakai MemoryDriver. null hanya untuk
   * konteks tanpa berkas (FilesService melempar bila dipakai; readiness melaporkan storage "skipped").
   */
  storage?: StorageDriver | null;
  /** Redis bila REDIS_URL diisi; null = implementasi memori (development/test). */
  redis?: RedisClient | null;
}

export interface CoreRuntime {
  mode: "api" | "worker";
  logger: Logger;
  /** Uji dapat memasang store sendiri (mis. untuk reset per tes); bawaan memori atau Redis. */
  rateLimitStore?: RateLimitStore;
}

/** Layanan inti yang tersedia di API dan worker (ARCHITECTURE §4.2). */
const SHARED_SERVICES = [
  TxRunner,
  AppLogger,
  AuditService,
  OutboxService,
  SettingsService,
  RateLimitService,
  IdempotencyService,
  IdempotencyInterceptor,
  JobRegistry,
  JobRunner,
  RealtimeService,
  NotificationService,
  MembershipKernel,
  PaymentHandlerRegistry,
  MembershipPaymentHandlers,
  FilesService,
  BlockPolicy,
];

/**
 * Khusus runtime HTTP: verifikasi token dan sesi, guard, gerbang maintenance/versi, filter galat, token QR KTA
 * (secret QR tidak diberikan ke worker), dan gateway Socket.IO /realtime.
 */
const API_SERVICES = [
  TokenService,
  SessionValidator,
  AuthGuard,
  RequestGate,
  ErrorFilter,
  QrTokenService,
  RealtimeGateway,
];

/**
 * CoreModule global (ARCHITECTURE §4.1, §4.2): token adapter (DB, ENV, CLOCK, MAILER, STORAGE, PUSH, REDIS),
 * logger, transaksi, audit, outbox, settings, rate limit, idempotensi, job; untuk API juga AuthGuard global
 * (APP_GUARD, tolak bawaan) dan ErrorFilter global. Modul domain tidak perlu mengimpor modul ini.
 */
@Module({})
export class CoreModule implements OnModuleInit {
  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    @Inject(RUNTIME_MODE) private readonly mode: "api" | "worker",
    @Inject(REDIS) private readonly redis: RedisClient | null,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    setAfterCommitErrorReporter((error) => {
      const context = tryCtx();
      this.logger.error(
        { ...(context ? { request_id: context.requestId } : {}), error: safeError(error) },
        "efek setelah commit gagal (data tetap tersimpan)",
      );
    });
    // Worker tidak memiliki gateway: event realtime dari job dikirim lewat emitter Redis ke adapter gateway API.
    // Tanpa Redis (development/test) event worker tidak dikirim; klien memuat ulang lewat HTTP (PRD 5.2).
    if (this.mode === "worker" && this.redis)
      this.realtime.useTransport(new RedisEmitterTransport(this.redis));
  }

  static forRoot(deps: CoreDeps, runtime: CoreRuntime): DynamicModule {
    const rateLimitStore =
      runtime.rateLimitStore ??
      (deps.redis ? new RedisRateLimitStore(deps.redis) : new MemoryRateLimitStore());
    const values: Provider[] = [
      { provide: ENV, useValue: deps.env },
      { provide: DB, useValue: deps.db },
      { provide: CLOCK, useValue: deps.clock },
      { provide: MAILER, useValue: deps.mailer },
      { provide: PUSH, useValue: deps.push },
      { provide: STORAGE, useValue: deps.storage ?? null },
      { provide: REDIS, useValue: deps.redis ?? null },
      { provide: ROOT_LOGGER, useValue: runtime.logger },
      { provide: RATE_LIMIT_STORE, useValue: rateLimitStore },
      { provide: RUNTIME_MODE, useValue: runtime.mode },
    ];
    const api = runtime.mode === "api";
    const services = api ? [...SHARED_SERVICES, ...API_SERVICES] : SHARED_SERVICES;
    return {
      module: CoreModule,
      global: true,
      providers: [
        ...values,
        ...services,
        ...(api
          ? [
              { provide: APP_GUARD, useExisting: AuthGuard },
              { provide: APP_FILTER, useExisting: ErrorFilter },
            ]
          : []),
      ],
      exports: [...values.map((p) => (p as { provide: symbol }).provide), ...services],
    };
  }
}
