import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, createdAt, id, updatedAt } from "./_common.js";

export const accountStatus = app.enum("account_status", [
  "pending_otp",
  "active",
  "disabled",
  "deletion_pending",
  "deleted",
]);
export const otpPurpose = app.enum("otp_purpose", ["signup", "password_reset", "deletion"]);
export const adminRole = app.enum("admin_role", ["super_admin", "admin"]);

/** Akun login. Tanpa NIK (N-09). Email disimpan ternormalisasi untuk keunikan. */
export const users = app.table(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: accountStatus("status").notNull().default("pending_otp"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    policyVersion: text("policy_version"),
    policyAcceptedAt: timestamp("policy_accepted_at", { withTimezone: true }),
    sessionVersion: integer("session_version").notNull().default(1),
    kind: text("kind").notNull().default("alumni"), // alumni | admin: identitas login terpisah (PRD 2.3)
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    check("users_kind_chk", sql`${t.kind} in ('alumni','admin')`),
  ],
);

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
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resendAvailableAt: timestamp("resend_available_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("otp_codes_user_purpose_idx").on(t.userId, t.purpose),
    check("otp_attempts_chk", sql`${t.attempts} between 0 and 5`),
  ],
);

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
    platform: text("platform"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedBy: uuid("replaced_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sessions_refresh_hash_key").on(t.refreshHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_family_idx").on(t.familyId),
  ],
);

export const mfaTotp = app.table("mfa_totp", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  secretEncrypted: text("secret_encrypted").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  backupCodeHashes: jsonb("backup_code_hashes").$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
});

/** Identitas admin terpisah, tertaut ke akun alumni untuk cek konflik kepentingan (PRD 2.3, v3.3). */
export const admins = app.table(
  "admins",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    linkedAlumniUserId: uuid("linked_alumni_user_id").references(() => users.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull(),
    role: adminRole("role").notNull().default("admin"),
    active: boolean("active").notNull().default(true),
    permissionsVersion: integer("permissions_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("admins_user_key").on(t.userId)],
);

export const adminPermissions = app.table(
  "admin_permissions",
  {
    adminId: uuid("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.adminId, t.permission] })],
);
