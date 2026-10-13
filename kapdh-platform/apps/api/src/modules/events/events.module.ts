import { Module } from "@nestjs/common";
import {
  AdminCheckinController,
  AdminEventCategoriesController,
  AdminEventCoversController,
  AdminEventsController,
} from "./admin-events.controller.js";
import { AdminEventsService } from "./admin-events.service.js";
import { CheckinService } from "./checkin.service.js";
import { EventViews } from "./event-views.js";
import { EventsJobsModule } from "./events-jobs.module.js";
import { EventsController, MyTicketsController } from "./events.controller.js";
import { MemberEventsService } from "./member-events.service.js";
import { ReservationsService } from "./reservations.service.js";

/**
 * F-09 (ARCHITECTURE §4.1, §3.4): event, reservasi, tiket, handler pembayaran tiket, check-in, pembatalan,
 * pengingat dan job kedaluwarsa reservasi (kontrak C5 events.yaml dan admin-events.yaml). Job, handler pembayaran
 * `ticket` dan TicketLedger ada di EventsJobsModule (juga dimuat worker); controller dan layanan HTTP di sini.
 */
@Module({
  imports: [EventsJobsModule],
  controllers: [
    EventsController,
    MyTicketsController,
    AdminEventCategoriesController,
    AdminEventsController,
    AdminEventCoversController,
    AdminCheckinController,
  ],
  providers: [EventViews, MemberEventsService, ReservationsService, AdminEventsService, CheckinService],
  exports: [EventViews],
})
export class EventsModule {}
