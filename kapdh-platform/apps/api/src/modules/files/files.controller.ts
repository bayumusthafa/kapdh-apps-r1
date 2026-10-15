import type { Multipart } from "@fastify/multipart";
import { Controller, Get, Header, HttpCode, Param, Post, Req, Res, StreamableFile } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { components } from "@kapdh/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fieldError } from "../../core/errors/app-exception.js";
import type { FileRow } from "../../core/files/access-policy.js";
import { FilesService, type UploadContent, type UploadTicket } from "../../core/files/files.service.js";
import { CANONICAL_EXTENSION } from "../../core/files/inspect.js";
import { multipartError, type MultipartMessages, readLimited } from "../../core/files/multipart-upload.js";
import { GENERAL_UPLOAD_PURPOSES } from "../../core/files/purposes.js";
import type { MultipartRouteConfig } from "../../core/http/fastify-hooks.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess, Public } from "../../core/guards/decorators.js";
import { UuidParam } from "../../core/validation/uuid-param.pipe.js";

type FileRef = components["schemas"]["FileRef"];
type FileAccess = components["schemas"]["FileAccess"];

/** Cache gambar publik: isi tidak pernah berubah untuk id yang sama (berkas baru = id baru). */
const PUBLIC_MAX_AGE_SECONDS = 86_400;

/** Pesan unggah umum: gambar atau PDF (khusus payment_proof), purpose dikirim bersama satu berkas. */
const FILE_MESSAGES: MultipartMessages = {
  tooLarge: "Berkas terlalu besar untuk keperluan ini. Gambar maksimal 5 MB, PDF maksimal 10 MB.",
  parserTooLarge: "Berkas terlalu besar. Gambar maksimal 5 MB, PDF maksimal 10 MB.",
  filesLimit: "Kirim satu berkas per unggahan.",
  partsLimit: "Isian unggahan terlalu banyak. Kirim purpose dan satu berkas.",
  notMultipart: "Kirim berkas sebagai multipart/form-data.",
  invalid: "Format unggahan tidak valid. Pilih berkas lalu coba lagi.",
};

/** If-None-Match (daftar, `*`, atau ETag lemah `W/"..."`) cocok dengan ETag kuat berkas. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const values = (Array.isArray(header) ? header.join(",") : header).split(",").map((v) => v.trim());
  return values.some((value) => value === "*" || value.replace(/^W\//, "") === etag);
}

function dispositionFor(file: FileRow): string {
  if (file.mime.startsWith("image/")) return "inline";
  // Nama unduhan aman tanpa PII: purpose + id + ekstensi kanonik.
  const extension = CANONICAL_EXTENSION[file.mime] ?? "bin";
  return `attachment; filename="${file.purpose}-${file.id}.${extension}"`;
}

/**
 * Berkas (PRD 2.5, 5.4, N-10): controller tipis di atas FilesService core (ARCHITECTURE §4.1, §4.2).
 * - POST /files: multipart `purpose` lalu `file`; hak unggah dan kuota diperiksa sebelum isi dibaca.
 * - GET /files/{fileId}/access: URL baca setelah kebijakan akses purpose.
 * - GET /files/content/{token}: isi berkas privat dengan token URL <= 10 menit; tidak pernah dicache publik.
 * - GET /files/public/{fileId}: berkas publik dengan cache publik + ETag.
 */
@Controller("files")
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @HttpCode(201)
  @Audience("any")
  @MemberAccess("nonsuspended")
  @RouteConfig({ multipart: true } satisfies MultipartRouteConfig)
  async upload(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentAuth() auth: AuthContext,
  ): Promise<FileRef> {
    let ticket: UploadTicket | null = null;
    let content: UploadContent | null = null;
    try {
      if (!request.isMultipart())
        throw multipartError({ code: "FST_INVALID_MULTIPART_CONTENT_TYPE" }, FILE_MESSAGES);
      const parts = request.parts()[Symbol.asyncIterator]();
      for (;;) {
        let step: IteratorResult<Multipart>;
        try {
          step = await parts.next();
        } catch (error) {
          throw multipartError(error, FILE_MESSAGES);
        }
        if (step.done) break;
        const part = step.value;
        if (part.type === "field") {
          // Field lain diabaikan (dibatasi limits.fields); purpose hanya sekali.
          if (part.fieldname !== "purpose") continue;
          if (ticket) throw fieldError("purpose", "Purpose hanya boleh dikirim sekali.");
          // Hanya purpose unggahan umum (FileUploadPurpose); cover/banner lewat endpoint domainnya (C4, C5).
          ticket = await this.files.beginUpload(auth, part.value, { allowed: GENERAL_UPLOAD_PURPOSES });
          continue;
        }
        if (part.fieldname !== "file") throw fieldError("file", "Kirim berkas pada field file.");
        if (!ticket) throw fieldError("purpose", "Kirim field purpose sebelum berkas.");
        content = {
          data: await readLimited(part.file, ticket.maxBytes, FILE_MESSAGES),
          filename: part.filename,
          declaredMime: part.mimetype,
        };
      }
    } catch (error) {
      // Sisa body tidak dibaca lagi: koneksi ditutup setelah respons galat agar unggahan besar tidak terus mengalir.
      void reply.header("connection", "close");
      throw error;
    }
    if (!ticket) throw fieldError("purpose", "Purpose berkas wajib diisi.");
    if (!content) throw fieldError("file", "Berkas wajib dikirim.");
    const file = await this.files.completeUpload(ticket, content);
    return this.files.toFileRef(file);
  }

  @Get(":fileId/access")
  @Audience("any")
  @MemberAccess("nonsuspended")
  @Header("cache-control", "no-store")
  async access(
    @Param("fileId", UuidParam) fileId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<FileAccess> {
    const grant = await this.files.accessFor(fileId, auth);
    return { url: grant.url, expires_at: grant.expiresAt?.toISOString() ?? null, mime: grant.mime };
  }

  @Get("content/:token")
  @Public()
  async content(
    @Param("token") token: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const { file, body } = await this.files.openContent(token);
    // PRD 5.4: cache publik/proxy tidak boleh menyimpan bukti, chat, atau ekspor.
    void reply.header("cache-control", "private, no-store");
    // Web admin di site yang sama (D12) boleh menampilkan gambar; isi tidak pernah dieksekusi sebagai dokumen.
    void reply.header("cross-origin-resource-policy", "same-site");
    void reply.header("content-security-policy", "default-src 'none'; sandbox");
    return new StreamableFile(body, {
      type: file.mime,
      length: file.bytes,
      disposition: dispositionFor(file),
    });
  }

  @Get("public/:fileId")
  @Public()
  async publicFile(
    @Param("fileId", UuidParam) fileId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile | undefined> {
    const etag = `"${(await this.files.publicMeta(fileId)).sha256}"`;
    void reply.header("etag", etag);
    void reply.header("cache-control", `public, max-age=${PUBLIC_MAX_AGE_SECONDS}`);
    // Situs publik dan aplikasi lain boleh menyematkan gambar publik.
    void reply.header("cross-origin-resource-policy", "cross-origin");
    void reply.header("content-security-policy", "default-src 'none'; sandbox");
    if (etagMatches(request.headers["if-none-match"], etag)) {
      void reply.status(304);
      return undefined;
    }
    const { file, body } = await this.files.openPublic(fileId);
    return new StreamableFile(body, { type: file.mime, length: file.bytes, disposition: "inline" });
  }
}
