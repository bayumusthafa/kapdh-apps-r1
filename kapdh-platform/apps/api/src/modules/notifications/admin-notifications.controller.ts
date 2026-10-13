import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { z } from "zod";
import { fieldError } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, RequirePermission } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { NOTIFICATION_CATEGORIES } from "../../core/notifications-kernel/notification.service.js";
import { parsePageQuery } from "../../core/pagination/cursor.js";
import { queryBool, validate, validateQuery } from "../../core/validation/validate.js";
import { AdminNotificationsService } from "./admin-notifications.service.js";
import { queryText, strictBody, uuidList } from "./validation.js";

type AdminNotificationDeliveryPage = components["schemas"]["AdminNotificationDeliveryPage"];
type AdminDeliveryRetryResult = components["schemas"]["AdminDeliveryRetryResult"];
type AdminOutboxEventPage = components["schemas"]["AdminOutboxEventPage"];
type AdminOutboxRetryResult = components["schemas"]["AdminOutboxRetryResult"];

const dateTime = z.iso
  .datetime({ offset: true, message: "Gunakan format tanggal-waktu ISO 8601" })
  .transform((value) => new Date(value));

const deliveriesQuerySchema = z.object({
  status: z.enum(["pending", "sent", "failed", "cancelled"], { message: "Status tidak dikenal" }).optional(),
  channel: z.enum(["push", "email"], { message: "Kanal tidak dikenal" }).optional(),
  category: z.enum(NOTIFICATION_CATEGORIES, { message: "Kategori tidak dikenal" }).optional(),
  error_class: queryText(64).optional(),
  user_id: z.uuid({ message: "Format id tidak valid" }).optional(),
  notification_id: z.uuid({ message: "Format id tidak valid" }).optional(),
  retryable: queryBool().optional(),
  from: dateTime.optional(),
  to: dateTime.optional(),
  sort: z
    .enum(["created_at_desc", "created_at_asc", "updated_at_desc"], { message: "Urutan tidak dikenal" })
    .optional(),
});

const outboxQuerySchema = z.object({
  status: z.enum(["pending", "dispatched", "failed", "dead"], { message: "Status tidak dikenal" }).optional(),
  topic: queryText(100).optional(),
  from: dateTime.optional(),
  to: dateTime.optional(),
  sort: z
    .enum(["created_at_desc", "created_at_asc", "next_attempt_at_asc"], { message: "Urutan tidak dikenal" })
    .optional(),
});

const idList = (field: string) => uuidList(field).transform((ids) => ids.map((id) => id.toLowerCase()));

const deliveryRetrySchema = strictBody({ delivery_ids: idList("delivery_ids") });
const outboxRetrySchema = strictBody({ event_ids: idList("event_ids") });

function assertRange(from: Date | undefined, to: Date | undefined): void {
  if (from && to && from.getTime() >= to.getTime())
    throw fieldError("to", "Batas akhir harus setelah batas awal.");
}

/**
 * Status pengiriman notifikasi dan event outbox (F-13, PRD 4.5, 5.1; kontrak admin-notifications.yaml). Semua operasi
 * memerlukan izin notifications.manage yang dievaluasi dari database setiap request (AC F15-1).
 */
@Controller("admin/notifications")
export class AdminNotificationsController {
  constructor(private readonly service: AdminNotificationsService) {}

  /** adminListNotificationDeliveries: `sent` = diterima provider, bukan dibaca (F-13). */
  @Get("deliveries")
  @Audience("admin")
  @RequirePermission("notifications.manage")
  listDeliveries(@Query() query: unknown): Promise<AdminNotificationDeliveryPage> {
    const page = parsePageQuery(query);
    const filter = validateQuery(deliveriesQuerySchema, query);
    assertRange(filter.from, filter.to);
    return this.service.listDeliveries({
      status: filter.status,
      channel: filter.channel,
      category: filter.category,
      errorClass: filter.error_class,
      userId: filter.user_id?.toLowerCase(),
      notificationId: filter.notification_id?.toLowerCase(),
      retryable: filter.retryable,
      from: filter.from,
      to: filter.to,
      sort: filter.sort ?? "created_at_desc",
      cursor: page.cursor,
      limit: page.limit,
    });
  }

  /** adminRetryNotificationDeliveries: retry terkendali, dibatasi per admin, diaudit (AC F13-4, F17-1). */
  @Post("deliveries/retry")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("notifications.manage")
  @Idempotent()
  retryDeliveries(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<AdminDeliveryRetryResult> {
    const input = validate(deliveryRetrySchema, body);
    return this.service.retryDeliveries(auth.adminId!, input.delivery_ids);
  }

  /** adminListOutboxEvents: tanpa `status` hanya failed dan dead; payload dan dedup key tidak diekspos. */
  @Get("outbox")
  @Audience("admin")
  @RequirePermission("notifications.manage")
  listOutbox(@Query() query: unknown): Promise<AdminOutboxEventPage> {
    const page = parsePageQuery(query);
    const filter = validateQuery(outboxQuerySchema, query);
    assertRange(filter.from, filter.to);
    return this.service.listOutbox({
      status: filter.status,
      topic: filter.topic,
      from: filter.from,
      to: filter.to,
      sort: filter.sort ?? "created_at_desc",
      cursor: page.cursor,
      limit: page.limit,
    });
  }

  /** adminRetryOutboxEvents: lease dispatcher yang masih berlaku tidak diputus (`in_progress`). */
  @Post("outbox/retry")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("notifications.manage")
  @Idempotent()
  retryOutbox(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<AdminOutboxRetryResult> {
    const input = validate(outboxRetrySchema, body);
    return this.service.retryOutbox(auth.adminId!, input.event_ids);
  }
}
