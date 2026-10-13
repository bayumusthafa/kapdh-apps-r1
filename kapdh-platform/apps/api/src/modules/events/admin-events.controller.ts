import type { Multipart } from "@fastify/multipart";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { components } from "@kapdh/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import { AppException, fieldError } from "../../core/errors/app-exception.js";
import { FilesService, type UploadContent, type UploadTicket } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, RequirePermission } from "../../core/guards/decorators.js";
import type { MultipartRouteConfig } from "../../core/http/fastify-hooks.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { validate } from "../../core/validation/validate.js";
import {
  adminCancelTicketSchema,
  AdminEventsService,
  cancelEventSchema,
  createEventSchema,
  eventStatusSchema,
  updateEventSchema,
} from "./admin-events.service.js";
import { CheckinService, checkinSchema } from "./checkin.service.js";

type Schemas = components["schemas"];

/** Kategori event (baca) untuk formulir dan filter event (kontrak adminListEventCategories). */
@Controller("admin/event-categories")
export class AdminEventCategoriesController {
  constructor(private readonly events: AdminEventsService) {}

  @Get()
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.manage")
  list(): Promise<Schemas["AdminEventCategoryList"]> {
    return this.events.categories();
  }
}

/**
 * Event dan Tiket di web admin (kontrak admin-events.yaml; F-09, F-15, guideline p14). Izin events.manage dievaluasi
 * dari database setiap request (AC F15-1); refund per tiket juga memerlukan payments.decide (diperiksa layanan).
 */
@Controller("admin/events")
export class AdminEventsController {
  constructor(private readonly events: AdminEventsService) {}

  @Get()
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.manage")
  list(@Query() query: unknown): Promise<Schemas["AdminEventPage"]> {
    return this.events.list(query);
  }

  @Post()
  @HttpCode(201)
  @Audience("admin")
  @RequirePermission("events.manage")
  @Idempotent()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<Schemas["AdminEventDetail"]> {
    return this.events.create(auth, validate(createEventSchema, body));
  }

  @Get(":eventId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.manage")
  detail(@Param("eventId", UuidParamOrValidationError) eventId: string): Promise<Schemas["AdminEventDetail"]> {
    return this.events.detail(eventId);
  }

  @Patch(":eventId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.manage")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("eventId", UuidParamOrValidationError) eventId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["AdminEventDetail"]> {
    const expected = parseIfMatch(ifMatch);
    return this.events.update(auth, eventId, expected, validate(updateEventSchema, body));
  }

