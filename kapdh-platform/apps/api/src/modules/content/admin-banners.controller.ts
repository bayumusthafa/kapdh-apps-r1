import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, RequirePermission } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { parsePageQuery } from "../../core/pagination/cursor.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { validate, validateQuery } from "../../core/validation/validate.js";
import { bannerCreateSchema, bannerListQuerySchema, bannerUpdateSchema, toDate } from "./admin-content.schemas.js";
import { BannersService } from "./banners.service.js";

type AdminBanner = components["schemas"]["AdminBanner"];
type AdminBannerPage = components["schemas"]["AdminBannerPage"];

/**
 * Banner Beranda untuk pengurus berizin content.manage (F-08, guideline p13 tab Banner): gambar, target
 * tervalidasi, jendela tayang, urutan, aktif (AC F08-2). Perubahan memakai If-Match (AC F15-4); tanpa izin 403
 * (AC F15-1).
 */
@Controller("admin/content/banners")
@Audience("admin")
@RequirePermission("content.manage")
export class AdminBannersController {
  constructor(private readonly bannersService: BannersService) {}

  @Get()
  list(@Query() query: unknown): Promise<AdminBannerPage> {
    const page = parsePageQuery(query);
    const filters = validateQuery(bannerListQuerySchema, query);
    return this.bannersService.list({
      q: filters.q,
      state: filters.state,
      sort: filters.sort,
      cursor: page.cursor,
      limit: page.limit,
    });
  }

  @Post()
  @HttpCode(201)
  @Idempotent()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<AdminBanner> {
    const input = validate(bannerCreateSchema, body);
    return this.bannersService.create(auth, {
      ...input,
      starts_at: toDate(input.starts_at),
      ends_at: toDate(input.ends_at) ?? null,
    });
  }

  @Get(":bannerId")
  get(@Param("bannerId", UuidParamOrValidationError) bannerId: string): Promise<AdminBanner> {
    return this.bannersService.get(bannerId);
  }

  @Patch(":bannerId")
  @HttpCode(200)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("bannerId", UuidParamOrValidationError) bannerId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminBanner> {
    const version = parseIfMatch(ifMatch);
    const input = validate(bannerUpdateSchema, body);
    return this.bannersService.update(auth, bannerId, version, {
      ...input,
      starts_at: input.starts_at === undefined ? undefined : toDate(input.starts_at),
      ends_at: toDate(input.ends_at),
    });
  }

  @Delete(":bannerId")
  @HttpCode(204)
  async remove(
    @Param("bannerId", UuidParamOrValidationError) bannerId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<void> {
    await this.bannersService.remove(bannerId, parseIfMatch(ifMatch));
  }
}
