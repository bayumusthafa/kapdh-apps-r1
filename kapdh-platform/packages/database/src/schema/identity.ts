import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, createdAt, id, sqlInList, tstz, updatedAt, version } from "./_common.js";

/** Status autentikasi akun (PRD 2.2). effective_status keanggotaan dihitung API, tidak disimpan (ARCHITECTURE §3.1). */
export const accountStatus = app.enum("account_status", [
  "pending_otp",
  "active",
  "disabled",
  "deletion_pending",
  "deleted",
]);
/** Tujuan challenge OTP (PRD 2.5); email_change untuk koreksi email melalui alur terverifikasi (PRD 2.2). */
export const otpPurpose = app.enum("otp_purpose", ["signup", "password_reset", "deletion", "email_change"]);
export const adminRole = app.enum("admin_role", ["super_admin", "admin"]);
/** Siklus undangan admin tertutup: invited -> active setelah ganti sandi awal dan TOTP (F-16, PRD 8.2). */
export const adminStatus = app.enum("admin_status", ["invited", "active", "disabled"]);

/** Izin final admin (ARCHITECTURE §4.5). Super Admin memiliki semuanya tanpa baris admin_permissions. */
export const PERMISSIONS = [
  "payments.read",
  "payments.decide",
  "members.read",
  "members.manage",
  "content.manage",
  "master.manage",
  "events.manage",
  "events.checkin",
  "moderation.read",
  "moderation.resolve",
  "audit.read",
  "audit.export",
  "settings.manage",
  "admins.manage",
  "notifications.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Akun login. Tanpa NIK (N-09). Email disimpan ternormalisasi (huruf kecil, tanpa spasi tepi) dan unik per jenis
 * identitas selama akun belum terhapus: akun admin terpisah dari akun alumni pribadi (PRD 2.3, F-16), dan email
 * akun yang telah dihapus dapat dipakai mendaftar ulang (F-14).
 */
export const users = app.table(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    /** Hash bcrypt. Admin undangan memakai sandi awal acak yang wajib diganti lewat token sekali pakai (F-16). */
    passwordHash: text("password_hash").notNull(),
    status: accountStatus("status").notNull().default("pending_otp"),
    emailVerifiedAt: tstz("email_verified_at"),
    policyVersion: text("policy_version"),
    policyAcceptedAt: tstz("policy_accepted_at"),
    sessionVersion: integer("session_version").notNull().default(1),
    kind: text("kind").notNull().default("alumni"), // alumni | admin: identitas login terpisah (PRD 2.3)
    lastLoginAt: tstz("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_kind_email_key")
      .on(t.kind, t.email)
      .where(sql`${t.status} <> 'deleted'`),
    check("users_kind_chk", sql`${t.kind} in ('alumni','admin')`),
    check("users_email_normalized_chk", sql`${t.email} = lower(btrim(${t.email}))`),
    check("users_session_version_chk", sql`${t.sessionVersion} >= 1`),
  ],
);

