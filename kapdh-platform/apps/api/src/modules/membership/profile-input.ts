import { z } from "zod";
import { AppException } from "../../core/errors/app-exception.js";
import { isUuid } from "../../core/validation/validate.js";

/**
 * Validasi masukan profil (kontrak me.yaml ProfileUpdate, admin-members.yaml AdminMemberUpdate). Server memeriksa
 * ulang semua aturan kontrak dan tidak bergantung pada klien (PRD 2.1, N-09).
 */

/**
 * Aturan tunggal SocialHandle (kontrak me.yaml): nama pengguna (huruf, angka, titik, garis bawah, tanda hubung; @ di
 * depan opsional) atau URL `https://` dengan nama host. Skema lain (javascript:, data:, http:, mailto:), spasi dan
 * karakter <>"'` ditolak (N-09, N-14).
 */
export const SOCIAL_HANDLE_PATTERN =
  /^(?:@?[A-Za-z0-9._-]{1,100}|https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[/?#][^\s<>"'`]*)?)$/;
/** Pola telepon kontrak ProfileUpdate.phone. */
export const PHONE_PATTERN = /^\+?[0-9][0-9 -]{5,22}$/;

/** Nilai tersimpan SocialHandle: @ di depan nama pengguna dibuang; URL https disimpan apa adanya. */
export function normalizeSocialHandle(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

const socialHandle = z
  .string()
  .min(1, "Wajib diisi atau kosongkan dengan null")
  .max(200, "Maksimal 200 karakter")
  .regex(SOCIAL_HANDLE_PATTERN, "Gunakan nama pengguna atau tautan https:// yang valid")
  .transform(normalizeSocialHandle);

const nullableSocial = z.union([socialHandle, z.null()]);

const uuid = z
  .string()
  .refine((value) => isUuid(value), "Format id tidak valid")
  .transform((value) => value.toLowerCase());

/** Teks opsional yang dirapikan; kosong setelah dirapikan ditolak (minLength 1 kontrak). */
const trimmedText = (max: number) =>
  z.string().trim().min(1, "Wajib diisi atau kosongkan dengan null").max(max, `Maksimal ${max} karakter`);

const phone = z.union([
  z
    .string()
    .trim()
    .max(24, "Maksimal 24 karakter")
    .regex(PHONE_PATTERN, "Nomor telepon hanya angka, spasi, tanda hubung, dan + di depan"),
  z.null(),
]);

/** bio: kosong setelah dirapikan berarti dikosongkan (null). */
const bio = z.union([
  z
    .string()
    .max(500, "Maksimal 500 karakter")
    .transform((value) => (value.trim().length === 0 ? null : value.trim())),
  z.null(),
]);

const skillIds = z
  .array(uuid)
  .max(10, "Maksimal 10 keahlian")
  .refine((ids) => new Set(ids).size === ids.length, "Keahlian tidak boleh ganda");

const privacyUpdate = z
  .object({
    show_in_directory: z.boolean(),
    show_phone: z.boolean(),
    show_email: z.boolean(),
    show_social: z.boolean(),
  })
  .partial()
  .strict();

/** Field profil umum yang sama untuk profil sendiri dan koreksi pengurus. */
const commonProfileFields = {
  phone,
  bio,
  last_education_institution: z.union([trimmedText(120), z.null()]),
  last_education_city: z.union([trimmedText(80), z.null()]),
  social_instagram: nullableSocial,
  social_x: nullableSocial,
  social_facebook: nullableSocial,
  social_linkedin: nullableSocial,
  profession_id: z.union([uuid, z.null()]),
  skill_ids: skillIds,
};

/** PATCH /me/profile (ProfileUpdate): field yang tidak dikirim tidak berubah; null mengosongkan. */
export const profileUpdateSchema = z
  .object({
    city: trimmedText(80),
    ...commonProfileFields,
    avatar_file_id: z.union([uuid, z.null()]),
    privacy: privacyUpdate,
  })
  .partial();

export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

/** PATCH /admin/members/{userId} (AdminMemberUpdate): reason wajib, koreksi identitas, tanpa email/privasi/nomor. */
export const adminMemberUpdateSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Alasan minimal 3 karakter dan tidak boleh hanya spasi")
    .max(500, "Maksimal 500 karakter"),
  full_name: z.string().trim().min(2, "Nama minimal 2 karakter").max(120, "Maksimal 120 karakter").optional(),
  gender: z.enum(["male", "female"], { message: "Jenis kelamin tidak valid" }).optional(),
  cohort: z.number().int("Angkatan harus bilangan bulat").min(1).max(99).optional(),
  class_in: z.number().int().min(1, "Kelas 1 sampai 6").max(6, "Kelas 1 sampai 6").optional(),
  class_out: z.number().int().min(1, "Kelas 1 sampai 6").max(6, "Kelas 1 sampai 6").optional(),
  city: z.union([trimmedText(80), z.null()]).optional(),
  phone: commonProfileFields.phone.optional(),
  bio: commonProfileFields.bio.optional(),
  last_education_institution: commonProfileFields.last_education_institution.optional(),
  last_education_city: commonProfileFields.last_education_city.optional(),
  social_instagram: nullableSocial.optional(),
  social_x: nullableSocial.optional(),
  social_facebook: nullableSocial.optional(),
  social_linkedin: nullableSocial.optional(),
  profession_id: commonProfileFields.profession_id.optional(),
  skill_ids: skillIds.optional(),
  remove_avatar: z.boolean().optional(),
});

export type AdminMemberUpdateInput = z.infer<typeof adminMemberUpdateSchema>;

/** Field identitas keanggotaan: hanya dikoreksi pengurus members.manage (PRD 3.5, AC F05-6). */
const IDENTITY_KEYS = new Set(["full_name", "gender", "cohort", "class_in", "class_out"]);
/** Field yang tidak pernah dapat diubah lewat endpoint profil/koreksi (nomor dari server, email lewat alur OTP). */
const SERVER_OWNED_KEYS = new Set([
  "member_number",
  "member_seq",
  "email",
  "user_id",
  "starts_at",
  "expires_at",
  "suspended_at",
]);

/**
 * Menolak field di luar skema dengan 400 VALIDATION_ERROR per field (kontrak `additionalProperties: false`;
 * AC F05-6: nomor anggota tidak pernah dari klien) SEBELUM validasi lain, sehingga tidak ada field yang berubah.
 * `minFields` = jumlah field minimum yang dikenal (kontrak minProperties).
 */
export function assertKnownFields(
  body: unknown,
  allowed: readonly string[],
  options: { identityEditable: boolean; minFields: number },
): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
      fieldErrors: { _: ["Body harus berupa objek JSON"] },
    });
  const record = body as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const fieldErrors: Record<string, string[]> = {};
  for (const key of Object.keys(record)) {
    if (allowedSet.has(key)) continue;
    if (SERVER_OWNED_KEYS.has(key))
      fieldErrors[key] = [
        key === "email"
          ? "Email hanya dapat diubah lewat alur koreksi email terverifikasi."
          : "Nilai ini ditetapkan server dan tidak dapat dikirim klien.",
      ];
    else if (IDENTITY_KEYS.has(key) && !options.identityEditable)
      fieldErrors[key] = ["Data identitas keanggotaan hanya dapat dikoreksi pengurus."];
    else fieldErrors[key] = ["Field tidak dikenal atau tidak dapat diubah di sini."];
  }
  if (Object.keys(fieldErrors).length > 0)
    throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", { fieldErrors });
  if (Object.keys(record).length < options.minFields)
    throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
      fieldErrors: { _: ["Kirim minimal satu perubahan."] },
    });
  return record;
}

export const PROFILE_UPDATE_KEYS = Object.keys(profileUpdateSchema.shape);
export const ADMIN_MEMBER_UPDATE_KEYS = Object.keys(adminMemberUpdateSchema.shape);
