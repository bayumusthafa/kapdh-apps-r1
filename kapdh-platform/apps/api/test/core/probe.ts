/**
 * Controller penguji platform (hanya uji core): memasang rute dengan kombinasi dekorator akses, idempotensi, pipe,
 * dan pemicu galat database. Tidak pernah didaftarkan di aplikasi produksi maupun aplikasi uji kontrak.
 */
import { Body, Controller, Get, HttpCode, Inject, Module, Param, Post, Query } from "@nestjs/common";
import { users } from "@kapdh/database";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { ctx } from "../../src/core/context/request-context.js";
import type { Db } from "../../src/core/db/types.js";
import { AppException } from "../../src/core/errors/app-exception.js";
import type { AuthContext } from "../../src/core/guards/auth-context.js";
import {
  Audience,
  CurrentAuth,
  MemberAccess,
  Public,
  RequirePermission,
  RequireReauth,
} from "../../src/core/guards/decorators.js";
import { Idempotent } from "../../src/core/idempotency/idempotent.js";
import { AppLogger } from "../../src/core/logging/logger.js";
import { parsePageQuery } from "../../src/core/pagination/cursor.js";
import { DB } from "../../src/core/tokens.js";
import { UuidParam } from "../../src/core/validation/uuid-param.pipe.js";
import { validate } from "../../src/core/validation/validate.js";

/** Rahasia sintetis yang TIDAK boleh muncul di log (dipakai sebagai parameter kueri yang gagal). */
export const SECRET_MARKER = "RAHASIA-JANGAN-DICATAT-7f3a";

export const probeState = { idempotentCalls: 0, failNext: false, delayMs: 0 };

const summary = (auth: AuthContext) => ({
  user_id: auth.userId,
  audience: auth.audience,
  admin_id: auth.adminId,
  admin_role: auth.adminRole,
  permissions: [...auth.permissions].sort(),
  linked_alumni_user_id: auth.linkedAlumniUserId,
  effective_status: auth.effectiveStatus,
  reauthenticated: auth.reauthenticated,
});

@Controller("__probe")
class ProbeController {
  private readonly log;

  constructor(
    @Inject(DB) private readonly db: Db,
    logs: AppLogger,
  ) {
    this.log = logs.for("ProbeController");
  }

  @Get("public")
  @Public()
  publicRoute() {
    const context = ctx();
    return {
      request_id: context.requestId,
      client_request_id: context.clientRequestId,
      ip: context.ip,
      app_platform: context.appPlatform,
      app_version: context.appVersion,
      actor: context.actor.kind,
    };
  }

  /** Lupa dekorator akses: guard global wajib menolak (default deny). */
  @Get("undeclared")
  undeclared() {
    return { leaked: true };
  }

  /** Deklarasi salah: @MemberAccess pada audience admin → ditolak dan dilaporkan. */
  @Get("misdeclared")
  @Audience("admin")
  @MemberAccess("active")
  misdeclared() {
    return { leaked: true };
  }

  @Get("any")
  @Audience("any")
  anyAudience(@CurrentAuth() auth: AuthContext) {
    return { ...summary(auth), actor: ctx().actor.kind };
  }

  @Get("member/any")
  @Audience("mobile")
  @MemberAccess("any")
  memberAny(@CurrentAuth() auth: AuthContext) {
    return summary(auth);
  }

  @Get("member/nonsuspended")
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  memberNonSuspended(@CurrentAuth() auth: AuthContext) {
    return summary(auth);
  }

  @Get("member/active")
  @Audience("mobile")
  @MemberAccess("active")
  memberActive(@CurrentAuth() auth: AuthContext) {
    return summary(auth);
  }

  @Get("admin/payments")
  @Audience("admin")
  @RequirePermission("payments.read")
  adminPayments(@CurrentAuth() auth: AuthContext) {
    return summary(auth);
  }

  @Get("admin/decide")
  @Audience("admin")
  @RequirePermission("payments.read", "payments.decide")
  adminDecide(@CurrentAuth() auth: AuthContext) {
    return summary(auth);
  }

  @Post("sensitive")
  @HttpCode(200)
  @Audience("any")
  @RequireReauth()
  sensitive(@CurrentAuth() auth: AuthContext) {
    return summary(auth);
  }

  @Get("item/:id")
  @Public()
  item(@Param("id", UuidParam) id: string) {
    return { id };
  }

  @Get("page")
  @Public()
  page(@Query() query: unknown) {
    return parsePageQuery(query);
  }

  @Post("echo")
  @HttpCode(200)
  @Public()
  echo(@Body() body: unknown) {
    return validate(
      z.object({ name: z.string().min(2), nested: z.object({ n: z.number() }).optional() }),
      body,
    );
  }

  @Post("idem")
  @HttpCode(201)
  @Audience("mobile")
  @Idempotent()
  async idempotent(@Body() body: unknown, @CurrentAuth() auth: AuthContext) {
    probeState.idempotentCalls++;
    if (probeState.delayMs) await new Promise((r) => setTimeout(r, probeState.delayMs));
    if (probeState.failNext) {
      probeState.failNext = false;
      throw new AppException(422, "VALIDATION_ERROR", "Gagal sementara (uji).");
    }
    return { call: probeState.idempotentCalls, user_id: auth.userId, body };
  }

  @Post("idem-public")
  @HttpCode(201)
  @Public()
  @Idempotent()
  idempotentPublic(@Body() body: unknown) {
    probeState.idempotentCalls++;
    return { call: probeState.idempotentCalls, body };
  }

  /** Kesalahan konfigurasi yang dijaga: respons berisi token tidak boleh tersimpan di idempotency_keys. */
  @Post("idem-secret")
  @HttpCode(200)
  @Public()
  @Idempotent()
  idempotentSecret() {
    probeState.idempotentCalls++;
    return { session: { access_token: SECRET_MARKER, refresh_token: SECRET_MARKER } };
  }

  /** Memicu unique violation dengan parameter rahasia: log hanya boleh memuat tipe, SQLSTATE, constraint. */
  @Post("db-error")
  @HttpCode(200)
  @Public()
  async dbError() {
    const email = `${SECRET_MARKER.toLowerCase()}@contoh.test`;
    const row = { email, passwordHash: `$2b$04$${SECRET_MARKER}`, status: "active" as const, kind: "alumni" };
    await this.db.insert(users).values({ id: uuidv7(), ...row });
    await this.db.insert(users).values({ id: uuidv7(), ...row });
    return { unreachable: true };
  }

  /** Mencatat objek berisi kunci rahasia lewat AppLogger: harus tersensor. */
  @Post("log-secret")
  @HttpCode(204)
  @Public()
  logSecret() {
    this.log.info("uji redaksi", {
      password: SECRET_MARKER,
      body: { refresh_token: SECRET_MARKER, nested: { totp_code: SECRET_MARKER, ok: "boleh" } },
      headers: { authorization: `Bearer ${SECRET_MARKER}`, "set-cookie": SECRET_MARKER },
    });
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
