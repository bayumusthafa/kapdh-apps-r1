import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, RequirePermission } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { AuditExportService } from "./audit-export.service.js";
import { AuditSearchService } from "./audit.service.js";

type Schemas = components["schemas"];

/**
 * Domain admin-audit (kontrak C7, F-17): pencarian butuh audit.read; ekspor butuh audit.read + audit.export,
 * dievaluasi dari database setiap request walaupun URL/id diketahui (AC F17-2).
 */
@Controller("admin/audit")
@Audience("admin")
export class AuditController {
  constructor(
    private readonly search: AuditSearchService,
    private readonly exports: AuditExportService,
  ) {}

  /** adminSearchAudit: { audience: admin, permissions: [audit.read] } */
  @Get("entries")
  @HttpCode(200)
  @RequirePermission("audit.read")
  entries(@Query() query: unknown): Promise<Schemas["AuditEntryPage"]> {
    return this.search.search(query);
  }

  /** adminGetAuditEntry: { audience: admin, permissions: [audit.read] } */
  @Get("entries/:entryId")
  @HttpCode(200)
  @RequirePermission("audit.read")
  entry(@Param("entryId", UuidParamOrValidationError) entryId: string): Promise<Schemas["AuditEntryDetail"]> {
    return this.search.entry(entryId);
  }

  /** adminCreateAuditExport: { audience: admin, permissions: [audit.read, audit.export], idempotent: true } */
  @Post("exports")
  @HttpCode(202)
  @RequirePermission("audit.read", "audit.export")
  @Idempotent()
  createExport(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<Schemas["AuditExport"]> {
    return this.exports.create(auth, body);
  }

  /** adminListAuditExports: { audience: admin, permissions: [audit.read, audit.export] } */
  @Get("exports")
  @HttpCode(200)
  @RequirePermission("audit.read", "audit.export")
  listExports(
    @CurrentAuth() auth: AuthContext,
    @Query() query: unknown,
  ): Promise<Schemas["AuditExportPage"]> {
    return this.exports.list(auth, query);
  }

  /** adminGetAuditExport: { audience: admin, permissions: [audit.read, audit.export] } */
  @Get("exports/:exportId")
  @HttpCode(200)
  @RequirePermission("audit.read", "audit.export")
  getExport(
    @CurrentAuth() auth: AuthContext,
    @Param("exportId", UuidParamOrValidationError) exportId: string,
  ): Promise<Schemas["AuditExport"]> {
    return this.exports.get(auth, exportId);
  }

  /** adminGetAuditExportAccess: { audience: admin, permissions: [audit.read, audit.export] } */
  @Get("exports/:exportId/access")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequirePermission("audit.read", "audit.export")
  exportAccess(
    @CurrentAuth() auth: AuthContext,
    @Param("exportId", UuidParamOrValidationError) exportId: string,
  ): Promise<Schemas["AuditExportAccess"]> {
    return this.exports.access(auth, exportId);
  }
}
