import { Module } from "@nestjs/common";
import { EventsJobsModule } from "./events-jobs.module.js";

/**
 * F-09 (ARCHITECTURE §4.1, §3.4): event, reservasi, tiket, handler pembayaran tiket, check-in, pembatalan,
 * pengingat, job kedaluwarsa reservasi. Diisi agen modul events (Tahap C).
 */
@Module({ imports: [EventsJobsModule] })
export class EventsModule {}
