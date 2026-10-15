import type { Multipart } from "@fastify/multipart";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { AppException, fieldError } from "../errors/app-exception.js";
import type { UploadContent, UploadTicket } from "./files.service.js";

/**
 * Pembantu bersama controller unggah multipart (POST /files, POST /admin/content/media, POST /admin/event-covers,
 * POST /admin/payment-qr-images; PRD 2.5, 5.2, N-10): galat parser busboy menjadi galat baku dan pembacaan stream
 * berbatas byte purpose. Pesan dapat disesuaikan per endpoint (gambar saja atau gambar/PDF).
 */
export interface MultipartMessages {
  /** 413: berkas melewati batas byte purpose (atau batas busboy global yang memotong stream). */
  tooLarge: string;
  /** 413: galat parser FST_REQ_FILE_TOO_LARGE; bawaan sama dengan `tooLarge`. */
  parserTooLarge?: string;
  /** 413: lebih dari satu berkas. */
  filesLimit: string;
  /** 413: bagian/field melebihi batas parser. */
  partsLimit: string;
  /** 415: body bukan multipart/form-data. */
  notMultipart: string;
  /** 400: bentuk multipart rusak, unggahan terputus, atau nama field terlarang. */
  invalid: string;
}

/** Pesan bawaan endpoint unggah satu gambar (cover event, gambar QRIS). */
export const IMAGE_UPLOAD_MESSAGES: MultipartMessages = {
  tooLarge: "Gambar terlalu besar. Maksimal 5 MB.",
  filesLimit: "Kirim satu gambar per unggahan.",
  partsLimit: "Isian unggahan terlalu banyak. Kirim satu gambar.",
  notMultipart: "Kirim gambar sebagai multipart/form-data.",
  invalid: "Format unggahan tidak valid. Pilih gambar lalu coba lagi.",
};

/** Galat parser multipart/busboy → galat baku (PRD 5.2); AppException diteruskan apa adanya. */
export function multipartError(
  error: unknown,
  messages: MultipartMessages = IMAGE_UPLOAD_MESSAGES,
): AppException {
  if (error instanceof AppException) return error;
  switch ((error as { code?: unknown } | null)?.code) {
    case "FST_REQ_FILE_TOO_LARGE":
      return new AppException(413, "FILE_INVALID", messages.parserTooLarge ?? messages.tooLarge);
    case "FST_FILES_LIMIT":
      return new AppException(413, "FILE_INVALID", messages.filesLimit);
    case "FST_PARTS_LIMIT":
    case "FST_FIELDS_LIMIT":
      return new AppException(413, "FILE_INVALID", messages.partsLimit);
    case "FST_INVALID_MULTIPART_CONTENT_TYPE":
      return new AppException(415, "FILE_INVALID", messages.notMultipart);
    default:
      return new AppException(400, "VALIDATION_ERROR", messages.invalid);
  }
}

/**
 * Membaca stream berkas sampai batas byte purpose; berhenti (dan menolak 413) begitu batas terlampaui (N-10). Batas
 * busboy global memotong stream tanpa galat pada iterasi (`truncated`), yang juga dianggap terlalu besar.
 */
export async function readLimited(
  stream: Readable & { truncated?: boolean },
  maxBytes: number,
  messages: MultipartMessages = IMAGE_UPLOAD_MESSAGES,
): Promise<Buffer> {
  const tooLarge = () => new AppException(413, "FILE_INVALID", messages.tooLarge);
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
    throw multipartError(error, messages);
  }
  if (stream.truncated) throw tooLarge();
  return Buffer.concat(chunks, total);
}

/**
 * Unggahan satu gambar pada field `file` untuk endpoint domain yang purpose-nya tetap (cover event, gambar QRIS):
 * `begin` (FilesService.beginUpload: hak unggah, batas percobaan, kuota) dijalankan SEBELUM isi dibaca; field lain
 * diabaikan; lebih dari satu berkas → 413. Bila gagal, koneksi ditutup setelah respons galat karena sisa body tidak
 * dibaca lagi. `missingMessage` dipakai bila tidak ada berkas (400 pada `file`).
 */
export async function receiveSingleImage(
  request: FastifyRequest,
  reply: FastifyReply,
  begin: () => Promise<UploadTicket>,
  missingMessage: string,
  messages: MultipartMessages = IMAGE_UPLOAD_MESSAGES,
): Promise<{ ticket: UploadTicket; content: UploadContent }> {
  let ticket: UploadTicket | null = null;
  let content: UploadContent | null = null;
  try {
    if (!request.isMultipart())
      throw multipartError({ code: "FST_INVALID_MULTIPART_CONTENT_TYPE" }, messages);
    ticket = await begin();
    const parts = request.parts()[Symbol.asyncIterator]();
    for (;;) {
      let step: IteratorResult<Multipart>;
      try {
        step = await parts.next();
      } catch (error) {
        throw multipartError(error, messages);
      }
      if (step.done) break;
      const part = step.value;
      if (part.type === "field") continue;
      if (part.fieldname !== "file") throw fieldError("file", "Kirim gambar pada field file.");
      if (content) throw multipartError({ code: "FST_FILES_LIMIT" }, messages);
      content = {
        data: await readLimited(part.file, ticket.maxBytes, messages),
        filename: part.filename,
        declaredMime: part.mimetype,
      };
    }
  } catch (error) {
    // Sisa body tidak dibaca lagi: koneksi ditutup setelah respons galat.
    void reply.header("connection", "close");
    throw error;
  }
  if (!ticket || !content) throw fieldError("file", missingMessage);
  return { ticket, content };
}
