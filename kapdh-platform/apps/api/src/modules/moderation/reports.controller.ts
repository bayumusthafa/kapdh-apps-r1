import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { UuidParam } from "../../core/validation/uuid-param.pipe.js";
import { validate } from "../../core/validation/validate.js";
import { type CreateReportInput, ReportsService } from "./reports.service.js";

type ModerationReport = components["schemas"]["ModerationReport"];
type ModerationReportPage = components["schemas"]["ModerationReportPage"];

const INPUT_CATEGORIES = [
  "spam",
  "harassment",
  "hate",
  "sexual",
  "violence_threat",
  "scam",
  "other",
] as const satisfies readonly components["schemas"]["ModerationReportInputCategory"][];

/** Jumlah karakter bukan spasi (deskripsi wajib "minimal 10 karakter bukan spasi"). */
const nonSpace = (value: string) => value.replace(/\s/g, "").length;

const TARGET_FIELDS = {
  user: "target_user_id",
  message: "message_id",
  room: "room_id",
} as const;

/** Kontrak CreateModerationReportRequest: target_type menentukan field wajib; field target lain tidak boleh diisi. */
const createReportSchema = z
  .object({
    target_type: z.enum(["user", "message", "room"], { message: "Pilih jenis yang dilaporkan." }),
    target_user_id: z.uuid("Format id tidak valid").optional(),
    message_id: z.uuid("Format id tidak valid").optional(),
    room_id: z.uuid("Format id tidak valid").optional(),
    context_message_ids: z
      .array(z.uuid("Format id tidak valid"))
      .max(5, "Maksimal 5 pesan konteks.")
      .refine((ids) => new Set(ids).size === ids.length, "Pesan konteks tidak boleh berulang.")
      .optional(),
    category: z.enum(INPUT_CATEGORIES, { message: "Pilih kategori laporan." }),
    description: z.string().max(2000, "Penjelasan maksimal 2.000 karakter.").optional(),
  })
  .superRefine((value, issues) => {
    const required = TARGET_FIELDS[value.target_type];
    for (const field of Object.values(TARGET_FIELDS)) {
      const present = value[field] !== undefined;
      if (field === required && !present)
        issues.addIssue({ code: "custom", path: [field], message: "Wajib diisi untuk jenis laporan ini." });
      if (field !== required && present)
        issues.addIssue({
          code: "custom",
          path: [field],
          message: "Tidak boleh diisi untuk jenis laporan ini.",
        });
    }
    if (value.context_message_ids !== undefined && value.target_type !== "message")
      issues.addIssue({
        code: "custom",
        path: ["context_message_ids"],
        message: "Pesan konteks hanya untuk laporan pesan.",
      });
    if (value.category === "other" && nonSpace(value.description ?? "") < 10)
      issues.addIssue({
        code: "custom",
        path: ["description"],
        message: "Jelaskan laporan minimal 10 karakter untuk kategori lainnya.",
      });
  });

const createAppealSchema = z.object({
  description: z
    .string({ message: "Alasan banding wajib diisi." })
    .max(2000, "Alasan banding maksimal 2.000 karakter.")
    .refine((value) => nonSpace(value) >= 10, "Alasan banding minimal 10 karakter."),
});

/**
 * Laporan dan banding anggota (F-12, AC F12-2; kontrak moderation.yaml). Melaporkan pihak lain hanya untuk anggota
 * aktif; riwayat laporan sendiri dan banding tersedia untuk semua status anggota termasuk suspended (portal
 * pembatasan, PRD 2.2). Respons 201 untuk laporan/banding baru, 200 bila laporan/banding aktif yang sama dikembalikan.
 */
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("reports")
  @Audience("mobile")
  @MemberAccess("any")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<ModerationReportPage> {
    return this.reports.listMine(auth, query);
  }

  @Post("reports")
  @HttpCode(201)
  @Audience("mobile")
  @MemberAccess("active")
  @Idempotent()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ModerationReport> {
    const input = validate(createReportSchema, body);
    const description = input.description?.trim() || null;
    const command: CreateReportInput =
      input.target_type === "user"
        ? {
            targetType: "user",
            targetUserId: input.target_user_id!.toLowerCase(),
            category: input.category,
            description,
          }
        : input.target_type === "message"
          ? {
              targetType: "message",
              messageId: input.message_id!.toLowerCase(),
              contextMessageIds: (input.context_message_ids ?? []).map((id) => id.toLowerCase()),
              category: input.category,
              description,
            }
          : {
              targetType: "room",
              roomId: input.room_id!.toLowerCase(),
              category: input.category,
              description,
            };
    const result = await this.reports.create(auth, command);
    if (!result.created) void reply.status(200);
    return result.report;
  }

  @Get("reports/:reportId")
  @Audience("mobile")
  @MemberAccess("any")
  get(
    @CurrentAuth() auth: AuthContext,
    @Param("reportId", UuidParam) reportId: string,
  ): Promise<ModerationReport> {
    return this.reports.getMine(auth, reportId);
  }

  @Post("appeals")
  @HttpCode(201)
  @Audience("mobile")
  @MemberAccess("any")
  @Idempotent()
  async appeal(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ModerationReport> {
    const input = validate(createAppealSchema, body);
    const result = await this.reports.createAppeal(auth, input.description.trim());
    if (!result.created) void reply.status(200);
    return result.report;
  }
}
