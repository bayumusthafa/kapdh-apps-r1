import { Module } from "@nestjs/common";
import { AdminNotificationsController } from "./admin-notifications.controller.js";
import { AdminNotificationsService } from "./admin-notifications.service.js";
import { DevicesController } from "./devices.controller.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsJobsModule } from "./notifications-jobs.module.js";

/**
 * F-13 (ARCHITECTURE §4.1, §4.7; PRD 3.13): kotak masuk, preferensi, token perangkat, prosesor pengiriman email/push
 * (di NotificationsJobsModule, juga dimuat worker) dan status pengiriman/outbox untuk pengurus (notifications.manage).
 */
@Module({
  imports: [NotificationsJobsModule],
  controllers: [NotificationsController, DevicesController, AdminNotificationsController],
  providers: [AdminNotificationsService],
})
export class NotificationsModule {}