  @Delete(":eventId")
  @HttpCode(204)
  @Audience("admin")
  @RequirePermission("events.manage")
  async remove(
    @Param("eventId", UuidParamOrValidationError) eventId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<void> {
    const expected = parseIfMatch(ifMatch);
    await this.events.remove(eventId, expected);
  }

  @Post(":eventId/status")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.manage")
  @Idempotent()
  setStatus(
    @Param("eventId", UuidParamOrValidationError) eventId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["AdminEventDetail"]> {
    const input = validate(eventStatusSchema, body);
    const expected = parseIfMatch(ifMatch);
    return this.events.setStatus(eventId, expected, input);
  }

  @Post(":eventId/cancel")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.manage")
  @Idempotent()
  cancel(
    @Param("eventId", UuidParamOrValidationError) eventId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["AdminEventCancelResult"]> {
    const expected = parseIfMatch(ifMatch);
    return this.events.cancelEvent(eventId, expected, validate(cancelEventSchema, body));
  }

  @Get(":eventId/stats")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.manage")
  stats(@Param("eventId", UuidParamOrValidationError) eventId: string): Promise<Schemas["AdminEventStats"]> {
    return this.events.stats(eventId);
  }

  @Get(":eventId/tickets")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.manage")
  tickets(
    @CurrentAuth() auth: AuthContext,
    @Param("eventId", UuidParamOrValidationError) eventId: string,
    @Query() query: unknown,
  ): Promise<Schemas["AdminEventTicketPage"]> {
    return this.events.tickets(auth, eventId, query);
  }

  @Post(":eventId/tickets/:ticketId/cancel")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.manage")
  @Idempotent()
  cancelTicket(
    @CurrentAuth() auth: AuthContext,
    @Param("eventId", UuidParamOrValidationError) eventId: string,
    @Param("ticketId", UuidParamOrValidationError) ticketId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["AdminEventTicket"]> {
    const expected = parseIfMatch(ifMatch);
    return this.events.cancelTicket(auth, eventId, ticketId, expected, validate(adminCancelTicketSchema, body));
  }
}

/** Galat parser multipart → galat baku (PRD 5.2); AppException diteruskan apa adanya. */
function multipartError(error: unknown): AppException {
  if (error instanceof AppException) return error;
  switch ((error as { code?: unknown } | null)?.code) {
    case "FST_REQ_FILE_TOO_LARGE":
      return new AppException(413, "FILE_INVALID", "Gambar terlalu besar. Maksimal 5 MB.");
    case "FST_FILES_LIMIT":
      return new AppException(413, "FILE_INVALID", "Kirim satu gambar per unggahan.");
    case "FST_PARTS_LIMIT":
    case "FST_FIELDS_LIMIT":
      return new AppException(413, "FILE_INVALID", "Isian unggahan terlalu banyak. Kirim satu gambar.");
    case "FST_INVALID_MULTIPART_CONTENT_TYPE":
      return new AppException(415, "FILE_INVALID", "Kirim gambar sebagai multipart/form-data.");
    default:
      return new AppException(400, "VALIDATION_ERROR", "Format unggahan tidak valid. Pilih gambar lalu coba lagi.");
  }
}

function tooLarge(): AppException {
  return new AppException(413, "FILE_INVALID", "Gambar terlalu besar. Maksimal 5 MB.");
}

/** Membaca stream sampai batas byte purpose; berhenti begitu batas terlampaui (N-10). */
async function readLimited(stream: Readable & { truncated?: boolean }, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      total += buffer.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(buffer);
    }
  } catch (error) {
    throw multipartError(error);
  }
  if (stream.truncated) throw tooLarge();
  return Buffer.concat(chunks, total);
}

/**
 * POST /admin/event-covers (N-10, PRD 2.5): cover event `event_cover` oleh pengurus events.manage. Hak unggah dan kuota
 * (10 per akun per 24 jam) diperiksa SEBELUM isi dibaca; isi diperiksa magic bytes, dimensi aman, EXIF dibuang dan
 * di-encode ulang oleh FilesService. Berkas publik; yang tidak dilampirkan ke event dalam 24 jam dibersihkan job.
 */
@Controller("admin/event-covers")
export class AdminEventCoversController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @HttpCode(201)
  @Audience("admin")
  @RequirePermission("events.manage")
  @RouteConfig({ multipart: true } satisfies MultipartRouteConfig)
  async upload(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentAuth() auth: AuthContext,
  ): Promise<Schemas["AdminEventCoverMedia"]> {
    let ticket: UploadTicket | null = null;
    let content: UploadContent | null = null;
    try {
      if (!request.isMultipart()) throw multipartError({ code: "FST_INVALID_MULTIPART_CONTENT_TYPE" });
      ticket = await this.files.beginUpload(auth, "event_cover", { allowed: ["event_cover"] });
      const parts = request.parts()[Symbol.asyncIterator]();
      for (;;) {
        let step: IteratorResult<Multipart>;
        try {
          step = await parts.next();
        } catch (error) {
          throw multipartError(error);
        }
        if (step.done) break;
        const part = step.value;
        if (part.type === "field") continue;
        if (part.fieldname !== "file") throw fieldError("file", "Kirim gambar pada field file.");
        if (content) throw multipartError({ code: "FST_FILES_LIMIT" });
        content = {
          data: await readLimited(part.file, ticket.maxBytes),
          filename: part.filename,
          declaredMime: part.mimetype,
        };
      }
    } catch (error) {
      // Sisa body tidak dibaca lagi: koneksi ditutup setelah respons galat.
      void reply.header("connection", "close");
      throw error;
    }
    if (!ticket || !content) throw fieldError("file", "Gambar cover wajib dikirim.");
    const file = await this.files.completeUpload(ticket, content);
    return {
      file_id: file.id,
      url: this.files.publicUrl(file.id),
      mime: file.mime,
      bytes: file.bytes,
      width: file.width ?? 1,
      height: file.height ?? 1,
    };
  }
}

/** Pemindai check-in (kontrak adminListCheckinEvents, adminCheckInTicket; izin events.checkin; AC F09-5, F09-6). */
@Controller("admin/checkin")
export class AdminCheckinController {
  constructor(private readonly checkin: CheckinService) {}

  @Get("events")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.checkin")
  events(): Promise<Schemas["AdminCheckinEventList"]> {
    return this.checkin.events();
  }

  @Post()
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("events.checkin")
  @Idempotent()
  checkIn(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<Schemas["AdminCheckinResult"]> {
    return this.checkin.checkIn(auth, validate(checkinSchema, body));
  }
}
