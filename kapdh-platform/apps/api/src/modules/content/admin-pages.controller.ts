import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, RequirePermission } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { parsePageQuery } from "../../core/pagination/cursor.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { validate, validateQuery } from "../../core/validation/validate.js";
import {
  pageCreateSchema,
  pageListQuerySchema,
  pagePublishSchema,
  pageUpdateSchema,
} from "./admin-content.schemas.js";
import { PagesService } from "./pages.service.js";

type AdminInfoPage = components["schemas"]["AdminInfoPage"];
type AdminInfoPageList = components["schemas"]["AdminInfoPageList"];

/**
 * Halaman informasi dan legal berversi untuk pengurus berizin content.manage (F-08, F-01, PRD 6.2): draf terpisah
 * dari salinan tayang; terbit menaikkan versi legal dan mencatat teks tayang di audit. Perubahan memakai If-Match
 * (AC F15-4); tanpa izin 403 (AC F15-1).
 */
@Controller("admin/content/pages")
@Audience("admin")
@RequirePermission("content.manage")
export class AdminPagesController {
  constructor(private readonly pagesService: PagesService) {}

  @Get()
  list(@Query() query: unknown): Promise<AdminInfoPageList> {
    const page = parsePageQuery(query);
    const filters = validateQuery(pageListQuerySchema, query);
    return this.pagesService.list({ q: filters.q, sort: filters.sort, cursor: page.cursor, limit: page.limit });
  }

  @Post()
  @HttpCode(201)
  @Idempotent()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<AdminInfoPage> {
    return this.pagesService.create(auth, validate(pageCreateSchema, body));
  }

  @Get(":pageId")
  get(@Param("pageId", UuidParamOrValidationError) pageId: string): Promise<AdminInfoPage> {
    return this.pagesService.get(pageId);
  }

  @Patch(":pageId")
  @HttpCode(200)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("pageId", UuidParamOrValidationError) pageId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminInfoPage> {
    const version = parseIfMatch(ifMatch);
    return this.pagesService.update(auth, pageId, version, validate(pageUpdateSchema, body));
  }

  @Delete(":pageId")
  @HttpCode(204)
  async remove(
    @Param("pageId", UuidParamOrValidationError) pageId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<void> {
    await this.pagesService.remove(pageId, parseIfMatch(ifMatch));
  }

  /** Terbitkan draf sebagai versi tayang baru; dokumen legal menaikkan app_settings.legal (F-01). */
  @Post(":pageId/publish")
  @HttpCode(200)
  @Idempotent()
  publish(
    @CurrentAuth() auth: AuthContext,
    @Param("pageId", UuidParamOrValidationError) pageId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminInfoPage> {
    const version = parseIfMatch(ifMatch);
    const input = validate(pagePublishSchema, body);
    return this.pagesService.publish(auth, pageId, version, input.change_note || null);
  }
}
