import { Controller, Delete, Get, HttpCode, Param, Put, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { z } from "zod";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { parsePageQuery } from "../../core/pagination/cursor.js";
import { validate, validateQuery } from "../../core/validation/validate.js";
import { CategoriesService } from "./categories.service.js";
import { POST_SLUG_MAX } from "./content.util.js";
import { FeedService } from "./feed.service.js";
import { HomeService } from "./home.service.js";

type Home = components["schemas"]["Home"];
type PostPage = components["schemas"]["PostPage"];
type Post = components["schemas"]["Post"];
type LikeState = components["schemas"]["LikeState"];
type ContentCategoryList = components["schemas"]["ContentCategoryList"];

const slugParam = z.object({
  slug: z.string().min(1, "Slug wajib diisi.").max(POST_SLUG_MAX, `Slug maksimal ${POST_SLUG_MAX} karakter.`),
});

/** Slug path berita: melebihi panjang maksimum -> 400 VALIDATION_ERROR (kontrak PostSlug). */
function postSlug(slug: string): string {
  return validate(slugParam, { slug }).slug;
}

/**
 * Beranda, berita, like dan kategori untuk aplikasi anggota (F-08, PRD 3.8). Beranda, feed, detail dan like hanya
 * untuk anggota aktif (verified/expiring, PRD 2.2): unverified/expired 403 MEMBERSHIP_REQUIRED, suspended 403
 * ACCOUNT_SUSPENDED (dievaluasi AuthGuard setiap request).
 */
@Controller()
export class ContentController {
  constructor(
    private readonly homeService: HomeService,
    private readonly feed: FeedService,
    private readonly categories: CategoriesService,
  ) {}

  /** GET /home: banner tampil, event mendatang, berita terbaru, akses cepat (AC F08-2, F08-4). */
  @Get("home")
  @Audience("mobile")
  @MemberAccess("active")
  home(@CurrentAuth() auth: AuthContext): Promise<Home> {
    return this.homeService.home(auth);
  }

  /** GET /posts: hanya published yang sudah waktunya tampil (AC F08-1). */
  @Get("posts")
  @Audience("mobile")
  @MemberAccess("active")
  listPosts(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<PostPage> {
    const page = parsePageQuery(query);
    const { category } = validateQuery(
      z.object({ category: z.string().min(1).max(80, "Slug kategori maksimal 80 karakter.").optional() }),
      query,
    );
    return this.feed.list(auth.userId, page, category);
  }

  @Get("posts/:slug")
  @Audience("mobile")
  @MemberAccess("active")
  getPost(@CurrentAuth() auth: AuthContext, @Param("slug") slug: string): Promise<Post> {
    return this.feed.get(auth.userId, postSlug(slug));
  }

  /** PUT like: idempoten alami, maksimal satu like per pengguna per berita (AC F08-3). */
  @Put("posts/:slug/like")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  like(@CurrentAuth() auth: AuthContext, @Param("slug") slug: string): Promise<LikeState> {
    return this.feed.setLike(auth.userId, postSlug(slug), true);
  }

  /** DELETE like: idempoten alami; like yang tidak ada tetap 200 liked=false (AC F08-3). */
  @Delete("posts/:slug/like")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  unlike(@CurrentAuth() auth: AuthContext, @Param("slug") slug: string): Promise<LikeState> {
    return this.feed.setLike(auth.userId, postSlug(slug), false);
  }

  /** GET /categories: kategori aktif untuk tab berita/event dan pilihan formulir (sesi apa pun). */
  @Get("categories")
  @Audience("any")
  listCategories(@Query() query: unknown): Promise<ContentCategoryList> {
    const { kind } = validateQuery(
      z.object({ kind: z.enum(["post", "event"], { message: "Jenis kategori post atau event." }).optional() }),
      query,
    );
    return this.categories.listActive(kind);
  }
}
