import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  jsonb,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, createdAt, id, tstz, updatedAt, version } from "./_common.js";
import { admins, users } from "./identity.js";
import { files } from "./platform.js";

export const roomKind = app.enum("room_kind", ["direct", "group"]);
export const roomMemberRole = app.enum("room_member_role", ["admin", "member"]);
/** Undangan grup harus diterima calon anggota (F-11, D5): invited -> joined | declined; joined -> left | removed. */
export const roomMemberStatus = app.enum("room_member_status", [
  "invited",
  "joined",
  "left",
  "removed",
  "declined",
]);
export const messageKind = app.enum("message_kind", ["text", "image", "system"]);
export const reportTargetType = app.enum("report_target_type", ["user", "message", "room"]);
export const reportCategory = app.enum("report_category", [
  "spam",
  "harassment",
  "hate",
  "sexual",
  "violence_threat",
  "scam",
  "other",
]);
/** urgent = risiko ancaman/keselamatan, target 24 jam; normal 2 hari kerja (F-12, v3.2). */
export const reportPriority = app.enum("report_priority", ["normal", "urgent"]);
export const reportStatus = app.enum("report_status", ["open", "in_review", "resolved", "dismissed"]);
export const reportAction = app.enum("report_action", ["dismiss", "warn", "suspend", "unsuspend"]);

/** Blokir berlaku dua arah untuk direct send dan undangan grup (F-12); tidak dapat memblokir diri sendiri. */
export const blocks = app.table(
  "blocks",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    index("blocks_blocked_id_idx").on(t.blockedId),
    check("blocks_self_chk", sql`${t.blockerId} <> ${t.blockedId}`),
  ],
);

/**
 * Room chat (F-11). Direct room memakai direct_key kanonik `min(a,b):max(a,b)` yang unik sehingga pembuatan bersamaan
 * menghasilkan satu room (AC F11-1). Grup maksimal 100 anggota (D5) dijaga layanan dengan mengunci baris room.
 */
export const rooms = app.table(
  "rooms",
  {
    id: id(),
    kind: roomKind("kind").notNull(),
    directKey: text("direct_key"),
    name: text("name"),
    avatarFileId: uuid("avatar_file_id").references(() => files.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastMessageAt: tstz("last_message_at"),
    closedAt: tstz("closed_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("rooms_direct_key_key").on(t.directKey),
    index("rooms_created_by_idx")
      .on(t.createdBy)
      .where(sql`${t.createdBy} is not null`),
    index("rooms_avatar_file_id_idx")
      .on(t.avatarFileId)
      .where(sql`${t.avatarFileId} is not null`),
    check("rooms_direct_key_chk", sql`(${t.kind} = 'direct') = (${t.directKey} is not null)`),
    check(
      "rooms_direct_key_canonical_chk",
      sql`${t.directKey} is null or (${t.directKey} ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$' and split_part(${t.directKey}, ':', 1) < split_part(${t.directKey}, ':', 2))`,
    ),
    check(
      "rooms_name_chk",
      sql`${t.kind} = 'direct' or (${t.name} is not null and char_length(btrim(${t.name})) between 1 and 80)`,
    ),
  ],
);

/**
 * Keanggotaan room (F-11). Anggota baru hanya melihat pesan sejak bergabung (history_visible_from, D5). Read cursor
 * monoton: pembaruan memakai syarat agar tidak mundur akibat paket terlambat.
 */
export const roomMembers = app.table(
  "room_members",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roomMemberRole("role").notNull().default("member"),
    status: roomMemberStatus("status").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    invitedAt: tstz("invited_at"),
    joinedAt: tstz("joined_at"),
    leftAt: tstz("left_at"),
    historyVisibleFrom: tstz("history_visible_from"),
    lastReadMessageId: uuid("last_read_message_id").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    lastReadAt: tstz("last_read_at"),
    muted: boolean("muted").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.userId] }),
    index("room_members_user_id_status_idx").on(t.userId, t.status),
    index("room_members_room_id_status_idx").on(t.roomId, t.status),
    index("room_members_invited_by_idx")
      .on(t.invitedBy)
      .where(sql`${t.invitedBy} is not null`),
    index("room_members_last_read_message_id_idx")
      .on(t.lastReadMessageId)
      .where(sql`${t.lastReadMessageId} is not null`),
    check("room_members_joined_chk", sql`${t.status} <> 'joined' or ${t.joinedAt} is not null`),
    check("room_members_invited_chk", sql`${t.status} <> 'invited' or ${t.invitedAt} is not null`),
  ],
);

/**
 * Pesan chat (F-11): teks maksimal 4.000 karakter (D5), client_message_id unik per pengirim agar retry tidak
 * menduplikasi (AC F11-2), riwayat keyset (created_at, id) (PRD 6.5). Isi pesan tidak pernah dilog atau diaudit.
 * Penghapusan menjadi placeholder: deleted_at terisi dan body/gambar dikosongkan (AC F14-3).
 */
