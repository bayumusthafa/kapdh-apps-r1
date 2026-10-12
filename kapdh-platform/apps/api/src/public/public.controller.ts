import { Controller, Get, Inject } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { PUBLIC_CONFIG } from "./public.tokens.js";

type PublicConfig = components["schemas"]["PublicConfig"];

/** GET /public/config: versi aplikasi minimum dan status maintenance (PRD 4.5, 5.2). */
@Controller("public")
export class PublicController {
  constructor(@Inject(PUBLIC_CONFIG) private readonly config: PublicConfig) {}

  @Get("config")
  getConfig(): PublicConfig {
    return this.config;
  }
}
