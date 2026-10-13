import { checkPassword } from "@kapdh/shared";
import { z } from "zod";

/** Pesan aturan sandi PRD 2.5 (batas dalam byte UTF-8, bukan karakter). */
export const PASSWORD_RULE_MESSAGE =
  "Password 8 sampai 72 byte dengan huruf besar, huruf kecil, angka, dan simbol.";

/**
 * Sandi baru (kontrak `Password`; PRD 2.5): 8..72 byte UTF-8 dengan huruf besar, kecil, angka dan simbol. Sandi lebih
 * dari 72 byte ditolak, tidak dipotong bcrypt. Dipakai registrasi, reset, dan ganti sandi.
 */
export const passwordRuleSchema = z
  .string()
  .max(256, PASSWORD_RULE_MESSAGE)
  .refine((value) => checkPassword(value).valid, { message: PASSWORD_RULE_MESSAGE });
