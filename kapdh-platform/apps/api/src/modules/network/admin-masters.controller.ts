import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { Audience, RequireAnyPermission, RequirePermission } from "../../core/guards/decorators.js";
import { UuidParam } from "../../core/validation/uuid-param.pipe.js";
import { MastersService, parseMasterKind } from "./masters.service.js";

type AdminMasterItem = components["schemas"]["AdminMasterItem"];
type AdminMasterPage = components["schemas"]["AdminMasterPage"];

/**
 * Manajemen master profesi dan keahlian (F-15, guideline hal. 16; kontrak admin-masters.yaml). Izin dievaluasi dari
 * database setiap request (AC F15-1): daftar cukup members.read ATAU master.manage (filter daftar anggota dan halaman
 * master), perubahan wajib master.manage. Versi lama → 409 VERSION_CONFLICT (AC F15-4).
 */
@Controller("admin/masters")
export class AdminMastersController {
  constructor(private readonly masters: MastersService) {}

  /** adminListMasters. */
  @Get(":kind")
  @HttpCode(200)
  @Audience("admin")
  @RequireAnyPermission("members.read", "master.manage")
  list(@Param("kind") kind: string, @Query() query: unknown): Promise<AdminMasterPage> {
    return this.masters.list(parseMasterKind(kind), query);
  }

  /** adminCreateMaster. */
  @Post(":kind")
  @HttpCode(201)
  @Audience("admin")
  @RequirePermission("master.manage")
  create(@Param("kind") kind: string, @Body() body: unknown): Promise<AdminMasterItem> {
    return this.masters.create(parseMasterKind(kind), body);
  }

  /** adminGetMaster. */
  @Get(":kind/:masterId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("master.manage")
  get(@Param("kind") kind: string, @Param("masterId", UuidParam) masterId: string): Promise<AdminMasterItem> {
    return this.masters.get(parseMasterKind(kind), masterId);
  }

  /** adminUpdateMaster (If-Match). */
  @Patch(":kind/:masterId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("master.manage")
  update(
    @Param("kind") kind: string,
    @Param("masterId", UuidParam) masterId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminMasterItem> {
    return this.masters.update(parseMasterKind(kind), masterId, ifMatch, body);
  }

  /** adminDeleteMaster (If-Match); master terpakai ditolak dan disarankan dinonaktifkan (AC F10-4). */
  @Delete(":kind/:masterId")
  @HttpCode(204)
  @Audience("admin")
  @RequirePermission("master.manage")
  async remove(
    @Param("kind") kind: string,
    @Param("masterId", UuidParam) masterId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<void> {
    await this.masters.remove(parseMasterKind(kind), masterId, ifMatch);
  }
}
