import { z } from "zod";

/**
 * Skema body objek ketat dengan pesan Bahasa Indonesia (ARCHITECTURE §2.9, PRD 5.2 field_errors): kolom tak dikenal dan
 * body yang bukan objek JSON tidak memakai pesan bawaan zod berbahasa Inggris. Pesan kolom diatur skema kolomnya.
 */
export function strictBody<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code === "unrecognized_keys") return `Kolom tidak dikenal: ${issue.keys.join(", ")}`;
      if (issue.code === "invalid_type") return "Body harus berupa objek JSON";
      return undefined;
    },
  });
}

/** Teks filter query: wajib berisi bila dikirim, satu nilai (parameter berulang ditolak), panjang dibatasi. */
export function queryText(max: number) {
  return z
    .string({ message: "Harus berupa satu nilai teks" })
    .min(1, "Wajib diisi bila dikirim")
    .max(max, `Maksimal ${max} karakter`);
}

/** Daftar id UUID unik (1–100) untuk body; id dinormalkan huruf kecil. */
export function uuidList(field: string) {
  return z
    .array(z.uuid({ message: "Format id tidak valid" }), { message: "Harus berupa daftar id" })
    .min(1, "Minimal satu id")
    .max(100, "Maksimal 100 id")
    .refine(
      (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
      `${field} tidak boleh berulang`,
    );
}
