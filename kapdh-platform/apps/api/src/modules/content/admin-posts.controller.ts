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
  postCreateSchema,
  postListQuerySchema,
  postPublishSchema,
  postUpdateSchema,
  toDate,
} from "./admin-content.schemas.js";
import { PostsService } from "./posts.service.js";

type AdminPost = components["schemas"]["AdminPost"];
type AdminPostPage = components["schemas"]["AdminPostPage"];

/**
 * Berita untuk pengurus berizin content.manage (F-08, F-15, guideline p13 "Feed Informasi"): tabel dengan
 * pencarian/filter/urutan server, draft, terbit/terjadwal, batal jadwal, arsip, pulihkan, hapus. Tanpa izin -> 403
 * walaupun menu disembunyikan (AC F15-1); perubahan memakai If-Match (AC F15-4). Parameter id bukan uuid atau
 * If-Match kosong -> 400 VALIDATION_ERROR.
 */
@Controller("admin/content/posts")
@Audience("admin")
@RequirePermission("content.manage")
export class AdminPostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  list(@Query() query: unknown): Promise<AdminPostPage> {
    const page = parsePageQuery(query);
    const filters = validateQuery(postListQuerySchema, query);
    return this.postsService.list({
      q: filters.q,
      state: filters.state,
      categoryId: filters.category_id,
      sort: filters.sort,
      cursor: page.cursor,
      limit: page.limit,
    });
  }

  @Post()
  @HttpCode(201)
  @Idempotent()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<AdminPost> {
    return this.postsService.create(auth, validate(postCreateSchema, body));
  }

  @Get(":postId")
  get(@Param("postId", UuidParamOrValidationError) postId: string): Promise<AdminPost> {
    return this.postsService.get(postId);
  }

  @Patch(":postId")
  @HttpCode(200)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("postId", UuidParamOrValidationError) postId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminPost> {
    const version = parseIfMatch(ifMatch);
    return this.postsService.update(auth, postId, version, validate(postUpdateSchema, body));
  }

  @Delete(":postId")
  @HttpCode(204)
  async remove(
    @Param("postId", UuidParamOrValidationError) postId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<void> {
    await this.postsService.remove(postId, parseIfMatch(ifMatch));
  }

  /** Terbit sekarang (published_at null) atau terjadwal (masa depan) (AC F08-1, F15-5). */
  @Post(":postId/publish")
  @HttpCode(200)
  @Idempotent()
  publish(
    @Param("postId", UuidParamOrValidationError) postId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<AdminPost> {
    const version = parseIfMatch(ifMatch);
    const input = validate(postPublishSchema, body);
    return this.postsService.publish(postId, version, toDate(input.published_at) ?? null);
  }

  @Post(":postId/unschedule")
  @HttpCode(200)
  @Idempotent()
  unschedule(
    @Param("postId", UuidParamOrValidationError) postId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<AdminPost> {
    return this.postsService.unschedule(postId, parseIfMatch(ifMatch));
  }

  @Post(":postId/archive")
  @HttpCode(200)
  @Idempotent()
  archive(
    @Param("postId", UuidParamOrValidationError) postId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<AdminPost> {
    return this.postsService.archive(postId, parseIfMatch(ifMatch));
  }

  @Post(":postId/restore")
  @HttpCode(200)
  @Idempotent()
  restore(
    @Param("postId", UuidParamOrValidationError) postId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<AdminPost> {
    return this.postsService.restore(postId, parseIfMatch(ifMatch));
  }
}
