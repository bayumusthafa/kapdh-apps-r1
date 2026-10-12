import { z } from "zod";
import { MONEY_MAX_INTEGER_DIGITS } from "./format";

/**
 * Skema zod bersama untuk pra-validasi formulir admin. Server tetap sumber kebenaran (ARCHITECTURE §2.1);
 * pesan di sini hanya membantu admin sebelum mengirim.
 */

/** `Money` desimal string "60000.00" (numeric(14,2), tidak negatif). */
export const moneySchema = z
  .string()
  .min(1, "Nominal wajib diisi.")
  .regex(new RegExp(`^\\d{1,${MONEY_MAX_INTEGER_DIGITS}}\\.\\d{2}$`), "Nominal tidak valid. Contoh: 60.000");

/** Teks wajib yang tidak boleh hanya spasi. */
export const requiredText = (label: string, min = 1, max = 500) =>
  z
    .string()
    .trim()
    .min(min, min <= 1 ? `${label} wajib diisi.` : `${label} minimal ${min} karakter.`)
    .max(max, `${label} maksimal ${max} karakter.`);

/** ISO 8601 UTC dari DateTimeField (null = belum diisi). */
export const isoDateTimeSchema = z
  .string({ error: "Tanggal dan jam wajib diisi." })
  .pipe(z.iso.datetime({ offset: true, error: "Tanggal dan jam tidak valid." }));

export const emailSchema = z
  .string()
  .trim()
  .min(1, "Email wajib diisi.")
  .max(254, "Email terlalu panjang.")
  .pipe(z.email({ error: "Format email tidak valid." }));
