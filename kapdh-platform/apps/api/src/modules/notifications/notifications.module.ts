import { Module } from "@nestjs/common";
import { NotificationsJobsModule } from "./notifications-jobs.module.js";

/**
 * F-13 (ARCHITECTURE §4.1, §4.7): inbox, preferensi, perangkat, prosesor pengiriman email/push, riwayat pengiriman
 * admin. Diisi agen modul notifications (Tahap C).
 */
@Module({ imports: [NotificationsJobsModule] })
export class NotificationsModule {}
