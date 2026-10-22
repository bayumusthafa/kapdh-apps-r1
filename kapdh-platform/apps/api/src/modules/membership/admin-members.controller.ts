import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { z } from "zod";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import {
  Audience,
  CurrentAuth,
  RequirePermission,
  RequireReauth,
  RequireRole,
} from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { UuidParam } from "../../core/validation/uuid-param.pipe.js";
import { validate } from "../../core/validation/validate.js";
import { AdminMembersService } from "./admin-members.service.js";
import { MemberPasswordResetService } from "./member-password-reset.service.js";
import {
  ADMIN_MEMBER_UPDATE_KEYS,
  adminMemberUpdateSchema,
  assertHasChange,
  assertKnownFields,
  assertNoLegacyMix,
} from "./profile-input.js";

type AdminMemberPage = components["schemas"]["AdminMemberPage"];
type AdminMemberDetail = components["schemas"]["AdminMemberDetail"];
type AdminMembershipEventPage = components["schemas"]["AdminMembershipEventPage"];
type AdminMemberPasswordResetResult = components["schemas"]["AdminMemberPasswordResetResult"];

/** Alasan wajib yang tidak boleh hanya spasi (AC F04-2 pola yang sama). */
const reason = (max: number) =>
  z
    .string()
    .trim()
    .min(3, "Alasan minimal 3 karakter dan tidak boleh hanya spasi")
    .max(max, `Maksimal ${max} karakter`);
/** Konfirmasi eksplisit dari dialog (PRD 4.5). */
const confirm = z.literal(true, { message: "Konfirmasi tindakan wajib dicentang" });

const suspendSchema = z
  .object({
    reason: reason(1000),
    member_message: z
      .string()
      .trim()
      .min(3, "Pesan untuk anggota minimal 3 karakter")
      .max(500, "Maksimal 500 karakter"),
    confirm,
  })
  .strict();

const unsuspendSchema = z
  .object({
    reason: reason(1000),
    member_message: z
      .string()
      .trim()
      .min(3, "Pesan untuk anggota minimal 3 karakter")
      .max(500, "Maksimal 500 karakter")
      .optional(),
    confirm,
  })
  .strict();

const passwordResetSchema = z.object({ reason: reason(500), confirm }).strict();

/**
 * Anggota untuk pengurus (kontrak admin-members.yaml; F-15, F-16; PRD 2.3, 3.5, 4.2). Semua rute: sesi admin
 * ber-TOTP (AC F02-2), izin dievaluasi dari DB setiap request (AC F15-1, F16-3).
 */
@Controller("admin/members")
export class AdminMembersController {
  constructor(
    private readonly members: AdminMembersService,
    private readonly passwordResets: MemberPasswordResetService,
  ) {}

  /** Daftar anggota dengan pencarian, filter, urutan, paging dan total dari server (F-15, AC F10-1). */
  @Get()
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("members.read")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<AdminMemberPage> {
    return this.members.list(auth, query);
  }

  /** Detail administratif tersaring per izin; pembukaan dicatat audit `member.viewed` (F-10, F-15). */
  @Get(":userId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("members.read")
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param("userId", UuidParam) userId: string,
  ): Promise<AdminMemberDetail> {
    return this.members.view(auth, userId);
  }

  /** Koreksi data administratif dan identitas; nomor dihitung ulang dengan N tetap (AC F05-6, F15-4, F17-1). */
  @Patch(":userId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("members.read", "members.manage")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("userId", UuidParam) userId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminMemberDetail> {
    const expectedVersion = parseIfMatch(ifMatch);
    // AC F05-6: member_number, email, privasi dan field lain di luar skema ditolak sebelum apa pun berubah.
    const known = assertKnownFields(body, ADMIN_MEMBER_UPDATE_KEYS, { identityEditable: true });
    const input = validate(adminMemberUpdateSchema, known);
    assertHasChange(input, ["reason"]);
    assertNoLegacyMix(input);
    return this.members.update(auth, userId, expectedVersion, input);
  }

  /** Suspend dari halaman anggota; izin sama dengan jalur moderasi (PRD 2.3, 4.2; AC F12-3, F12-4). */
  @Post(":userId/suspend")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("members.read", "moderation.read", "moderation.resolve")
  @Idempotent()
  suspend(
    @CurrentAuth() auth: AuthContext,
    @Param("userId", UuidParam) userId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminMemberDetail> {
    const expectedVersion = parseIfMatch(ifMatch);
    const input = validate(suspendSchema, body);
    return this.members.suspend(auth, userId, expectedVersion, input);
  }

  /** Cabut pembatasan; status dihitung ulang dari expires_at, banding aktif ditutup dikabulkan (AC F12-3, F12-5). */
  @Post(":userId/unsuspend")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("members.read", "moderation.read", "moderation.resolve")
  @Idempotent()
  unsuspend(
    @CurrentAuth() auth: AuthContext,
    @Param("userId", UuidParam) userId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminMemberDetail> {
    const expectedVersion = parseIfMatch(ifMatch);
    const input = validate(unsuspendSchema, body);
    return this.members.unsuspend(auth, userId, expectedVersion, input);
  }

  /** Super Admin menginisiasi pemulihan sandi alumni tanpa melihat sandi (F-16, AC F16-4). */
  @Post(":userId/password-reset")
  @HttpCode(202)
  @Audience("admin")
  @RequireRole("super_admin")
  @RequireReauth()
  @Idempotent()
  passwordReset(
    @CurrentAuth() auth: AuthContext,
    @Param("userId", UuidParam) userId: string,
    @Body() body: unknown,
  ): Promise<AdminMemberPasswordResetResult> {
    const input = validate(passwordResetSchema, body);
    return this.passwordResets.initiate(auth, userId, input);
  }

  /** Histori keanggotaan dan moderasi, tersaring per izin moderasi (PRD 4.2, 6.3, AC F15-1). */
  @Get(":userId/membership-events")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("members.read")
  membershipEvents(
    @CurrentAuth() auth: AuthContext,
    @Param("userId", UuidParam) userId: string,
    @Query() query: unknown,
  ): Promise<AdminMembershipEventPage> {
    return this.members.membershipEvents(auth, userId, query);
  }
}
