import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import { Audience, RequirePermission } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { parsePageQuery } from "../../core/pagination/cursor.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { validate, validateQuery } from "../../core/validation/validate.js";
import {
  categoryCreateSchema,
  categoryListQuerySchema,
  categoryUpdateSchema,
} from "./admin-content.schemas.js";
import { CategoriesService, type ContentCategoryKind } from "./categories.service.js";

type AdminContentCategory = components["schemas"]["AdminContentCategory"];
type AdminContentCategoryPage = components["schemas"]["AdminContentCategoryPage"];

/** Operasi bersama "Manajemen Kategori" untuk satu jenis; jenis ditentukan path, bukan body. */
abstract class CategoryEndpoints {
  protected abstract readonly kind: ContentCategoryKind;

  constructor(protected readonly categories: CategoriesService) {}

  protected listOf(query: unknown): Promise<AdminContentCategoryPage> {
    const page = parsePageQuery(query);
    const filters = validateQuery(categoryListQuerySchema, query);
    return this.categories.adminList(this.kind, {
      active: filters.active,
      q: filters.q,
      sort: filters.sort,
      cursor: page.cursor,
      limit: page.limit,
    });
  }

  protected createOf(body: unknown): Promise<AdminContentCategory> {
    return this.categories.create(this.kind, validate(categoryCreateSchema, body));
  }

  protected updateOf(id: string, ifMatch: string | undefined, body: unknown): Promise<AdminContentCategory> {
    const version = parseIfMatch(ifMatch);
    return this.categories.update(this.kind, id, version, validate(categoryUpdateSchema, body));
  }

  protected removeOf(id: string, ifMatch: string | undefined): Promise<void> {
    return this.categories.remove(this.kind, id, parseIfMatch(ifMatch));
  }
}

/**
 * Kategori berita (guideline p13 "Manajemen Kategori"): izin content.manage (AC F15-1). Id kategori event -> 404;
 * kategori yang dipakai tidak dapat dihapus (409 VALIDATION_ERROR), hanya dinonaktifkan.
 */
@Controller("admin/content/post-categories")
@Audience("admin")
@RequirePermission("content.manage")
export class AdminPostCategoriesController extends CategoryEndpoints {
  protected readonly kind = "post" as const;

  constructor(categories: CategoriesService) {
    super(categories);
  }

  @Get()
  list(@Query() query: unknown): Promise<AdminContentCategoryPage> {
    return this.listOf(query);
  }

  @Post()
  @HttpCode(201)
  @Idempotent()
  create(@Body() body: unknown): Promise<AdminContentCategory> {
    return this.createOf(body);
  }

  @Get(":categoryId")
  get(@Param("categoryId", UuidParamOrValidationError) categoryId: string): Promise<AdminContentCategory> {
    return this.categories.adminGet(this.kind, categoryId);
  }

  @Patch(":categoryId")
  @HttpCode(200)
  update(
    @Param("categoryId", UuidParamOrValidationError) categoryId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminContentCategory> {
    return this.updateOf(categoryId, ifMatch, body);
  }

  @Delete(":categoryId")
  @HttpCode(204)
  async remove(
    @Param("categoryId", UuidParamOrValidationError) categoryId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<void> {
    await this.removeOf(categoryId, ifMatch);
  }
}

/**
 * Kategori event (guideline p14 "Manajemen Kategori" di halaman Event dan Tiket): izin events.manage sehingga
 * pengurus event tidak membutuhkan izin konten dan sebaliknya (PRD 2.3, AC F15-1). Id kategori berita -> 404.
 */
@Controller("admin/content/event-categories")
@Audience("admin")
@RequirePermission("events.manage")
export class AdminEventCategoriesController extends CategoryEndpoints {
  protected readonly kind = "event" as const;

  constructor(categories: CategoriesService) {
    super(categories);
  }

  @Get()
  list(@Query() query: unknown): Promise<AdminContentCategoryPage> {
    return this.listOf(query);
  }

  @Post()
  @HttpCode(201)
  @Idempotent()
  create(@Body() body: unknown): Promise<AdminContentCategory> {
    return this.createOf(body);
  }

  @Get(":categoryId")
  get(@Param("categoryId", UuidParamOrValidationError) categoryId: string): Promise<AdminContentCategory> {
    return this.categories.adminGet(this.kind, categoryId);
  }

  @Patch(":categoryId")
  @HttpCode(200)
  update(
    @Param("categoryId", UuidParamOrValidationError) categoryId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminContentCategory> {
    return this.updateOf(categoryId, ifMatch, body);
  }

  @Delete(":categoryId")
  @HttpCode(204)
  async remove(
    @Param("categoryId", UuidParamOrValidationError) categoryId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<void> {
    await this.removeOf(categoryId, ifMatch);
  }
}
