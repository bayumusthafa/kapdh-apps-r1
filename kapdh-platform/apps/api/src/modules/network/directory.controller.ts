import { Controller, Get, HttpCode, Param, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { DirectoryService } from "./directory.service.js";

type DirectoryPage = components["schemas"]["DirectoryPage"];
type NetworkMemberProfile = components["schemas"]["NetworkMemberProfile"];

/**
 * Jejaring alumni (F-10, PRD 3.10; kontrak network.yaml). Hanya anggota aktif (verified/expiring, tidak suspended):
 * unverified/expired → 403 MEMBERSHIP_REQUIRED, suspended → 403 ACCOUNT_SUSPENDED, tanpa sesi → 401, sesi admin →
 * 403 (AC F10-3). Controller ini hanya-baca: tidak ada rute yang mengubah profil siapa pun (AC F10-5).
 */
@Controller("directory")
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  /** searchDirectory: cari/filter direktori anggota aktif dengan paging keyset dan total (AC F10-1, F10-2). */
  @Get()
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  search(@Query() query: unknown, @CurrentAuth() auth: AuthContext): Promise<DirectoryPage> {
    return this.directory.search(auth, query);
  }

  /** getMemberProfile: profil anggota lain sesuai flag privasi pemiliknya (AC F10-2, F10-4). */
  @Get(":userId")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  profile(
    @Param("userId", UuidParamOrValidationError) userId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<NetworkMemberProfile> {
    return this.directory.profile(auth, userId);
  }
}
