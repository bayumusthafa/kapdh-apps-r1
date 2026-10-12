import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { PublicController } from "./public.controller.js";

/** /public/config dan /health (PRD 4.5, 5.5). Verifikasi KTA dan halaman publik dilayani modul membership/content. */
@Module({
  controllers: [PublicController, HealthController],
})
export class PublicModule {}
