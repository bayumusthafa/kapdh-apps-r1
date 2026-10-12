import type { z } from "zod";
import { AppException } from "./app-exception.js";

/** Validasi body dengan zod; galat menjadi VALIDATION_ERROR dengan field_errors (PRD 5.2). */
export function validate<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.join(".") || "_";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", { fieldErrors });
}
