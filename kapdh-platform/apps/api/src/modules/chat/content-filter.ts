/**
 * Filter dasar konten berbahaya untuk teks chat dan nama grup (PRD 3.12: "filter dasar konten berbahaya ... wajib
 * tersedia sebelum chat dibuka"; kontrak sendChatMessage: dapat menolak isi dengan 400 VALIDATION_ERROR pada field
 * body). Filter ini sengaja sempit dan deterministik, hanya menolak isi yang tidak pernah sah dalam percakapan:
 * - karakter kendali biner (selain baris baru dan tab) yang dapat merusak tampilan atau log;
 * - karakter pengubah arah teks bidi (U+202A..U+202E, U+2066..U+2069) yang dipakai untuk menyamarkan tautan/nama
 *   ("trojan source" dan spoofing nama berkas);
 * - tautan berskema berbahaya (javascript:, vbscript:, data: HTML/skrip) yang dapat mengeksekusi kode bila dibuka.
 * Penilaian isi yang lebih luas (kata kasar, ujaran kebencian) dilakukan lewat laporan dan moderasi pengurus (F-12)
 * sesuai pedoman moderasi UGC toko aplikasi; daftar kata tidak dibuat tanpa keputusan pengurus.
 */

// eslint-disable-next-line no-control-regex -- sengaja mencocokkan karakter kendali biner.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/;
const DANGEROUS_LINK =
  /(?:^|[\s<("'[])(?:javascript|vbscript):\S|data:\s*(?:text\/html|text\/javascript|application\/(?:x-)?javascript)/i;

export const HARMFUL_CONTENT_MESSAGE =
  "Pesan memuat karakter kendali atau tautan berbahaya yang tidak diizinkan. Hapus bagian itu lalu kirim ulang.";

/** null bila isi aman; selain itu pesan galat untuk field_errors. */
export function harmfulContentReason(text: string): string | null {
  if (CONTROL_CHARS.test(text) || BIDI_CONTROLS.test(text) || DANGEROUS_LINK.test(text))
    return HARMFUL_CONTENT_MESSAGE;
  return null;
}

/** Jumlah karakter (code point) seperti char_length PostgreSQL dan maxLength JSON Schema. */
export function charLength(text: string): number {
  return Array.from(text).length;
}

/** Potongan pratinjau maksimal `max` code point tanpa memotong pasangan surrogate. */
export function previewOf(text: string | null, max: number): string | null {
  if (text === null) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  const chars = [...normalized];
  return chars.length <= max ? normalized : `${chars.slice(0, max - 1).join("")}…`;
}
