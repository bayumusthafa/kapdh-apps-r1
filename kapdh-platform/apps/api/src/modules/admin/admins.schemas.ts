import { PERMISSION_VALUES } from "@kapdh/contracts";
import { z } from "zod";

/** Skema masukan domain admin-admins (kontrak C7, F-16). Pesan galat Bahasa Indonesia untuk field_errors. */

const permission = z.enum(PERMISSION_VALUES, { message: "Izin tidak dikenal" });
const permissions = z
  .array(permission, { message: "Daftar izin wajib berupa larik" })
  .max(15, "Maksimal 15 izin")
  .refine((list) => new Set(list).size === list.length, "Izin tidak boleh ganda");
const role = z.enum(["super_admin", "admin"], { message: "Peran tidak dikenal" });
const email = z.email("Email tidak valid").max(254, "Maksimal 254 karakter");
const displayName = z
  .string({ message: "Nama tampilan wajib diisi" })
  .trim()
  .min(1, "Nama tampilan wajib diisi")
  .max(120, "Maksimal 120 karakter");
const reason = z
  .string({ message: "Alasan wajib berupa teks" })
  .trim()
  .min(3, "Alasan minimal 3 karakter")
  .max(500, "Maksimal 500 karakter");

export const InviteSchema = z.object({
  alumni_user_id: z.uuid("Id alumni tidak valid").optional(),
  email: email.optional(),
  display_name: displayName.optional(),
  role,
  permissions,
});

export const UpdateSchema = z.object({
  display_name: displayName.optional(),
  email: email.optional(),
  role: role.optional(),
  permissions: permissions.optional(),
  status: z.enum(["active", "disabled"], { message: "Status hanya active atau disabled" }).optional(),
  reason: reason.optional(),
});

export const RecoverySchema = z.object({
  reason,
  email: email.optional(),
});

export const ListQuerySchema = z.object({
  q: z.string().trim().min(1, "Minimal 1 karakter").max(100, "Maksimal 100 karakter").optional(),
  role: role.optional(),
  status: z.enum(["invited", "active", "disabled"], { message: "Status tidak dikenal" }).optional(),
  permission: permission.optional(),
  sort: z
    .enum(["display_name_asc", "created_at_desc", "last_login_at_desc"], { message: "Urutan tidak dikenal" })
    .optional(),
});

export const CandidateQuerySchema = z.object({
  q: z.string().trim().min(1, "Minimal 1 karakter").max(100, "Maksimal 100 karakter").optional(),
});

/**
 * Cursor daftar admin: posisi urutan aktif + id. `v` divalidasi per urutan sehingga cursor rusak/dimanipulasi menjadi
 * 400 VALIDATION_ERROR (decodeCursor), bukan 500: nama (teks) untuk display_name_asc, waktu ISO untuk created_at_desc,
 * dan waktu ISO atau null (belum pernah login) untuk last_login_at_desc.
 */
const isoInstant = z.iso.datetime({ offset: true });
export const AdminCursorSchema = z.discriminatedUnion("sort", [
  z.object({ sort: z.literal("display_name_asc"), v: z.string().max(200), id: z.uuid() }),
  z.object({ sort: z.literal("created_at_desc"), v: isoInstant, id: z.uuid() }),
  z.object({ sort: z.literal("last_login_at_desc"), v: z.union([isoInstant, z.null()]), id: z.uuid() }),
]);

export const CandidateCursorSchema = z.object({ created_at: z.coerce.date(), id: z.uuid() });
