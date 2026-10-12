import type { ErrorCode } from "@kapdh/contracts";

/** Galat domain dengan kode baku (PRD 5.2). Pesan aman untuk pengguna, tanpa detail internal. */
export class AppException extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: {
      fieldErrors?: Record<string, string[]>;
      retryAfterSeconds?: number;
      current?: unknown;
    } = {},
  ) {
    super(message);
  }
}
