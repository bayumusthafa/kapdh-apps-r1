import { Module } from "@nestjs/common";
import { AccountModule } from "../account/account.module.js";
import { HealthController } from "./health.controller.js";
import { PublicController } from "./public.controller.js";

/** /public/config dan /health (PRD 4.5, 5.5). Verifikasi KTA dan halaman publik dilayani modul membership/content. */
@Module({
  // Gerbang deletion ledger untuk readiness (DeletionLedgerGate, AC F14-6).
  imports: [AccountModule],
  controllers: [PublicController, HealthController],
})
export class PublicModule {}
