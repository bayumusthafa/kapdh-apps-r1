import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, RequirePermission, RequireReauth } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { AdminsService } from "./admins.service.js";
import { permissionCatalog } from "./permissions-catalog.js";

type Schemas = components["schemas"];

/**
 * Domain admin-admins (kontrak C7, F-16, AC F16-1..F16-3): admins.manage hanya melekat pada Super Admin; setiap
 * perubahan wajib X-Reauth-Token (sesi TOTP, AC F16-1) dan If-Match pada objek yang sudah ada (AC F15-4).
 */
@Controller("admin/admins")
@Audience("admin")
export class AdminsController {
  constructor(private readonly admins: AdminsService) {}

  /** adminListAdmins: { audience: admin, permissions: [admins.manage] } */
  @Get()
  @HttpCode(200)
  @RequirePermission("admins.manage")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<Schemas["AdminAccountPage"]> {
    return this.admins.list(auth, query);
  }

  /** adminInviteAdmin: { audience: admin, permissions: [admins.manage], reauth: true, idempotent: true } */
  @Post()
  @HttpCode(201)
  @RequirePermission("admins.manage")
  @RequireReauth()
  @Idempotent()
  invite(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<Schemas["AdminInvitationResult"]> {
    return this.admins.invite(auth, body);
  }

  /** adminListAdminCandidates: { audience: admin, permissions: [admins.manage] } */
  @Get("candidates")
  @HttpCode(200)
  @RequirePermission("admins.manage")
  candidates(
    @CurrentAuth() auth: AuthContext,
    @Query() query: unknown,
  ): Promise<Schemas["AdminCandidatePage"]> {
    return this.admins.candidates(auth, query);
  }

  /** adminGetAdmin: { audience: admin, permissions: [admins.manage] } */
  @Get(":adminId")
  @HttpCode(200)
  @RequirePermission("admins.manage")
  get(
    @CurrentAuth() auth: AuthContext,
    @Param("adminId", UuidParamOrValidationError) adminId: string,
  ): Promise<Schemas["AdminAccountDetail"]> {
    return this.admins.get(auth, adminId);
  }

  /** adminUpdateAdmin: { audience: admin, permissions: [admins.manage], reauth: true } */
  @Patch(":adminId")
  @HttpCode(200)
  @RequirePermission("admins.manage")
  @RequireReauth()
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("adminId", UuidParamOrValidationError) adminId: string,
    @Body() body: unknown,
    @Headers("if-match") ifMatch?: string,
  ): Promise<Schemas["AdminAccountDetail"]> {
    return this.admins.update(auth, adminId, body, parseIfMatch(ifMatch));
  }

  /** adminDeleteAdmin: { audience: admin, permissions: [admins.manage], reauth: true } */
  @Delete(":adminId")
  @HttpCode(204)
  @RequirePermission("admins.manage")
  @RequireReauth()
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param("adminId", UuidParamOrValidationError) adminId: string,
    @Headers("if-match") ifMatch?: string,
  ): Promise<void> {
    await this.admins.remove(auth, adminId, parseIfMatch(ifMatch));
  }

  /** adminResendAdminInvitation: { audience: admin, permissions: [admins.manage], reauth: true, idempotent: true } */
  @Post(":adminId/invitation")
  @HttpCode(200)
  @RequirePermission("admins.manage")
  @RequireReauth()
  @Idempotent()
  resend(
    @CurrentAuth() auth: AuthContext,
    @Param("adminId", UuidParamOrValidationError) adminId: string,
    @Headers("if-match") ifMatch?: string,
  ): Promise<Schemas["AdminInvitationResult"]> {
    return this.admins.resendInvitation(auth, adminId, parseIfMatch(ifMatch));
  }

  /** adminRecoverAdmin: { audience: admin, permissions: [admins.manage], reauth: true, idempotent: true } */
  @Post(":adminId/recovery")
  @HttpCode(200)
  @RequirePermission("admins.manage")
  @RequireReauth()
  @Idempotent()
  recover(
    @CurrentAuth() auth: AuthContext,
    @Param("adminId", UuidParamOrValidationError) adminId: string,
    @Body() body: unknown,
    @Headers("if-match") ifMatch?: string,
  ): Promise<Schemas["AdminRecoveryResult"]> {
    return this.admins.recover(auth, adminId, body, parseIfMatch(ifMatch));
  }
}

/** adminListPermissions (kontrak C7): katalog izin dan peran untuk semua admin ber-MFA. */
@Controller("admin/permissions")
export class PermissionsController {
  /** adminListPermissions: { audience: admin } */
  @Get()
  @HttpCode(200)
  @Audience("admin")
  catalog(): Schemas["AdminPermissionCatalog"] {
    return permissionCatalog();
  }
}
