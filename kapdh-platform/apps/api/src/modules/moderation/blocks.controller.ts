import { Controller, Delete, Get, HttpCode, Param, Put, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { BlocksService } from "./blocks.service.js";

type BlockedMember = components["schemas"]["BlockedMember"];
type BlockedMemberPage = components["schemas"]["BlockedMemberPage"];

/**
 * Blokir anggota (F-12, AC F12-1; kontrak moderation.yaml listBlocks/blockMember/unblockMember): hanya anggota aktif
 * (verified/expiring, tidak suspended), sama dengan akses komunitas lain (ARCHITECTURE §3.1).
 */
@Controller("blocks")
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Get()
  @Audience("mobile")
  @MemberAccess("active")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<BlockedMemberPage> {
    return this.blocks.list(auth, query);
  }

  @Put(":userId")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  block(
    @CurrentAuth() auth: AuthContext,
    @Param("userId", UuidParamOrValidationError) userId: string,
  ): Promise<BlockedMember> {
    return this.blocks.block(auth, userId);
  }

  @Delete(":userId")
  @HttpCode(204)
  @Audience("mobile")
  @MemberAccess("active")
  async unblock(
    @CurrentAuth() auth: AuthContext,
    @Param("userId", UuidParamOrValidationError) userId: string,
  ): Promise<void> {
    await this.blocks.unblock(auth, userId);
  }
}
