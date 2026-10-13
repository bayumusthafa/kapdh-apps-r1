import { z } from "zod";
import { AppException } from "../errors/app-exception.js";

/** Mengubah issue zod menjadi field_errors berkunci path bertitik (`_` untuk akar), PRD 5.2. */
export function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/** Validasi body dengan zod 4; galat menjadi 400 VALIDATION_ERROR dengan field_errors (PRD 5.2). */
export function validate<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
    fieldErrors: fieldErrorsOf(parsed.error),
  });
}

/**
 * Validasi query string. Nilai query selalu string (atau array bila parameter berulang), jadi skema memakai helper
 * koersi di bawah (`queryInt`, `queryBool`, `queryList`). Parameter tak dikenal diabaikan kecuali skema `strict()`.
 */
export function validateQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  const parsed = schema.safeParse(query ?? {});
  if (parsed.success) return parsed.data;
  throw new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
    fieldErrors: fieldErrorsOf(parsed.error),
  });
}

/** Bilangan bulat dari query string (`?limit=30`). */
export const queryInt = (options: { min?: number; max?: number } = {}) => {
  let schema = z.coerce.number({ message: "Harus berupa angka" }).int("Harus bilangan bulat");
  if (options.min !== undefined) schema = schema.min(options.min, `Minimal ${options.min}`);
  if (options.max !== undefined) schema = schema.max(options.max, `Maksimal ${options.max}`);
  return schema;
};

/** Boolean dari query string: true/false/1/0. */
export const queryBool = () =>
  z
    .enum(["true", "false", "1", "0"], { message: "Gunakan true atau false" })
    .transform((v) => v === "true" || v === "1");

/** Daftar dari query berulang (`?status=a&status=b`) atau dipisah koma (`?status=a,b`). */
export const queryList = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter((s) => s.length > 0))
    .pipe(z.array(item));

/** Format UUID RFC 9562 (semua versi). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
