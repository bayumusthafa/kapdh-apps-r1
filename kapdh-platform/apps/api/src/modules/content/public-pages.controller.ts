import { Controller, Get, Header, Param } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
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

/**
 * Halaman informasi dan legal versi tayang, publik tanpa login (PRD 3.8: dapat dibaca sebelum aktivasi; PRD 2.2:
 * pending_otp/unverified tetap dapat membaca legal). Dipakai situs publik, layar legal aplikasi dan registrasi
 * (`consent.policy_version`, F-01). Dilayani selama maintenance (baca /public/**).
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

  @Get()
  @Public()
  @Header("cache-control", "public, max-age=60")
  async list(): Promise<PublicPageList> {
    await this.limit();
    return this.pages.publicList();
  }

  @Get(":slug")
  @Public()
  @Header("cache-control", "public, max-age=60")
  async get(@Param("slug") slug: string): Promise<PublicPage> {
    const input = validate(
      z.object({
        slug: z.string().min(1).max(PAGE_SLUG_MAX, `Slug maksimal ${PAGE_SLUG_MAX} karakter.`),
      }),
      { slug },
    );
    await this.limit();
    return this.pages.publicGet(input.slug);
  }
}