/** Challenge OTP: kode disimpan sebagai HMAC, konsumsi sekali secara atomik (PRD 2.5, AC F01-3). */
export const otpCodes = app.table(
  "otp_codes",
  {
    id: id(), // challenge_id
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: otpPurpose("purpose").notNull(),
    codeHmac: text("code_hmac").notNull(),
    /** Untuk signup: hash dari password_hash saat challenge dibuat. Mencegah pre-account hijacking. */
    binding: text("binding"),
    attempts: smallint("attempts").notNull().default(0),
    expiresAt: tstz("expires_at").notNull(),
    resendAvailableAt: tstz("resend_available_at").notNull(),
    consumedAt: tstz("consumed_at"),
    supersededAt: tstz("superseded_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("otp_codes_user_id_purpose_idx").on(t.userId, t.purpose, t.createdAt),
    // Pengiriman ulang membatalkan kode sebelumnya untuk tujuan yang sama (PRD 2.5): paling banyak satu challenge
    // aktif per akun dan tujuan; indeks ini juga dipakai untuk mencari challenge aktif.
    uniqueIndex("otp_codes_active_key")
      .on(t.userId, t.purpose)
      .where(sql`${t.consumedAt} is null and ${t.supersededAt} is null`),
    index("otp_codes_expires_at_idx").on(t.expiresAt),
    check("otp_codes_attempts_chk", sql`${t.attempts} between 0 and 5`),
  ],
);

/** Sesi refresh dengan rotasi keluarga (AC F02-3), audience terpisah, MFA level, dan reautentikasi (F-14, F-16). */
export const sessions = app.table(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull(),
    refreshHash: text("refresh_hash").notNull(),
    audience: text("audience").notNull(), // mobile | admin
    mfaLevel: smallint("mfa_level").notNull().default(1), // 1 = sandi, 2 = TOTP
    deviceName: text("device_name"),
    platform: text("platform"), // android | ios | web
    appVersion: text("app_version"),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
    lastActivityAt: tstz("last_activity_at").notNull().defaultNow(),
    /** Reautentikasi terakhir; token X-Reauth-Token berlaku maksimal 10 menit sejak waktu ini (F-14, AC F15-3). */
    reauthenticatedAt: tstz("reauthenticated_at"),
    expiresAt: tstz("expires_at").notNull(),
    revokedAt: tstz("revoked_at"),
    replacedBy: uuid("replaced_by").references((): AnyPgColumn => sessions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sessions_refresh_hash_key").on(t.refreshHash),
    index("sessions_user_id_idx").on(t.userId, t.revokedAt),
    index("sessions_family_id_idx").on(t.familyId),
    index("sessions_expires_at_idx").on(t.expiresAt),
    index("sessions_replaced_by_idx")
      .on(t.replacedBy)
      .where(sql`${t.replacedBy} is not null`),
    check("sessions_audience_chk", sql`${t.audience} in ('mobile','admin')`),
    check("sessions_platform_chk", sql`${t.platform} is null or ${t.platform} in ('android','ios','web')`),
    check("sessions_mfa_level_chk", sql`${t.mfaLevel} in (1,2)`),
  ],
);

/**
 * Secret TOTP terenkripsi (AES-GCM) dan hash HMAC backup code sekali pakai. Akses sangat terbatas: role worker tidak
 * memiliki hak atas tabel ini (infra/db/roles.sql). last_used_step mencegah replay kode TOTP yang sama (F-02).
 */
export const mfaTotp = app.table(
  "mfa_totp",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    secretEncrypted: text("secret_encrypted").notNull(),
    verifiedAt: tstz("verified_at"),
    lastUsedStep: bigint("last_used_step", { mode: "number" }),
    backupCodeHashes: jsonb("backup_code_hashes").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("mfa_totp_backup_codes_chk", sql`jsonb_typeof(${t.backupCodeHashes}) = 'array'`),
    check("mfa_totp_last_used_step_chk", sql`${t.lastUsedStep} is null or ${t.lastUsedStep} >= 0`),
  ],
);

/**
 * Identitas admin terpisah dari akun alumni, ditautkan ke akun alumni untuk cek konflik kepentingan (PRD 2.3, F-16).
 * Super Admin aktif terakhir dijaga trigger `app.admins_guard_last_super_admin` (AC F16-2, migrasi 0002).
 */
export const admins = app.table(
  "admins",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    linkedAlumniUserId: uuid("linked_alumni_user_id").references(() => users.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull(),
    role: adminRole("role").notNull().default("admin"),
    /** Default `invited` agar baris tanpa status eksplisit tidak pernah aktif (fail closed). */
    status: adminStatus("status").notNull().default("invited"),
    /** Hash token undangan sekali pakai; dikosongkan saat aktivasi. Token mentah tidak pernah disimpan. */
    inviteTokenHash: text("invite_token_hash"),
    inviteExpiresAt: tstz("invite_expires_at"),
    invitedByAdminId: uuid("invited_by_admin_id").references((): AnyPgColumn => admins.id, {
      onDelete: "set null",
    }),
    activatedAt: tstz("activated_at"),
    disabledAt: tstz("disabled_at"),
    /** Naik setiap perubahan izin agar evaluasi server dan socket mencabut hak lama (AC F16-3). */
    permissionsVersion: integer("permissions_version").notNull().default(1),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("admins_user_id_key").on(t.userId),
    uniqueIndex("admins_linked_alumni_user_id_key")
      .on(t.linkedAlumniUserId)
      .where(sql`${t.linkedAlumniUserId} is not null`),
    uniqueIndex("admins_invite_token_hash_key")
      .on(t.inviteTokenHash)
      .where(sql`${t.inviteTokenHash} is not null`),
    index("admins_invited_by_admin_id_idx")
      .on(t.invitedByAdminId)
      .where(sql`${t.invitedByAdminId} is not null`),
    check("admins_active_chk", sql`${t.status} <> 'active' or ${t.activatedAt} is not null`),
    check(
      "admins_invite_chk",
      sql`(${t.inviteTokenHash} is null) = (${t.inviteExpiresAt} is null) and (${t.inviteTokenHash} is null or ${t.status} = 'invited')`,
    ),
    check("admins_disabled_chk", sql`${t.status} <> 'disabled' or ${t.disabledAt} is not null`),
    check("admins_display_name_chk", sql`char_length(btrim(${t.displayName})) between 1 and 120`),
  ],
);

/** Himpunan izin admin yang dinormalisasi; nilainya dibatasi ke 15 izin final (ARCHITECTURE §4.5). */
export const adminPermissions = app.table(
  "admin_permissions",
  {
    adminId: uuid("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    permission: text("permission").$type<Permission>().notNull(),
    grantedByAdminId: uuid("granted_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.adminId, t.permission] }),
    check("admin_permissions_permission_chk", sql`${t.permission} in (${sqlInList(PERMISSIONS)})`),
  ],
);
