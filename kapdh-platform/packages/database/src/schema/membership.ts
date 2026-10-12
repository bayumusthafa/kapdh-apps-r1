import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, createdAt, id, updatedAt } from "./_common.js";
import { users } from "./identity.js";

export const gender = app.enum("gender", ["male", "female"]);

/** Nomor urut N global untuk nomor anggota AA.SS.JK.N (PRD 3.5, v3.4). */
export const memberNumberSeq = app.sequence("membership_no_seq", { startWith: 1, increment: 1 });

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
    professionId: uuid("profession_id"),
    avatarFileId: uuid("avatar_file_id"),
    memberSeq: bigint("member_seq", { mode: "number" }),
    memberNumber: text("member_number"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspensionMessage: text("suspension_message"),
    showInDirectory: boolean("show_in_directory").notNull().default(true),
    showPhone: boolean("show_phone").notNull().default(false),
    showSocial: boolean("show_social").notNull().default(false),
    version: smallint("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("alumni_member_seq_key").on(t.memberSeq),
    uniqueIndex("alumni_member_number_key").on(t.memberNumber),
    check(
      "alumni_class_chk",
      sql`${t.classIn} between 1 and 6 and ${t.classOut} between 1 and 6 and ${t.classOut} >= ${t.classIn}`,
    ),
    check("alumni_cohort_chk", sql`${t.cohort} between 1 and 99`),
  ],
);

export const membershipEvents = app.table(
  "membership_events",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // activation | renewal | suspend | unsuspend | number_correction
    paymentId: uuid("payment_id"),
    beforeExpiresAt: timestamp("before_expires_at", { withTimezone: true }),
    afterExpiresAt: timestamp("after_expires_at", { withTimezone: true }),
    beforeNumber: text("before_number"),
    afterNumber: text("after_number"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("membership_events_payment_key").on(t.paymentId),
    index("membership_events_user_idx").on(t.userId),
  ],
);
