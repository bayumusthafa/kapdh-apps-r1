import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { z } from "zod";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, RequirePermission } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { parsePageQuery } from "../../core/pagination/cursor.js";
import { UuidParam } from "../../core/validation/uuid-param.pipe.js";
import { queryBool, validate, validateQuery } from "../../core/validation/validate.js";
import { AdminReportsService, type ResolveInput } from "./admin-reports.service.js";

type Detail = components["schemas"]["AdminModerationReportDetail"];
type Page = components["schemas"]["AdminModerationReportPage"];

const CATEGORIES = [
  "spam",
  "harassment",
  "hate",
  "sexual",
  "violence_threat",
  "scam",
  "other",
  "appeal",
] as const satisfies readonly components["schemas"]["ModerationReportCategory"][];

const queueQuerySchema = z.object({
  status: z.enum(["active", "open", "in_review", "resolved", "dismissed", "all"]).default("active"),
  priority: z.enum(["normal", "urgent"]).optional(),
  category: z.enum(CATEGORIES).optional(),
  target_type: z.enum(["user", "message", "room"]).optional(),
  overdue: queryBool().optional(),
  q: z.string().trim().min(1, "Minimal 1 karakter").max(100, "Maksimal 100 karakter").optional(),
  sort: z.enum(["due", "newest", "oldest"]).default("due"),
});

/** Teks wajib yang tidak boleh hanya spasi (AC F12-3: keputusan wajib beralasan; DB reports_resolution_note_chk). */
const trimmedText = (min: number, max: number, label: string) =>
  z
    .string({ message: `${label} wajib diisi.` })
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(min, `${label} minimal ${min} karakter (tidak boleh hanya spasi).`)
        .max(max, `${label} maksimal ${max.toLocaleString("id-ID")} karakter.`),
    );

const resolveSchema = z.object({
  action: z.enum(["dismiss", "warn", "suspend", "unsuspend"], { message: "Pilih tindakan keputusan." }),
  note: trimmedText(3, 1000, "Alasan keputusan"),
  member_message: trimmedText(3, 500, "Pesan untuk anggota").optional(),
  subject_user_id: z.uuid("Format id tidak valid").optional(),
  remove_message: z.boolean().default(false),
  confirm: z.boolean().optional(),
});

/**
 * Moderasi web admin (F-12, F-15; kontrak admin-moderation.yaml). Izin dievaluasi dari database setiap request
 * (AC F15-1, F16-3): baca antrean/detail `moderation.read`; klaim dan keputusan `moderation.read` +
 * `moderation.resolve`. Aplikasi Flutter tidak memiliki menu moderasi (v3.2).
 */
@Controller("admin/reports")
export class AdminReportsController {
  constructor(private readonly reports: AdminReportsService) {}

  @Get()
  @Audience("admin")
  @RequirePermission("moderation.read")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<Page> {
    const filters = validateQuery(queueQuerySchema, query);
    const page = parsePageQuery(query);
    return this.reports.list(auth, {
      status: filters.status,
      priority: filters.priority,
      category: filters.category,
      targetType: filters.target_type,
      overdue: filters.overdue,
      q: filters.q,
      sort: filters.sort,
      cursor: page.cursor,
      limit: page.limit,
    });
  }

  @Get(":reportId")
  @Audience("admin")
  @RequirePermission("moderation.read")
  get(@CurrentAuth() auth: AuthContext, @Param("reportId", UuidParam) reportId: string): Promise<Detail> {
    return this.reports.get(auth, reportId);
  }

  @Post(":reportId/claim")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("moderation.read", "moderation.resolve")
  @Idempotent()
  claim(
    @CurrentAuth() auth: AuthContext,
    @Param("reportId", UuidParam) reportId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<Detail> {
    return this.reports.claim(auth, reportId, parseIfMatch(ifMatch));
  }

  @Post(":reportId/resolve")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("moderation.read", "moderation.resolve")
  @Idempotent()
  resolve(
    @CurrentAuth() auth: AuthContext,
    @Param("reportId", UuidParam) reportId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Detail> {
    const input = validate(resolveSchema, body);
    const expectedVersion = parseIfMatch(ifMatch);
    const command: ResolveInput = {
      action: input.action,
      note: input.note,
      memberMessage: input.member_message ?? null,
      subjectUserId: input.subject_user_id?.toLowerCase() ?? null,
      removeMessage: input.remove_message,
      confirm: input.confirm === true,
    };
    return this.reports.resolve(auth, reportId, expectedVersion, command);
  }
}
