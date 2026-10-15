import { relations } from "drizzle-orm";
import { appSettings } from "./settings.js";
import { blocks, messageReactions, messages, reports, roomMembers, rooms } from "./community.js";
import { banners, categories, pages, postLikes, posts } from "./content.js";
import { events, tickets } from "./events.js";
import { adminPermissions, admins, mfaTotp, otpCodes, sessions, users } from "./identity.js";
import {
  alumni,
  alumniProfessions,
  alumniSkills,
  masterProfessions,
  masterSkills,
  membershipEvents,
} from "./membership.js";
import {
  deviceTokens,
  notificationDeliveries,
  notificationPreferences,
  notifications,
} from "./notifications.js";
import { paymentAdjustments, paymentEvents, paymentMethods, payments } from "./payments.js";
import { files } from "./platform.js";

/*
 * Relasi Drizzle untuk `db.query.*.findMany({ with })` pada FK utama (PRD 6.4). Relasi tidak membuat constraint;
 * constraint ada di definisi tabel dan migrasi.
 */

// ------------------------------------------------------------------ Identitas
export const usersRelations = relations(users, ({ one, many }) => ({
  alumni: one(alumni),
  mfaTotp: one(mfaTotp),
  sessions: many(sessions),
  otpCodes: many(otpCodes),
  payments: many(payments),
  tickets: many(tickets),
  membershipEvents: many(membershipEvents),
  notifications: many(notifications),
  notificationPreferences: many(notificationPreferences),
  deviceTokens: many(deviceTokens),
  roomMemberships: many(roomMembers, { relationName: "room_member_user" }),
}));

