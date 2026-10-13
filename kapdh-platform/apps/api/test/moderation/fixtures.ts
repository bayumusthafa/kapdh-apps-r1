/**
 * Fixture uji modul moderation (F-12): room/anggota/pesan chat langsung di database (modul chat dibangun terpisah),
 * perekam event realtime, dan pembantu HTTP untuk laporan/keputusan. Data sintetis.
 */
import { messages, roomMembers, rooms } from "@kapdh/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import type { Db } from "../../src/core/db/types.js";
import { RealtimeService, type RealtimeTransport } from "../../src/core/realtime/realtime.service.js";
import { directKeyOf } from "../../src/modules/moderation/blocks.service.js";
import type { TestClock } from "../support/fakes.js";
import { httpClient } from "../support/http.js";

interface Fixtures {
  db: Db;
  clock: TestClock;
}

export type MemberStatus = "invited" | "joined" | "left" | "removed" | "declined";

export async function createDirectRoom(t: Fixtures, a: string, b: string): Promise<string> {
  const now = t.clock.now();
  const id = uuidv7();
  await t.db.insert(rooms).values({
    id,
    kind: "direct",
    directKey: directKeyOf(a, b),
    createdBy: a,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  for (const userId of [a, b])
    await t.db.insert(roomMembers).values({
      roomId: id,
      userId,
      role: "member",
      status: "joined",
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

export async function createGroupRoom(
  t: Fixtures,
  options: { name?: string; adminId: string; avatarFileId?: string | null },
): Promise<string> {
  const now = t.clock.now();
  const id = uuidv7();
  await t.db.insert(rooms).values({
    id,
    kind: "group",
    name: options.name ?? "Grup Angkatan Uji",
    avatarFileId: options.avatarFileId ?? null,
    createdBy: options.adminId,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await addRoomMember(t, id, options.adminId, { role: "admin" });
  return id;
}

export async function addRoomMember(
  t: Fixtures,
  roomId: string,
  userId: string,
  options: {
    status?: MemberStatus;
    role?: "admin" | "member";
    invitedBy?: string | null;
    historyVisibleFrom?: Date | null;
  } = {},
): Promise<void> {
  const now = t.clock.now();
  const status = options.status ?? "joined";
  await t.db.insert(roomMembers).values({
    roomId,
    userId,
    role: options.role ?? "member",
    status,
    invitedBy: options.invitedBy ?? null,
    invitedAt: status === "invited" || options.invitedBy ? now : null,
    joinedAt: status === "invited" || status === "declined" ? null : now,
    leftAt: status === "left" || status === "removed" ? now : null,
    historyVisibleFrom: options.historyVisibleFrom ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

/** Pesan uji; created_at dari TestClock lalu jam dimajukan 1 detik agar urutan keyset jelas. */
export async function createMessage(
  t: Fixtures,
  roomId: string,
  senderId: string | null,
  options: { body?: string; kind?: "text" | "image" | "system"; imageFileId?: string | null } = {},
): Promise<string> {
  const now = t.clock.now();
  const id = uuidv7();
  const kind = options.kind ?? (options.imageFileId ? "image" : "text");
  await t.db.insert(messages).values({
    id,
    roomId,
    senderId,
    clientMessageId: kind === "system" ? null : uuidv7(),
    kind,
    body: kind === "image" ? (options.body ?? null) : (options.body ?? "Pesan uji"),
    imageFileId: options.imageFileId ?? null,
    createdAt: now,
  });
  await t.db.update(rooms).set({ lastMessageAt: now }).where(eq(rooms.id, roomId));
  t.clock.advance(1000);
  return id;
}

export interface RecordedEmit {
  channels: string[];
  event: string;
  data: { type: string; entity_id: string; payload: Record<string, unknown> };
}

/** Mengganti transport realtime dengan perekam (uji tanpa socket); mengembalikan daftar emit yang tercatat. */
export function recordRealtime(app: NestFastifyApplication): RecordedEmit[] {
  const recorded: RecordedEmit[] = [];
  const transport: RealtimeTransport = {
    kind: "gateway",
    emit: (channels, event, data) => {
      recorded.push({ channels: [...channels], event, data: data as RecordedEmit["data"] });
    },
    join: () => undefined,
    leave: () => undefined,
    disconnect: () => undefined,
  };
  app.get(RealtimeService).useTransport(transport);
  return recorded;
}

/** POST /reports dengan token anggota; mengembalikan respons mentah. */
export function postReport(
  app: NestFastifyApplication,
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return httpClient(app).post("/reports", body, { token, headers });
}

/** POST /reports yang wajib 201; mengembalikan id laporan. */
export async function reportOk(
  app: NestFastifyApplication,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await postReport(app, token, body);
  expect(res.statusCode, `laporan: ${res.body}`).toBe(201);
  return (res.json() as { id: string }).id;
}

/** Versi laporan terkini dari detail admin (If-Match). */
export async function reportVersion(
  app: NestFastifyApplication,
  adminToken: string,
  reportId: string,
): Promise<string> {
  const res = await httpClient(app).get(`/admin/reports/${reportId}`, { token: adminToken });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { version: string }).version;
}

export function resolveReport(
  app: NestFastifyApplication,
  adminToken: string,
  reportId: string,
  version: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return httpClient(app).post(`/admin/reports/${reportId}/resolve`, body, {
    token: adminToken,
    headers: { "if-match": version, ...headers },
  });
}
