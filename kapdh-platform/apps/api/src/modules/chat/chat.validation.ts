import { z } from "zod";
import { isUuid } from "../../core/validation/validate.js";

/** UUID dari klien (semua versi RFC 9562), dinormalkan huruf kecil; galat menjadi field_errors (PRD 5.2). */
export const uuidField = z
  .string({ message: "Wajib berupa UUID" })
  .refine(isUuid, "Format id tidak valid")
  .transform((value) => value.toLowerCase());