export const otpCodesRelations = relations(otpCodes, ({ one }) => ({
  user: one(users, { fields: [otpCodes.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  deviceTokens: many(deviceTokens),
}));

export const mfaTotpRelations = relations(mfaTotp, ({ one }) => ({
  user: one(users, { fields: [mfaTotp.userId], references: [users.id] }),
}));

export const adminsRelations = relations(admins, ({ one, many }) => ({
  user: one(users, { fields: [admins.userId], references: [users.id], relationName: "admin_user" }),
  linkedAlumniUser: one(users, {
    fields: [admins.linkedAlumniUserId],
    references: [users.id],
    relationName: "admin_linked_alumni",
  }),
  invitedBy: one(admins, {
    fields: [admins.invitedByAdminId],
    references: [admins.id],
    relationName: "admin_invited_by",
  }),
  permissions: many(adminPermissions, { relationName: "admin_permission_owner" }),
}));

export const adminPermissionsRelations = relations(adminPermissions, ({ one }) => ({
  admin: one(admins, {
    fields: [adminPermissions.adminId],
    references: [admins.id],
    relationName: "admin_permission_owner",
  }),
}));

// ------------------------------------------------------------------ Keanggotaan
export const alumniRelations = relations(alumni, ({ one, many }) => ({
  user: one(users, { fields: [alumni.userId], references: [users.id] }),
  avatar: one(files, { fields: [alumni.avatarFileId], references: [files.id] }),
  suspendedBy: one(admins, { fields: [alumni.suspendedByAdminId], references: [admins.id] }),
  professions: many(alumniProfessions),
  skills: many(alumniSkills),
}));

export const masterProfessionsRelations = relations(masterProfessions, ({ many }) => ({
  alumni: many(alumniProfessions),
}));

export const masterSkillsRelations = relations(masterSkills, ({ many }) => ({
  alumni: many(alumniSkills),
}));

export const alumniProfessionsRelations = relations(alumniProfessions, ({ one }) => ({
  alumni: one(alumni, { fields: [alumniProfessions.alumniUserId], references: [alumni.userId] }),
  profession: one(masterProfessions, {
    fields: [alumniProfessions.professionId],
    references: [masterProfessions.id],
  }),
}));

export const alumniSkillsRelations = relations(alumniSkills, ({ one }) => ({
  alumni: one(alumni, { fields: [alumniSkills.alumniUserId], references: [alumni.userId] }),
  skill: one(masterSkills, { fields: [alumniSkills.skillId], references: [masterSkills.id] }),
}));

export const membershipEventsRelations = relations(membershipEvents, ({ one }) => ({
  user: one(users, { fields: [membershipEvents.userId], references: [users.id] }),
  payment: one(payments, { fields: [membershipEvents.paymentId], references: [payments.id] }),
  actorAdmin: one(admins, { fields: [membershipEvents.actorAdminId], references: [admins.id] }),
}));

// ------------------------------------------------------------------ Keuangan dan konfigurasi
export const paymentMethodsRelations = relations(paymentMethods, ({ one, many }) => ({
  payments: many(payments),
  qrImageFile: one(files, { fields: [paymentMethods.qrImageFileId], references: [files.id] }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  user: one(users, { fields: [payments.userId], references: [users.id] }),
  ticket: one(tickets, { fields: [payments.ticketId], references: [tickets.id] }),
  paymentMethod: one(paymentMethods, {
    fields: [payments.paymentMethodId],
    references: [paymentMethods.id],
  }),
  proofFile: one(files, { fields: [payments.proofFileId], references: [files.id] }),
  decidedBy: one(admins, { fields: [payments.decidedByAdminId], references: [admins.id] }),
  events: many(paymentEvents),
  adjustments: many(paymentAdjustments),
  membershipEvent: one(membershipEvents),
}));

export const paymentEventsRelations = relations(paymentEvents, ({ one }) => ({
  payment: one(payments, { fields: [paymentEvents.paymentId], references: [payments.id] }),
}));

export const paymentAdjustmentsRelations = relations(paymentAdjustments, ({ one }) => ({
  payment: one(payments, { fields: [paymentAdjustments.paymentId], references: [payments.id] }),
  evidenceFile: one(files, { fields: [paymentAdjustments.evidenceFileId], references: [files.id] }),
  cancelledBy: one(admins, { fields: [paymentAdjustments.cancelledByAdminId], references: [admins.id] }),
}));

export const appSettingsRelations = relations(appSettings, ({ one }) => ({
  updatedBy: one(admins, { fields: [appSettings.updatedByAdminId], references: [admins.id] }),
}));

// ------------------------------------------------------------------ Konten
export const categoriesRelations = relations(categories, ({ many }) => ({
  posts: many(posts),
  events: many(events),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  category: one(categories, { fields: [posts.categoryId], references: [categories.id] }),
  cover: one(files, { fields: [posts.coverFileId], references: [files.id] }),
  author: one(admins, { fields: [posts.authorAdminId], references: [admins.id] }),
  likes: many(postLikes),
}));

export const postLikesRelations = relations(postLikes, ({ one }) => ({
  post: one(posts, { fields: [postLikes.postId], references: [posts.id] }),
  user: one(users, { fields: [postLikes.userId], references: [users.id] }),
}));

export const bannersRelations = relations(banners, ({ one }) => ({
  image: one(files, { fields: [banners.imageFileId], references: [files.id] }),
}));

export const pagesRelations = relations(pages, ({ one }) => ({
  updatedBy: one(admins, { fields: [pages.updatedByAdminId], references: [admins.id] }),
}));

// ------------------------------------------------------------------ Event
export const eventsRelations = relations(events, ({ one, many }) => ({
  category: one(categories, { fields: [events.categoryId], references: [categories.id] }),
  cover: one(files, { fields: [events.coverFileId], references: [files.id] }),
  createdBy: one(admins, { fields: [events.createdByAdminId], references: [admins.id] }),
  tickets: many(tickets),
}));

export const ticketsRelations = relations(tickets, ({ one }) => ({
  event: one(events, { fields: [tickets.eventId], references: [events.id] }),
  user: one(users, { fields: [tickets.userId], references: [users.id] }),
  checkedInBy: one(admins, { fields: [tickets.checkedInByAdminId], references: [admins.id] }),
  payment: one(payments),
}));

// ------------------------------------------------------------------ Komunitas
export const blocksRelations = relations(blocks, ({ one }) => ({
  blocker: one(users, { fields: [blocks.blockerId], references: [users.id], relationName: "block_blocker" }),
  blocked: one(users, { fields: [blocks.blockedId], references: [users.id], relationName: "block_blocked" }),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  createdByUser: one(users, { fields: [rooms.createdBy], references: [users.id] }),
  avatar: one(files, { fields: [rooms.avatarFileId], references: [files.id] }),
  members: many(roomMembers),
  messages: many(messages, { relationName: "message_room" }),
}));

export const roomMembersRelations = relations(roomMembers, ({ one }) => ({
  room: one(rooms, { fields: [roomMembers.roomId], references: [rooms.id] }),
  user: one(users, {
    fields: [roomMembers.userId],
    references: [users.id],
    relationName: "room_member_user",
  }),
  invitedByUser: one(users, {
    fields: [roomMembers.invitedBy],
    references: [users.id],
    relationName: "room_member_inviter",
  }),
  lastReadMessage: one(messages, {
    fields: [roomMembers.lastReadMessageId],
    references: [messages.id],
    relationName: "room_member_last_read",
  }),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  room: one(rooms, { fields: [messages.roomId], references: [rooms.id], relationName: "message_room" }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
  image: one(files, { fields: [messages.imageFileId], references: [files.id] }),
  replyTo: one(messages, {
    fields: [messages.replyToId],
    references: [messages.id],
    relationName: "message_reply",
  }),
  reactions: many(messageReactions),
}));

export const messageReactionsRelations = relations(messageReactions, ({ one }) => ({
  message: one(messages, { fields: [messageReactions.messageId], references: [messages.id] }),
  user: one(users, { fields: [messageReactions.userId], references: [users.id] }),
}));

export const reportsRelations = relations(reports, ({ one }) => ({
  reporter: one(users, {
    fields: [reports.reporterId],
    references: [users.id],
    relationName: "report_reporter",
  }),
  targetUser: one(users, {
    fields: [reports.targetUserId],
    references: [users.id],
    relationName: "report_target_user",
  }),
  targetMessage: one(messages, {
    fields: [reports.targetMessageId],
    references: [messages.id],
    relationName: "report_target_message",
  }),
  room: one(rooms, { fields: [reports.roomId], references: [rooms.id], relationName: "report_room" }),
  resolvedBy: one(admins, { fields: [reports.resolvedByAdminId], references: [admins.id] }),
  claimedBy: one(admins, { fields: [reports.claimedByAdminId], references: [admins.id] }),
}));

// ------------------------------------------------------------------ Notifikasi
export const notificationsRelations = relations(notifications, ({ one, many }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  deliveries: many(notificationDeliveries),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  user: one(users, { fields: [notificationPreferences.userId], references: [users.id] }),
}));

export const deviceTokensRelations = relations(deviceTokens, ({ one, many }) => ({
  user: one(users, { fields: [deviceTokens.userId], references: [users.id] }),
  session: one(sessions, { fields: [deviceTokens.sessionId], references: [sessions.id] }),
  deliveries: many(notificationDeliveries),
}));

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({ one }) => ({
  notification: one(notifications, {
    fields: [notificationDeliveries.notificationId],
    references: [notifications.id],
  }),
  deviceToken: one(deviceTokens, {
    fields: [notificationDeliveries.deviceTokenId],
    references: [deviceTokens.id],
  }),
}));

// ------------------------------------------------------------------ Platform
export const filesRelations = relations(files, ({ one }) => ({
  owner: one(users, { fields: [files.ownerUserId], references: [users.id] }),
}));