export const messages = app.table(
  "messages",
  {
    id: id(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id").references(() => users.id, { onDelete: "set null" }),
    clientMessageId: uuid("client_message_id"),
    kind: messageKind("kind").notNull(),
    body: text("body"),
    imageFileId: uuid("image_file_id").references(() => files.id, { onDelete: "set null" }),
    replyToId: uuid("reply_to_id").references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    deletedAt: tstz("deleted_at"),
  },
  (t) => [
    uniqueIndex("messages_sender_id_client_message_id_key").on(t.senderId, t.clientMessageId),
    index("messages_room_id_created_at_id_idx").on(t.roomId, t.createdAt, t.id),
    index("messages_sender_id_idx").on(t.senderId),
    index("messages_reply_to_id_idx")
      .on(t.replyToId)
      .where(sql`${t.replyToId} is not null`),
    index("messages_image_file_id_idx")
      .on(t.imageFileId)
      .where(sql`${t.imageFileId} is not null`),
    check("messages_body_chk", sql`${t.body} is null or char_length(${t.body}) <= 4000`),
    check(
      "messages_content_chk",
      sql`${t.deletedAt} is not null or (${t.kind} = 'text' and ${t.body} is not null and char_length(btrim(${t.body})) > 0) or (${t.kind} = 'image' and ${t.imageFileId} is not null) or (${t.kind} = 'system' and ${t.body} is not null)`,
    ),
    check("messages_client_id_chk", sql`${t.kind} = 'system' or ${t.clientMessageId} is not null`),
  ],
);

/** Reaksi pesan unik per pesan, pengguna, dan emoji (PRD 6.4); akses room tetap diperiksa layanan. */
export const messageReactions = app.table(
  "message_reactions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index("message_reactions_user_id_idx").on(t.userId),
    check("message_reactions_emoji_chk", sql`char_length(${t.emoji}) between 1 and 16`),
  ],
);

/**
 * Laporan moderasi (F-12). evidence menyimpan bukti relevan yang diminimalkan agar konteks tidak hilang ketika pesan
 * dihapus; akses bukti dibatasi izin moderation dan diaudit. Laporan tidak dibuka kepada pihak terlapor (AC F12-2).
 */
export const reports = app.table(
  "reports",
  {
    id: id(),
    reporterId: uuid("reporter_id").references(() => users.id, { onDelete: "set null" }),
    targetType: reportTargetType("target_type").notNull(),
    targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetMessageId: uuid("target_message_id").references(() => messages.id, { onDelete: "set null" }),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
    category: reportCategory("category").notNull(),
    description: text("description"),
    evidence: jsonb("evidence"),
    priority: reportPriority("priority").notNull().default("normal"),
    status: reportStatus("status").notNull().default("open"),
    action: reportAction("action"),
    resolutionNote: text("resolution_note"),
    resolvedByAdminId: uuid("resolved_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    resolvedAt: tstz("resolved_at"),
    /** Target penanganan: 24 jam untuk urgent, 2 hari kerja untuk lainnya (F-12). */
    dueAt: tstz("due_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("reports_status_created_at_idx").on(t.status, t.createdAt),
    index("reports_reporter_id_idx").on(t.reporterId),
    index("reports_target_user_id_idx")
      .on(t.targetUserId)
      .where(sql`${t.targetUserId} is not null`),
    index("reports_target_message_id_idx")
      .on(t.targetMessageId)
      .where(sql`${t.targetMessageId} is not null`),
    index("reports_room_id_idx")
      .on(t.roomId)
      .where(sql`${t.roomId} is not null`),
    index("reports_resolved_by_admin_id_idx")
      .on(t.resolvedByAdminId)
      .where(sql`${t.resolvedByAdminId} is not null`),
    check("reports_description_chk", sql`${t.description} is null or char_length(${t.description}) <= 2000`),
    check(
      "reports_resolved_chk",
      sql`${t.status} not in ('resolved','dismissed') or (${t.resolvedAt} is not null and ${t.action} is not null)`,
    ),
    // Setiap keputusan moderasi wajib beralasan (AC F12-3). resolved_by_admin_id sengaja tidak diwajibkan karena
    // ON DELETE SET NULL; aktor keputusan tetap tercatat di audit.
    check(
      "reports_resolution_note_chk",
      sql`${t.status} not in ('resolved','dismissed') or (${t.resolutionNote} is not null and btrim(${t.resolutionNote}) <> '')`,
    ),
    check("reports_dismissed_chk", sql`${t.status} <> 'dismissed' or ${t.action} = 'dismiss'`),
  ],
);
