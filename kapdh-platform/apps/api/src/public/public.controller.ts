import { Controller, Get, Inject } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { CLOCK, type Clock } from "../infra/clock.js";
import { PUBLIC_CONFIG, type StaticPublicConfig } from "./public.tokens.js";

type PublicConfig = components["schemas"]["PublicConfig"];

/**
 * GET /public/config (PRD 4.5, 5.2): versi aplikasi minimum, status maintenance, tautan toko, kontak bantuan, versi
 * legal dan waktu server. `server_time` diambil dari Clock yang diinjeksi (ARCHITECTURE §2.6) agar dapat diuji dengan
 * TestClock dan dipakai klien mendeteksi jam perangkat yang menyimpang.
 */
@Controller("public")
export class PublicController {
  constructor(
    @Inject(PUBLIC_CONFIG) private readonly config: StaticPublicConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get("config")
  getConfig(): PublicConfig {
    return { ...this.config, server_time: this.clock.now().toISOString() };
  }
}
