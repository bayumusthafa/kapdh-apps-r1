import { Module } from "@nestjs/common";
import { ContentAnnounceService } from "./content-announce.service.js";

/**
 * Bagian modul content yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): job `content.announce` (setiap menit, sekali per
 * berita yang published_at-nya tiba; AC F15-5) beserta layanan yang dipakainya (core: NotificationService,
 * AuditService, JobRegistry). Diimpor modul content (sehingga job juga terdaftar di aplikasi API/uji:
 * `jobs.runScheduled("content.announce")`) dan oleh createWorkerContext lewat WORKER_MODULES. Tanpa controller dan
 * tanpa provider yang bergantung pada layanan khusus API (TokenService, SessionIssuer, PasswordVerifier,
 * QrTokenService, SessionValidator, AuthGuard, RequestGate, RealtimeGateway); uji `test/core/jobs.e2e.test.ts` gagal
 * bila aturan ini dilanggar.
 */
@Module({
  providers: [ContentAnnounceService],
  exports: [ContentAnnounceService],
})
export class ContentJobsModule {}
