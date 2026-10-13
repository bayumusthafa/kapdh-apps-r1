import { Controller, Get, Param, Res } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { tryCtx } from "../../core/context/request-context.js";
import { Public } from "../../core/guards/decorators.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { validate } from "../../core/validation/validate.js";
import { PAGE_SLUG_MAX } from "./content.util.js";
import { PagesService } from "./pages.service.js";

type PublicPage = components["schemas"]["PublicPage"];
type PublicPageList = components["schemas"]["PublicPageList"];

/** Batas baca halaman publik per IP (kontrak: tanpa autentikasi, dibatasi rate limit per IP). */
export const PUBLIC_PAGES_LIMIT = 120;
export const PUBLIC_PAGES_WINDOW_MS = 60_000;

/** Respons halaman yang BERHASIL boleh di-cache publik maksimal 60 detik (kontrak listPublicPages/getPublicPage). */
export const PUBLIC_PAGES_CACHE_CONTROL = "public, max-age=60";
/** Respons galat (400, 404, 429, ...) tidak boleh disimpan cache bersama/CDN maupun browser. */
export const PUBLIC_PAGES_ERROR_CACHE_CONTROL = "no-store";

/**
 * Halaman informasi dan legal versi tayang, publik tanpa login (PRD 3.8: dapat dibaca sebelum aktivasi; PRD 2.2:
 * pending_otp/unverified tetap dapat membaca legal). Dipakai situs publik, layar legal aplikasi dan registrasi
 * (`consent.policy_version`, F-01). Dilayani selama maintenance (baca /public/**).
 *
 * Header cache ditetapkan per hasil, bukan lewat dekorator `@Header` (yang dipasang sebelum handler berjalan dan
 * ikut terkirim pada galat): galat membawa `no-store` sehingga 429 atau 404 (mis. halaman yang baru pertama kali
 * terbit) tidak tertahan di CDN/proxy; hanya 200 yang membawa `public, max-age=60`.
 */
@Controller("public/pages")
export class PublicPagesController {
  constructor(
    private readonly pages: PagesService,
    private readonly rateLimits: RateLimitService,
  ) {}

  private async limit(): Promise<void> {
    await this.rateLimits.consumeOrThrow(
      `public-pages:${tryCtx()?.ip ?? "unknown"}`,
      PUBLIC_PAGES_LIMIT,
      PUBLIC_PAGES_WINDOW_MS,
      "Terlalu banyak permintaan. Coba lagi sebentar lagi.",
    );
  }

  /** `no-store` sampai respons berhasil dimuat, lalu cache publik singkat untuk 200. */
  private async cacheable<T>(reply: FastifyReply, load: () => Promise<T>): Promise<T> {
    void reply.header("cache-control", PUBLIC_PAGES_ERROR_CACHE_CONTROL);
    const result = await load();
    void reply.header("cache-control", PUBLIC_PAGES_CACHE_CONTROL);
    return result;
  }

  @Get()
  @Public()
  async list(@Res({ passthrough: true }) reply: FastifyReply): Promise<PublicPageList> {
    return this.cacheable(reply, async () => {
      await this.limit();
      return this.pages.publicList();
    });
  }

  @Get(":slug")
  @Public()
  async get(
    @Param("slug") slug: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PublicPage> {
    return this.cacheable(reply, async () => {
      const input = validate(
        z.object({
          slug: z.string().min(1).max(PAGE_SLUG_MAX, `Slug maksimal ${PAGE_SLUG_MAX} karakter.`),
        }),
        { slug },
      );
      await this.limit();
      return this.pages.publicGet(input.slug);
    });
  }
}
