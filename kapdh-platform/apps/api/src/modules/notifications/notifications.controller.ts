import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { z } from "zod";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { NOTIFICATION_CATEGORIES } from "../../core/notifications-kernel/notification.service.js";
import { parsePageQuery } from "../../core/pagination/cursor.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { queryBool, validate, validateQuery } from "../../core/validation/validate.js";
import { EMAIL_PREFERENCE_CATEGORIES, PUSH_PREFERENCE_CATEGORIES } from "./channel-policy.js";
import { InboxService, type MarkReadInput } from "./inbox.service.js";
import { NotificationPreferencesService } from "./preferences.service.js";

type InboxNotification = components["schemas"]["InboxNotification"];
type NotificationPage = components["schemas"]["NotificationPage"];
type NotificationUnreadCount = components["schemas"]["NotificationUnreadCount"];
type MarkNotificationsReadResult = components["schemas"]["MarkNotificationsReadResult"];
type NotificationPreferences = components["schemas"]["NotificationPreferences"];

const listQuerySchema = z.object({
  unread_only: queryBool().optional(),
  category: z.enum(NOTIFICATION_CATEGORIES, { message: "Kategori tidak dikenal" }).optional(),
});

const markReadSchema = z
  .object({
    ids: z
      .array(z.uuid({ message: "Format id tidak valid" }))
      .min(1, "Minimal satu id")
      .max(100, "Maksimal 100 id")
      .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "Id tidak boleh berulang")
      .optional(),
    all: z.boolean().optional(),
    up_to: z.iso.datetime({ offset: true, message: "Gunakan format tanggal-waktu ISO 8601" }).optional(),
  })
  .strict()
  .superRefine((value, issue) => {
    const hasIds = value.ids !== undefined;
    const all = value.all === true;
    if (hasIds === all)
      issue.addIssue({
        code: "custom",
        path: hasIds ? ["all"] : ["ids"],
        message: "Isi tepat salah satu: ids, atau all bernilai true.",
      });
    if (value.all === false)
      issue.addIssue({ code: "custom", path: ["all"], message: "all hanya boleh bernilai true." });
    if (value.up_to !== undefined && !all)
      issue.addIssue({ code: "custom", path: ["up_to"], message: "up_to hanya dipakai bersama all: true." });
  });

const toggles = <T extends readonly string[]>(categories: T) =>
  z
    .object(
      Object.fromEntries(categories.map((category) => [category, z.boolean({ message: "Wajib true atau false" })])) as {
        [K in T[number]]: z.ZodBoolean;
      },
    )
    .strict();

const preferencesSchema = z
  .object({ push: toggles(PUSH_PREFERENCE_CATEGORIES), email: toggles(EMAIL_PREFERENCE_CATEGORIES) })
  .strict();

/**
 * Kotak masuk dan preferensi notifikasi anggota (F-13; kontrak notifications.yaml). Semua operasi audience mobile,
 * member_access `any`: anggota unverified, expired dan suspended tetap dapat membuka kotak masuk (AC F13-2, PRD 2.2).
 * Admin tidak memiliki kotak masuk (token admin → 403).
 */
@Controller("notifications")
export class NotificationsController {
  constructor(
    private readonly inbox: InboxService,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  /** listNotifications: riwayat resmi, terbaru dahulu; unread_count atas seluruh kotak masuk (AC F13-2). */
  @Get()
  @Audience("mobile")
  @MemberAccess("any")
  async list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<NotificationPage> {
    const page = parsePageQuery(query);
    const filter = validateQuery(listQuerySchema, query);
    return this.inbox.list(auth.userId, {
      unreadOnly: filter.unread_only ?? false,
      category: filter.category,
      cursor: page.cursor,
      limit: page.limit,
    });
  }

  /** getNotificationUnreadCount: lencana lonceng. */
  @Get("unread-count")
  @Audience("mobile")
  @MemberAccess("any")
  async unreadCount(@CurrentAuth() auth: AuthContext): Promise<NotificationUnreadCount> {
    return { unread_count: await this.inbox.unreadCount(auth.userId) };
  }

  /** getNotificationPreferences: baris tidak ada = aktif; security/account wajib (ARCHITECTURE §4.7). */
  @Get("preferences")
  @Audience("mobile")
  @MemberAccess("any")
  getPreferences(@CurrentAuth() auth: AuthContext): Promise<NotificationPreferences> {
    return this.preferences.get(auth.userId);
  }

  /** updateNotificationPreferences: penggantian penuh; inbox tetap ditulis walau kategori dimatikan (AC F13-2). */
  @Put("preferences")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("any")
  updatePreferences(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<NotificationPreferences> {
    return this.preferences.replace(auth.userId, validate(preferencesSchema, body));
  }

  /** markNotificationsRead: `ids` milik sendiri atau `all` (opsional `up_to`); id lain diabaikan (N-09). */
  @Post("read")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("any")
  markRead(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<MarkNotificationsReadResult> {
    const input = validate(markReadSchema, body);
    const request: MarkReadInput = input.ids
      ? { ids: input.ids.map((id) => id.toLowerCase()) }
      : { all: true, upTo: input.up_to ? new Date(input.up_to) : null };
    return this.inbox.markRead(auth.userId, request);
  }

  /**
   * getNotification: dipanggil sebelum membuka deep link push (AC F13-3, F13-5). Sesi logout → 401 (guard); milik akun
   * lain → 404 tanpa membedakan (N-09); id bukan UUID → 400.
   */
  @Get(":notificationId")
  @Audience("mobile")
  @MemberAccess("any")
  get(
    @CurrentAuth() auth: AuthContext,
    @Param("notificationId", UuidParamOrValidationError) notificationId: string,
  ): Promise<InboxNotification> {
    return this.inbox.get(auth.userId, notificationId);
  }
}
