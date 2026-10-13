import { type DynamicModule, Module, type Type } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { Logger } from "pino";
import { type CoreDeps, CoreModule } from "./core/core.module.js";
import type { RateLimitStore } from "./core/rate-limit/store.js";
import { AccountJobsModule } from "./modules/account/account-jobs.module.js";
import { AccountModule } from "./modules/account/account.module.js";
import { AdminJobsModule } from "./modules/admin/admin-jobs.module.js";
import { AdminModule } from "./modules/admin/admin.module.js";
import { AdminAuthModule } from "./modules/admin-auth/admin-auth.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { ChatModule } from "./modules/chat/chat.module.js";
import { ContentJobsModule } from "./modules/content/content-jobs.module.js";
import { ContentModule } from "./modules/content/content.module.js";
import { EventsJobsModule } from "./modules/events/events-jobs.module.js";
import { EventsModule } from "./modules/events/events.module.js";
import { FilesJobsModule } from "./modules/files/files-jobs.module.js";
import { FilesModule } from "./modules/files/files.module.js";
import { MembershipJobsModule } from "./modules/membership/membership-jobs.module.js";
import { MembershipModule } from "./modules/membership/membership.module.js";
import { ModerationModule } from "./modules/moderation/moderation.module.js";
import { NetworkModule } from "./modules/network/network.module.js";
import { NotificationsJobsModule } from "./modules/notifications/notifications-jobs.module.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { PaymentsJobsModule } from "./modules/payments/payments-jobs.module.js";
import { PaymentsModule } from "./modules/payments/payments.module.js";
import { PublicModule } from "./modules/public/public.module.js";

/**
 * Dependensi eksternal API (ARCHITECTURE §4.2): env, database, email, jam, push, storage, Redis opsional. createApp
 * dipakai main.ts dan harness uji, sehingga uji memasang tiruan tanpa mock.
 */
export type AppDeps = CoreDeps<ApiEnv>;

/** Semua modul domain ARCHITECTURE §4.1; sudah terdaftar sehingga agen modul tidak perlu menyunting berkas ini. */
export const DOMAIN_MODULES: Type[] = [
  AuthModule,
  AdminAuthModule,
  MembershipModule,
  PaymentsModule,
  FilesModule,
  ContentModule,
  EventsModule,
  NetworkModule,
  ChatModule,
  ModerationModule,
  NotificationsModule,
  AccountModule,
  AdminModule,
  PublicModule,
];

/**
 * Modul yang dimuat worker (pemilik job ARCHITECTURE §4.8): HANYA bagian job tiap modul (`modules/<m>/<m>-jobs.module.ts`,
 * tanpa controller), bukan modul domain utuh, sehingga controller/layanan HTTP modul (yang boleh memakai TokenService,
 * QrTokenService, dst.) tidak pernah dibuat di worker. Provider di modul ini tidak boleh bergantung pada layanan khusus
 * API (core.module.ts API_ONLY_PROVIDERS): worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege).
 * Modul domain mengimpor modul job-nya sendiri, sehingga daftar ini tidak perlu disunting agen modul.
 */
export const WORKER_MODULES: Type[] = [
  MembershipJobsModule,
  PaymentsJobsModule,
  FilesJobsModule,
  ContentJobsModule,
  EventsJobsModule,
  NotificationsJobsModule,
  AccountJobsModule,
  AdminJobsModule,
];

export interface AppRuntime {
  logger: Logger;
  rateLimitStore?: RateLimitStore;
  /** Modul tambahan (hanya uji, mis. controller penguji guard). */
  extraModules?: (Type | DynamicModule)[];
}

@Module({})
export class AppModule {
  static forRoot(deps: AppDeps, runtime: AppRuntime): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(deps, {
          mode: "api",
          logger: runtime.logger,
          rateLimitStore: runtime.rateLimitStore,
        }),
        ...DOMAIN_MODULES,
        ...(runtime.extraModules ?? []),
      ],
    };
  }
}
