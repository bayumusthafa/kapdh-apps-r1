import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { ServerEnv } from "@kapdh/config";
import { AdminAuthController } from "./admin/admin-auth.controller.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { TokenService } from "./auth/token.service.js";
import { ErrorFilter } from "./common/error.filter.js";
import { HealthController } from "./health/health.controller.js";
import { CLOCK, type Clock } from "./infra/clock.js";
import type { Db } from "./infra/db.js";
import type { Mailer } from "./infra/mailer.js";
import { RateLimiter } from "./infra/rate-limiter.js";
import { DB, ENV, MAILER } from "./infra/tokens.js";
import { MeController } from "./me/me.controller.js";
import { PublicController } from "./public/public.controller.js";
import { PUBLIC_CONFIG } from "./public/public.tokens.js";

export interface AppDeps {
  env: ServerEnv;
  db: Db;
  mailer: Mailer;
  clock: Clock;
}

@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, PublicController, AuthController, AdminAuthController, MeController],
      providers: [
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: ENV, useValue: deps.env },
        { provide: DB, useValue: deps.db },
        { provide: MAILER, useValue: deps.mailer },
        { provide: CLOCK, useValue: deps.clock },
        { provide: RateLimiter, useValue: new RateLimiter() },
        TokenService,
        AuthService,
        AuthGuard,
        {
          // Sumber sementara dari environment; dipindah ke app_settings terversi pada irisan Admin Settings.
          provide: PUBLIC_CONFIG,
          useFactory: () => ({
            min_app_version: {
              android: process.env.MIN_APP_VERSION_ANDROID ?? "1.0.0",
              ios: process.env.MIN_APP_VERSION_IOS ?? "1.0.0",
            },
            maintenance: { active: process.env.MAINTENANCE === "true", message: null, until: null },
            support: { email: "bantuan@kapdh.or.id", whatsapp: null },
          }),
        },
      ],
    };
  }
}
