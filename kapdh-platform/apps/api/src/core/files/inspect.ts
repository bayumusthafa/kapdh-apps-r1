import { fileTypeFromBuffer } from "file-type";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { type FileKind, type FilePurposeSpec, maxBytesFor } from "./purposes.js";

/**
 * Pemeriksaan isi unggahan (PRD 2.5, N-10): tipe dari magic bytes (bukan ekstensi/Content-Type klien), ekstensi yang
 * menyamarkan tipe ditolak, ukuran per jenis, gambar didekode aman (batas piksel melawan decompression bomb), diputar
 * sesuai orientasi EXIF lalu di-encode ulang sehingga EXIF/GPS/XMP/ICC terbuang, dan PDF berkonten aktif ditolak.
 */

/** Batas piksel input (lebar x tinggi) sebelum dekode; mencegah decompression bomb. */
export const MAX_INPUT_PIXELS = 40_000_000;
/** Batas satu sisi gambar. */
export const MAX_IMAGE_DIMENSION = 12_000;

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
type ImageMime = (typeof IMAGE_MIMES)[number];

/** Ekstensi nama berkas yang konsisten dengan tipe hasil deteksi. */
const EXTENSIONS: Record<string, readonly string[]> = {
  "image/jpeg": ["jpg", "jpeg", "jfif", "jpe"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
};

/** Alias Content-Type klien yang dianggap sama dengan tipe hasil deteksi. */
const MIME_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg" };

/** Ekstensi kanonik untuk nama unduhan aman. */
export const CANONICAL_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/csv": "csv",
};

export class FileRejectedError extends Error {
  constructor(
    readonly status: 413 | 415 | 422,
    message: string,
  ) {
    super(message);
    this.name = "FileRejectedError";
  }
}

export interface InspectInput {
  data: Buffer;
  spec: FilePurposeSpec;
  /** Nama berkas dari klien (hanya untuk cek ekstensi; tidak pernah disimpan). */
  filename?: string | null;
  /** Content-Type bagian multipart dari klien (hanya untuk cek penyamaran). */
  declaredMime?: string | null;
}

export interface ProcessedFile {
  data: Buffer;
  mime: string;
  kind: FileKind;
  width: number | null;
  height: number | null;
}

function kindOf(mime: string): FileKind | null {
  if ((IMAGE_MIMES as readonly string[]).includes(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  return null;
}

function assertNotDisguised(mime: string, filename?: string | null, declaredMime?: string | null): void {
  const name = (filename ?? "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    const extension = name.slice(dot + 1);
    if (!EXTENSIONS[mime]!.includes(extension))
      throw new FileRejectedError(415, "Ekstensi berkas tidak sesuai dengan isinya.");
  }
  const declared = (declaredMime ?? "").split(";")[0]!.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && (MIME_ALIASES[declared] ?? declared) !== mime)
    throw new FileRejectedError(415, "Tipe berkas yang dikirim tidak sesuai dengan isinya.");
}

async function processImage(data: Buffer, mime: ImageMime): Promise<ProcessedFile> {
  const options = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" as const, pages: 1 };
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await sharp(data, options).metadata());
  } catch {
    throw new FileRejectedError(422, "Gambar rusak atau tidak dapat dibaca.");
  }
  if (
    !width ||
    !height ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_INPUT_PIXELS
  )
    throw new FileRejectedError(422, "Dimensi gambar terlalu besar atau tidak valid.");
  try {
    // rotate() tanpa argumen = orientasi EXIF diterapkan ke piksel; tanpa keepMetadata/withMetadata, sharp tidak
    // menyalin EXIF (termasuk GPS), XMP, IPTC, maupun ICC ke keluaran.
    let pipeline = sharp(data, options).rotate();
    pipeline =
      mime === "image/jpeg"
        ? pipeline.jpeg({ quality: 85, mozjpeg: true })
        : mime === "image/png"
          ? pipeline.png({ compressionLevel: 9 })
          : pipeline.webp({ quality: 85 });
    const { data: output, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { data: output, mime, kind: "image", width: info.width, height: info.height };
  } catch {
    throw new FileRejectedError(422, "Gambar rusak atau tidak dapat diproses.");
  }
}

