import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, createdAt, id, tstz, updatedAt, version } from "./_common.js";
import { admins, users } from "./identity.js";
import { payments } from "./payments.js";
import { files } from "./platform.js";

export const gender = app.enum("gender", ["male", "female"]);
/** Histori keanggotaan dan moderasi dipisahkan dari periode agar tanggal habis tidak hilang saat suspend (PRD 4.2). */
export const membershipEventKind = app.enum("membership_event_kind", [
  "activation",
  "renewal",
  "suspend",
  "unsuspend",
  "number_correction",
  "warn",
]);

/** Nomor urut N global untuk nomor anggota AA.SS.JK.N, mulai 1, tidak didaur ulang (PRD 3.5, 6.2). */
export const memberNumberSeq = app.sequence("membership_no_seq", { startWith: 1, increment: 1 });

/**
 * Master profesi (PRD 6.2). Label unik tanpa membedakan huruf besar/kecil. Master yang dipakai tidak dapat dihapus
 * (FK RESTRICT); penonaktifan mempertahankan label historis (AC F10-4).
 */
export const masterProfessions = app.table(
  "master_professions",
  {
    id: id(),
    label: text("label").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: smallint("sort_order").notNull().default(0),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("master_professions_label_key").on(sql`lower(${t.label})`),
    check(
      "master_professions_label_chk",
      sql`${t.label} = btrim(${t.label}) and char_length(${t.label}) between 1 and 100`,
    ),
  ],
);

/** Master keahlian (PRD 6.2), aturan sama dengan master profesi dan konsisten dengan filter direktori. */
export const masterSkills = app.table(
  "master_skills",
  {
    id: id(),
    label: text("label").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: smallint("sort_order").notNull().default(0),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("master_skills_label_key").on(sql`lower(${t.label})`),
    check(
      "master_skills_label_chk",
      sql`${t.label} = btrim(${t.label}) and char_length(${t.label}) between 1 and 100`,
    ),
  ],
);

/**
 * Profil alumni (PRD 6.2). Tanpa NIK/Nomor KTP (N-09, v3.3). Kontak dan tautan sosial default tersembunyi (F-10,
 * N-15). Kolom keanggotaan (nomor, periode, suspend) hanya diubah layanan keanggotaan/admin, tidak lewat endpoint
 * profil umum (PRD 6.4). suspension_reason hanya untuk pengurus; suspension_message ditampilkan ke anggota.
 * user_id wajib akun berjenis `alumni` (`alumni_user_kind_chk`, migrasi 0004).
 */
export const alumni = app.table(
  "alumni",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    gender: gender("gender").notNull(),
    cohort: smallint("cohort").notNull(),
    classIn: smallint("class_in").notNull(),
    classOut: smallint("class_out").notNull(),
    city: text("city"),
    phone: text("phone"),
    bio: text("bio"),
    lastEducationInstitution: text("last_education_institution"),
    lastEducationCity: text("last_education_city"),
    socialInstagram: text("social_instagram"),
    socialX: text("social_x"),
    socialFacebook: text("social_facebook"),
    socialLinkedin: text("social_linkedin"),
    showEmail: boolean("show_email").notNull().default(false),
    showPhone: boolean("show_phone").notNull().default(false),
    showSocial: boolean("show_social").notNull().default(false),
    showInDirectory: boolean("show_in_directory").notNull().default(true),
    avatarFileId: uuid("avatar_file_id").references(() => files.id, { onDelete: "set null" }),
    /**
     * N dari app.membership_no_seq (nextval, tidak pernah nilai ketikan); tidak berubah saat renewal maupun koreksi
     * (PRD 3.5, AC F05-6). Sekali terisi, trigger migrasi 0004 menolak perubahan apa pun (`alumni_member_seq_immutable_chk`)
     * sehingga N anggota yang dihapus tidak dapat dipasang ke anggota lain.
     */
    memberSeq: bigint("member_seq", { mode: "number" }),
    memberNumber: text("member_number"),
    startsAt: tstz("starts_at"),
    expiresAt: tstz("expires_at"),
    suspendedAt: tstz("suspended_at"),
    suspensionReason: text("suspension_reason"),
    suspensionMessage: text("suspension_message"),
    suspendedByAdminId: uuid("suspended_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("alumni_member_seq_key").on(t.memberSeq),
    uniqueIndex("alumni_member_number_key").on(t.memberNumber),
    // Filter direktori: angkatan/kelas, kota, dan nama (F-10).
    index("alumni_cohort_class_idx").on(t.cohort, t.classIn, t.classOut),
    index("alumni_city_idx").on(sql`lower(${t.city})`),
    index("alumni_full_name_idx").on(sql`lower(${t.fullName}) text_pattern_ops`),
    // Job pengingat expiry 30 hari (AC F07-5).
    index("alumni_expires_at_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
    index("alumni_avatar_file_id_idx")
      .on(t.avatarFileId)
      .where(sql`${t.avatarFileId} is not null`),
    index("alumni_suspended_by_admin_id_idx")
      .on(t.suspendedByAdminId)
      .where(sql`${t.suspendedByAdminId} is not null`),
    check(
      "alumni_class_chk",
      sql`${t.classIn} between 1 and 6 and ${t.classOut} between 1 and 6 and ${t.classOut} >= ${t.classIn}`,
    ),
    check("alumni_cohort_chk", sql`${t.cohort} between 1 and 99`),
    check("alumni_full_name_chk", sql`char_length(btrim(${t.fullName})) between 1 and 120`),
    check("alumni_bio_chk", sql`${t.bio} is null or char_length(${t.bio}) <= 500`),
    // Nomor lengkap AA.SS.JK.N selalu sama dengan segmen pembentuk yang tersimpan (PRD 3.5, 6.2): AA = angkatan,
    // SS = status pendidikan dari kelas masuk/keluar, JK = jenis kelamin, N = member_seq. Koreksi admin wajib
    // mengubah segmen dan nomor dalam satu UPDATE (AC F05-6).
    check(
      "alumni_member_number_chk",
      sql`(${t.memberSeq} is null and ${t.memberNumber} is null) or (${t.memberSeq} >= 1 and ${t.memberNumber} = lpad(${t.cohort}::text, 2, '0') || '.' || (case when ${t.classIn} <= 3 and ${t.classOut} = 6 then '01' when (${t.classIn} <= 3 and ${t.classOut} >= 3) or ${t.classOut} = 6 then '02' else '03' end) || '.' || (case when ${t.gender} = 'male' then '01' else '02' end) || '.' || ${t.memberSeq}::text)`,
    ),
    check(
      "alumni_period_chk",
      sql`(${t.startsAt} is null) = (${t.expiresAt} is null) and (${t.expiresAt} is null or ${t.expiresAt} > ${t.startsAt})`,
    ),
  ],
);

/** Profesi alumni: paling banyak satu per alumni (kontrak Profile.profession tunggal), master RESTRICT (PRD 6.3). */
export const alumniProfessions = app.table(
  "alumni_professions",
  {
    alumniUserId: uuid("alumni_user_id")
      .notNull()
      .references(() => alumni.userId, { onDelete: "cascade" }),
    professionId: uuid("profession_id")
      .notNull()
      .references(() => masterProfessions.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.alumniUserId, t.professionId] }),
    uniqueIndex("alumni_professions_alumni_user_id_key").on(t.alumniUserId),
    index("alumni_professions_profession_id_idx").on(t.professionId),
  ],
);

