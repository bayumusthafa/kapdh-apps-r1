import {
  EDUCATION_LEVELS,
  MAX_ALUMNI_EDUCATION,
  MAX_ALUMNI_PROFESSIONS,
  MAX_ALUMNI_SOCIAL_LINKS,
  SOCIAL_PLATFORMS,
} from "@kapdh/database";
import { z } from "zod";
import { AppException, fieldError } from "../../core/errors/app-exception.js";
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

/** Karakter kontrol Unicode (Cc): NUL ditolak PostgreSQL (22021) sehingga tanpa pemeriksaan ini menjadi 500. */
const CONTROL_CHAR = /\p{Cc}/u;

const socialHandle = z
  .string()
  .min(1, "Wajib diisi atau kosongkan dengan null")
  .max(200, "Maksimal 200 karakter")
  .refine((value) => !CONTROL_CHAR.test(value), "Tautan tidak boleh memuat karakter kontrol")
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

/** Satu profesi (kontrak ProfessionLabel): dirapikan, 1..100 karakter, tanpa karakter kontrol. */
const professionLabel = z
  .string()
  .trim()
  .min(1, "Profesi tidak boleh kosong")
  .max(100, "Maksimal 100 karakter")
  .refine((value) => !CONTROL_CHAR.test(value), "Profesi tidak boleh memuat karakter kontrol");

const professions = z
  .array(professionLabel)
  .max(MAX_ALUMNI_PROFESSIONS, `Maksimal ${MAX_ALUMNI_PROFESSIONS} profesi`)
  .refine(
    (labels) => new Set(labels.map((label) => label.toLowerCase())).size === labels.length,
    "Profesi tidak boleh ganda",
  );

/** Entri riwayat pendidikan (kontrak EducationEntryInput); tahun tamat <= tahun berjalan diperiksa layanan. */
const educationEntry = z
  .object({
    institution: z
      .string()
      .trim()
      .min(1, "Universitas/instansi wajib diisi")
      .max(120, "Maksimal 120 karakter")
      .refine((value) => !CONTROL_CHAR.test(value), "Tidak boleh memuat karakter kontrol"),
    major: z
      .union([
        trimmedText(120).refine((value) => !CONTROL_CHAR.test(value), "Tidak boleh memuat karakter kontrol"),
        z.null(),
      ])
      .optional(),
    level: z.enum(EDUCATION_LEVELS, { message: "Strata tidak dikenal" }).nullable().optional(),
    graduation_year: z
      .number({ message: "Tahun tamat harus berupa angka" })
      .int("Tahun tamat harus bilangan bulat")
      .min(1950, "Tahun tamat minimal 1950")
      .max(2100, "Tahun tamat tidak valid")
      .nullable()
      .optional(),
  })
  .strict();

const education = z
  .array(educationEntry)
  .max(MAX_ALUMNI_EDUCATION, `Maksimal ${MAX_ALUMNI_EDUCATION} riwayat pendidikan`);

/** Tautan sosial (kontrak SocialLinkInput): aturan SocialHandle; situs web hanya URL https. */
const socialLink = z
  .object({
    platform: z.enum(SOCIAL_PLATFORMS, { message: "Platform tidak dikenal" }),
    value: socialHandle,
  })
  .strict()
  .superRefine((link, ctx) => {
    if (link.platform === "website" && !link.value.startsWith("https://"))
      ctx.addIssue({ code: "custom", path: ["value"], message: "Situs web harus berupa tautan https://" });
  });

const socialLinks = z
  .array(socialLink)
  .max(MAX_ALUMNI_SOCIAL_LINKS, `Maksimal ${MAX_ALUMNI_SOCIAL_LINKS} tautan`)
  .superRefine((links, ctx) => {
    const seen = new Set<string>();
    links.forEach((link, index) => {
      const key = `${link.platform}:${link.value.toLowerCase()}`;
      if (seen.has(key))
        ctx.addIssue({ code: "custom", path: [index, "value"], message: "Tautan ini sudah ada" });
      seen.add(key);
    });
  });

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
  professions,
  education,
  social_links: socialLinks,
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
  professions: professions.optional(),
  education: education.optional(),
  social_links: socialLinks.optional(),
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

export type EducationEntryInput = z.infer<typeof educationEntry>;
export type SocialLinkInput = z.infer<typeof socialLink>;

/**
 * Field lama aplikasi 1.0.0 per daftar penggantinya (kontrak updateMyProfile "Masa transisi"). Field lama bersama
 * penggantinya dalam satu body ditolak 400 pada field lama: urutan penerapan keduanya tidak terdefinisi.
 */
const LEGACY_FIELDS = {
  professions: ["profession_id"],
  education: ["last_education_institution", "last_education_city"],
  social_links: ["social_instagram", "social_x", "social_facebook", "social_linkedin"],
} as const;

export function assertNoLegacyMix(input: Record<string, unknown>): void {
  const fieldErrors: Record<string, string[]> = {};
  for (const [list, legacy] of Object.entries(LEGACY_FIELDS)) {
    if (input[list] === undefined) continue;
    for (const key of legacy)
      if (input[key] !== undefined)
        fieldErrors[key] = [`Field lama ini tidak dapat dikirim bersama ${list}. Kirim ${list} saja.`];
  }
  if (Object.keys(fieldErrors).length > 0)
    throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", { fieldErrors });
}

/** Tahun tamat tidak boleh melewati tahun berjalan Asia/Jakarta (kontrak EducationEntryInput). */
export function assertGraduationYears(entries: readonly EducationEntryInput[] | undefined, now: Date): void {
  if (!entries) return;
  const currentYear = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", year: "numeric" }).format(now),
  );
  entries.forEach((entry, index) => {
    if (entry.graduation_year != null && entry.graduation_year > currentYear)
      throw fieldError(`education.${index}.graduation_year`, "Tahun tamat tidak boleh melewati tahun ini.");
  });
}

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
 * Jumlah minimum perubahan (kontrak minProperties) diperiksa {@link assertHasChange} sesudah validasi skema.
 */
export function assertKnownFields(
  body: unknown,
  allowed: readonly string[],
  options: { identityEditable: boolean },
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
  return record;
}

/**
 * Minimal satu field perubahan selain `ignore` (mis. `reason` yang wajib), diperiksa sesudah validasi skema sehingga
 * field wajib yang hilang dilaporkan pada field-nya sendiri (kontrak minProperties).
 */
export function assertHasChange(input: Record<string, unknown>, ignore: readonly string[] = []): void {
  const skip = new Set(ignore);
  if (Object.keys(input).some((key) => !skip.has(key) && input[key] !== undefined)) return;
  throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
    fieldErrors: { _: ["Kirim minimal satu perubahan."] },
  });
}

export const PROFILE_UPDATE_KEYS = Object.keys(profileUpdateSchema.shape);
export const ADMIN_MEMBER_UPDATE_KEYS = Object.keys(adminMemberUpdateSchema.shape);