/** Nama PDF yang menandai konten aktif/tersemat (setelah escape `#xx` pada nama dinormalkan). */
const ACTIVE_PDF_NAMES =
  /\/(JavaScript|JS|Launch|EmbeddedFile|EmbeddedFiles|RichMedia|XFA|GoToE|SubmitForm|ImportData)(?=[\s/<>[\]()%{}]|$)/;

/** Batas total isi stream PDF yang didekompresi saat pemeriksaan (melawan "zip bomb" di dalam PDF). */
export const MAX_PDF_INFLATED_BYTES = 32 * 1024 * 1024;

function hasActiveNames(latin1: string): boolean {
  return ACTIVE_PDF_NAMES.test(
    latin1.replace(/#([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
  );
}

/**
 * Isi stream terkompresi Flate (termasuk object stream PDF 1.5+ yang dapat menyembunyikan kamus /JavaScript) dibuka
 * dengan batas total {@link MAX_PDF_INFLATED_BYTES}; melebihi batas → ditolak. Stream yang bukan Flate atau rusak
 * dilewati (tidak dapat memuat kamus aktif yang dibaca penampil PDF).
 */
function inflatedStreams(data: Buffer): string[] {
  const text = data.toString("latin1");
  const result: string[] = [];
  let budget = MAX_PDF_INFLATED_BYTES;
  const marker = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    if (text.slice(Math.max(0, match.index - 3), match.index) === "end") continue;
    const start = match.index + match[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    marker.lastIndex = end + "endstream".length;
    let inflated: Buffer;
    try {
      inflated = inflateSync(data.subarray(start, end), { maxOutputLength: Math.max(1, budget) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
        throw new FileRejectedError(
          422,
          "PDF terlalu kompleks untuk diperiksa. Kirim PDF lain atau foto bukti.",
        );
      continue;
    }
    budget -= inflated.byteLength;
    result.push(inflated.toString("latin1"));
  }
  return result;
}

function inspectPdf(data: Buffer): ProcessedFile {
  const head = data.subarray(0, 16).toString("latin1");
  if (!/^%PDF-(1\.[0-7]|2\.0)/.test(head)) throw new FileRejectedError(422, "PDF rusak atau tidak valid.");
  const tail = data.subarray(Math.max(0, data.length - 2048)).toString("latin1");
  if (!tail.includes("%%EOF")) throw new FileRejectedError(422, "PDF rusak atau tidak lengkap.");
  if (hasActiveNames(data.toString("latin1")) || inflatedStreams(data).some(hasActiveNames))
    throw new FileRejectedError(
      422,
      "PDF berisi skrip atau lampiran yang tidak diizinkan. Kirim PDF biasa atau foto.",
    );
  return { data, mime: "application/pdf", kind: "pdf", width: null, height: null };
}

/** Memeriksa dan memproses isi sesuai aturan purpose. Melempar {@link FileRejectedError} (413/415/422). */
export async function inspectUpload(input: InspectInput): Promise<ProcessedFile> {
  const { data, spec } = input;
  if (data.length === 0) throw new FileRejectedError(422, "Berkas kosong.");
  const detected = await fileTypeFromBuffer(data);
  const kind = detected ? kindOf(detected.mime) : null;
  if (!detected || !kind)
    throw new FileRejectedError(415, "Tipe berkas tidak didukung. Gunakan JPG, PNG, atau WebP.");
  if (!spec.kinds.includes(kind))
    throw new FileRejectedError(
      415,
      kind === "pdf"
        ? "PDF hanya diperbolehkan untuk bukti pembayaran."
        : "Tipe berkas tidak didukung untuk keperluan ini.",
    );
  if (data.length > maxBytesFor(kind))
    throw new FileRejectedError(413, kind === "pdf" ? "PDF maksimal 10 MB." : "Gambar maksimal 5 MB.");
  assertNotDisguised(detected.mime, input.filename, input.declaredMime);
  return kind === "image" ? processImage(data, detected.mime as ImageMime) : inspectPdf(data);
}