/** Keahlian alumni: maksimal 10 per alumni, dijaga trigger `app.alumni_skills_limit` (migrasi 0003). */
export const alumniSkills = app.table(
  "alumni_skills",
  {
    alumniUserId: uuid("alumni_user_id")
      .notNull()
      .references(() => alumni.userId, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => masterSkills.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.alumniUserId, t.skillId] }),
    index("alumni_skills_skill_id_idx").on(t.skillId),
  ],
);

/**
 * Histori aktivasi/renewal/suspend/unsuspend/koreksi nomor/peringatan (PRD 6.3). Satu aktivasi/renewal per payment
 * paid dijaga UNIQUE(payment_id) (PRD 6.4); warn tidak mengubah tanggal keanggotaan (AC F12-3).
 */
export const membershipEvents = app.table(
  "membership_events",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: membershipEventKind("kind").notNull(),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "restrict" }),
    actorAdminId: uuid("actor_admin_id").references(() => admins.id, { onDelete: "set null" }),
    reason: text("reason"),
    beforeStartsAt: tstz("before_starts_at"),
    afterStartsAt: tstz("after_starts_at"),
    beforeExpiresAt: tstz("before_expires_at"),
    afterExpiresAt: tstz("after_expires_at"),
    beforeMemberNumber: text("before_member_number"),
    afterMemberNumber: text("after_member_number"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("membership_events_payment_id_key").on(t.paymentId),
    index("membership_events_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("membership_events_actor_admin_id_idx")
      .on(t.actorAdminId)
      .where(sql`${t.actorAdminId} is not null`),
    check(
      "membership_events_payment_chk",
      sql`${t.paymentId} is null or ${t.kind} in ('activation','renewal')`,
    ),
    check(
      "membership_events_period_chk",
      sql`${t.kind} not in ('activation','renewal') or (${t.afterStartsAt} is not null and ${t.afterExpiresAt} > ${t.afterStartsAt})`,
    ),
    check(
      "membership_events_correction_chk",
      sql`${t.kind} <> 'number_correction' or (${t.beforeMemberNumber} is not null and ${t.afterMemberNumber} is not null)`,
    ),
    check(
      "membership_events_warn_chk",
      sql`${t.kind} <> 'warn' or (${t.afterStartsAt} is null and ${t.afterExpiresAt} is null)`,
    ),
  ],
);

/** Jumlah maksimum keahlian per alumni (kontrak skill_ids maxItems 10); sama dengan batas di trigger migrasi 0003. */
export const MAX_ALUMNI_SKILLS = 10;
