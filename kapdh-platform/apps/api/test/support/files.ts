import type { Permission } from "@kapdh/contracts";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import type { FileRow } from "../../src/core/files/access-policy.js";
import type { FilePurpose } from "../../src/core/files/purposes.js";
import { FilesService } from "../../src/core/files/files.service.js";

/**
 * Helper unggahan berkas untuk uji modul (ARCHITECTURE §9.1): body multipart, gambar/PDF sintetis, dan unggah lewat
 * POST /files. Contoh di uji pembayaran:
 *
 *   const proof = await uploadTestFile(t, session.accessToken, "payment_proof");
 *   await api.post(`/me/payments/${id}/proof`, { file_id: proof.id, ... }, { token });
 */

export type MultipartPart =
  { name: string; value: string } | { name: string; filename: string; contentType: string; data: Buffer };

/** Body multipart/form-data mentah (urutan bagian dipertahankan) beserta header Content-Type-nya. */
export function multipartBody(parts: MultipartPart[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----kapdh-uji-${uuidv7()}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ("data" in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
        ),
        part.data,
        Buffer.from("\r\n"),
      );
    } else {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** JPEG sintetis berukuran lebar x tinggi, opsional dengan EXIF orientasi + metadata pribadi (uji pembuangan EXIF). */
export async function testJpeg(
  options: { width?: number; height?: number; orientation?: number; withPrivateExif?: boolean } = {},
): Promise<Buffer> {
  let image = sharp({
    create: {
      width: options.width ?? 64,
      height: options.height ?? 32,
      channels: 3,
      background: { r: 200, g: 30, b: 30 },
    },
  }).jpeg({ quality: 90 });
  if (options.withPrivateExif)
    image = image.withExif({ IFD0: { Copyright: "Data pribadi uji", Artist: "Nama Pemotret Uji" } });
  if (options.orientation) image = image.withMetadata({ orientation: options.orientation });
  return image.toBuffer();
}

export async function testPng(width = 48, height = 48): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 10, g: 120, b: 60, alpha: 1 } } })
    .png()
    .toBuffer();
}

/**
 * PDF minimal yang sah (header, objek, trailer, %%EOF). Varian yang harus ditolak:
 * - `active`: aksi JavaScript terbaca langsung;
 * - `hiddenActive`: aksi JavaScript di dalam object stream terkompresi Flate (PDF 1.5+);
 * - `inflateBomb`: stream Flate kecil yang mengembang > 32 MB.
 * `compressedContent` menambahkan stream Flate biasa (harus tetap diterima).
 */
export function testPdf(
  options: {
    active?: boolean;
    hiddenActive?: boolean;
    inflateBomb?: boolean;
    compressedContent?: boolean;
  } = {},
): Buffer {
  const action = options.active ? "/OpenAction << /S /JavaScript /JS (app.alert(1)) >>" : "";
  const streams: Buffer[] = [];
  const streamObject = (id: number, payload: Buffer, dict: string) => {
    const deflated = deflateSync(payload);
    streams.push(
      Buffer.from(
        `${id} 0 obj\n<< ${dict} /Filter /FlateDecode /Length ${deflated.length} >>\nstream\n`,
        "latin1",
      ),
      deflated,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    );
  };
  if (options.hiddenActive)
    streamObject(
      3,
      Buffer.from("4 0 << /S /JavaScript /JS (app.alert(1)) >>", "latin1"),
      "/Type /ObjStm /N 1 /First 4",
    );
  if (options.inflateBomb) streamObject(5, Buffer.alloc(40 * 1024 * 1024), "");
  if (options.compressedContent)
    streamObject(6, Buffer.from("BT /F1 12 Tf 72 712 Td (Bukti transfer) Tj ET"), "");
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${action}>>\nendobj\n` +
        "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n",
      "latin1",
    ),
    ...streams,
    Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * "Decompression bomb": berkas PNG ratusan byte yang mengklaim dimensi sangat besar (header IHDR). Server wajib
 * menolak sebelum mendekode piksel (PRD 2.5).
 */
export function testPngBomb(width = 30_000, height = 30_000): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(0, 9); // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface UploadOptions {
  data?: Buffer;
  filename?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/** POST /api/v1/files multipart (purpose lalu file) dengan token Bearer; mengembalikan respons mentah inject. */
export async function postFile(
  app: NestFastifyApplication,
  token: string | null,
  purpose: string,
  options: UploadOptions = {},
) {
  const data = options.data ?? (await testJpeg());
  const body = multipartBody([
    { name: "purpose", value: purpose },
    {
      name: "file",
      filename: options.filename ?? "foto.jpg",
      contentType: options.contentType ?? "image/jpeg",
      data,
    },
  ]);
  return app.inject({
    method: "POST",
    url: "/api/v1/files",
    payload: body.payload,
    headers: { ...body.headers, ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
}

/** Unggah berkas uji yang wajib berhasil (201); mengembalikan FileRef. */
export async function uploadTestFile(
  t: { app: NestFastifyApplication },
  token: string,
  purpose: string,
  options: UploadOptions = {},
): Promise<{ id: string; purpose: string; mime: string; visibility: string; public_url: string | null }> {
  const res = await postFile(t.app, token, purpose, options);
  expect(res.statusCode, `unggah ${purpose}: ${res.body}`).toBe(201);
  return res.json();
}

/**
 * Unggahan lewat FilesService untuk purpose yang punya endpoint unggah domain sendiri (post_cover/banner_image lewat
 * POST /admin/content/media, event_cover lewat POST /admin/event-covers). Pemeriksaan hak, isi dan kuota sama dengan
 * POST /files; dipakai uji core sampai modul domain menyediakan endpoint-nya.
 */
export async function uploadDomainFile(
  t: { app: NestFastifyApplication },
  admin: { userId: string; permissions: readonly Permission[] },
  purpose: FilePurpose,
  options: UploadOptions = {},
): Promise<FileRow> {
  return t.app.get(FilesService).upload({
    uploader: {
      userId: admin.userId,
      audience: "admin",
      permissions: new Set(admin.permissions),
      effectiveStatus: null,
    },
    purpose,
    data: options.data ?? (await testJpeg()),
    filename: options.filename ?? "gambar.jpg",
    declaredMime: options.contentType ?? "image/jpeg",
  });
}
