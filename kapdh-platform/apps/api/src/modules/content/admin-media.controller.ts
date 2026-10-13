import type { Multipart } from "@fastify/multipart";
import { Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { components } from "@kapdh/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { AppException, fieldError } from "../../core/errors/app-exception.js";
import { FilesService, type UploadContent, type UploadTicket } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, RequirePermission } from "../../core/guards/decorators.js";
import type { MultipartRouteConfig } from "../../core/http/fastify-hooks.js";
import { CONTENT_MEDIA_PURPOSES, type ContentMediaPurpose } from "./content-media.service.js";

type ContentMedia = components["schemas"]["ContentMedia"];

/** Galat parser multipart -> galat baku (PRD 5.2); AppException diteruskan apa adanya. */
function multipartError(error: unknown): AppException {
  if (error instanceof AppException) return error;
  switch ((error as { code?: unknown } | null)?.code) {
    case "FST_REQ_FILE_TOO_LARGE":
      return new AppException(413, "FILE_INVALID", "Gambar terlalu besar. Maksimal 5 MB.");
    case "FST_FILES_LIMIT":
      return new AppException(413, "FILE_INVALID", "Kirim satu gambar per unggahan.");
    case "FST_PARTS_LIMIT":
    case "FST_FIELDS_LIMIT":
      return new AppException(
        413,
        "FILE_INVALID",
        "Isian unggahan terlalu banyak. Kirim purpose dan satu gambar.",
      );
    case "FST_INVALID_MULTIPART_CONTENT_TYPE":
      return new AppException(415, "FILE_INVALID", "Kirim gambar sebagai multipart/form-data.");
    default:
      return new AppException(
        400,
        "VALIDATION_ERROR",
        "Format unggahan tidak valid. Pilih gambar lalu coba lagi.",
      );
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
 * POST /admin/content/media (N-10, PRD 2.5): unggah cover berita (`post_cover`) atau gambar banner (`banner_image`)
 * oleh pengurus berizin content.manage. Purpose diperiksa dan kuota (10 per purpose per admin per 24 jam) dihitung
 * SEBELUM isi dibaca; isi diperiksa magic bytes, dimensi aman, EXIF dibuang dan di-encode ulang oleh FilesService.
 * Berkas bervisibilitas publik dan dihapus job `files.cleanup-temp` bila tidak dilampirkan dalam 24 jam.
 */
@Controller("admin/content/media")
export class AdminContentMediaController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @HttpCode(201)
  @Audience("admin")
  @RequirePermission("content.manage")
  @RouteConfig({ multipart: true } satisfies MultipartRouteConfig)
  async upload(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ContentMedia> {
    let ticket: UploadTicket | null = null;
    let content: UploadContent | null = null;
    try {
      if (!request.isMultipart()) throw multipartError({ code: "FST_INVALID_MULTIPART_CONTENT_TYPE" });
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
        if (part.type === "field") {
          if (part.fieldname !== "purpose") continue;
          if (ticket) throw fieldError("purpose", "Purpose hanya boleh dikirim sekali.");
          ticket = await this.files.beginUpload(auth, part.value, { allowed: CONTENT_MEDIA_PURPOSES });
          continue;
        }
        if (part.fieldname !== "file") throw fieldError("file", "Kirim gambar pada field file.");
        if (!ticket) throw fieldError("purpose", "Kirim field purpose sebelum gambar.");
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
    if (!ticket) throw fieldError("purpose", "Purpose gambar wajib diisi (post_cover atau banner_image).");
    if (!content) throw fieldError("file", "Gambar wajib dikirim.");
    const file = await this.files.completeUpload(ticket, content);
    return {
      file_id: file.id,
      purpose: file.purpose as ContentMediaPurpose,
      url: this.files.publicUrl(file.id),
      mime: file.mime,
      bytes: file.bytes,
      width: file.width ?? 1,
      height: file.height ?? 1,
    };
  }
}
