import { type ArgumentMetadata, Injectable, type PipeTransform } from "@nestjs/common";
import { AppException } from "../errors/app-exception.js";
import { isUuid } from "./validate.js";

/**
 * Pipe parameter path UUID: `@Param("paymentId", UuidParam) id: string`. Nilai bukan UUID tidak pernah mencapai SQL
 * (sebelumnya PostgreSQL menolak 22P02 → 500 dan parameter bocor ke log). Hasilnya 404 NOT_FOUND karena objek dengan
 * id itu memang tidak mungkin ada, dan respons tidak membedakan "tidak ada" dari "tidak berhak" (N-09).
 */
@Injectable()
export class UuidParam implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (isUuid(value)) return value.toLowerCase();
    throw new AppException(404, "NOT_FOUND", "Data tidak ditemukan.");
  }
}

/** Seperti {@link UuidParam} tetapi 400 VALIDATION_ERROR (untuk id yang dikirim sebagai masukan, bukan sumber daya). */
@Injectable()
export class UuidParamOrValidationError implements PipeTransform<unknown, string> {
  transform(value: unknown, metadata: ArgumentMetadata): string {
    if (isUuid(value)) return value.toLowerCase();
    throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
      fieldErrors: { [metadata.data ?? "id"]: ["Format id tidak valid"] },
    });
  }
}
