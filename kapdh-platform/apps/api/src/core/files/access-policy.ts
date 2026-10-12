import type { Permission } from "@kapdh/contracts";
import type { files } from "@kapdh/database";
import type { DbOrTx } from "../db/types.js";
import type { AuthContext } from "../guards/auth-context.js";

export type FileRow = typeof files.$inferSelect;

/**
 * Penampil berkas = AuthContext request (sesi mobile atau admin). Diteruskan apa adanya dari `@CurrentAuth()`.
 */
export type FileViewer = Pick<
  AuthContext,
  | "userId"
  | "sessionId"
  | "sessionVersion"
  | "audience"
  | "adminId"
  | "adminRole"
  | "permissions"
  | "effectiveStatus"
>;

export interface FileAccessRequest {
  file: FileRow;
  viewer: FileViewer;
  /** Koneksi untuk kueri kebijakan (mis. keanggotaan room chat). */
  db: DbOrTx;
}

/**
 * Kebijakan akses per purpose (PRD 2.5, 5.4; N-09): true bila penampil boleh membuka isi berkas privat. Kebijakan yang
 * terdaftar untuk satu purpose digabung OR; tanpa kebijakan yang mengizinkan = ditolak (404, tidak membedakan "tidak
 * ada" dan "tidak berhak").
 */
export type FileAccessPolicy = (request: FileAccessRequest) => boolean | Promise<boolean>;

/** Pembangun kebijakan umum untuk didaftarkan modul lewat `FilesService.registerAccessPolicy`. */
export const FilePolicies = {
  /** Pemilik (pengunggah) berkas. */
  owner:
    (): FileAccessPolicy =>
    ({ file, viewer }) =>
      file.ownerUserId !== null && file.ownerUserId === viewer.userId,

  /** Sesi admin yang memiliki SEMUA izin (dievaluasi dari database per request oleh AuthGuard). */
  adminPermission:
    (...permissions: [Permission, ...Permission[]]): FileAccessPolicy =>
    ({ viewer }) =>
      viewer.audience === "admin" && permissions.every((permission) => viewer.permissions.has(permission)),

  /** Sesi admin berperan Super Admin (dibaca dari database per request oleh AuthGuard). */
  superAdmin:
    (): FileAccessPolicy =>
    ({ viewer }) =>
      viewer.audience === "admin" && viewer.adminRole === "super_admin",

  /** Semua kebijakan harus mengizinkan. */
  allOf:
    (...policies: FileAccessPolicy[]): FileAccessPolicy =>
    async (request) => {
      for (const policy of policies) if (!(await policy(request))) return false;
      return policies.length > 0;
    },

  /** Salah satu kebijakan mengizinkan. */
  anyOf:
    (...policies: FileAccessPolicy[]): FileAccessPolicy =>
    async (request) => {
      for (const policy of policies) if (await policy(request)) return true;
      return false;
    },
};
