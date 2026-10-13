/**
 * Room direct, grup, anggota dan undangan (F-11, F-12; AC F11-1, F11-4, F11-5, F12-1; PRD 3.11, 3.12; kontrak
 * domains/chat.yaml). PGlite: urutan dan keunikan; balapan nyata ada di test/pg/chat.pg.test.ts.
 */
import { blocks, files, messages, notifications, roomMembers, rooms } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTx } from "../../src/core/db/tx.js";
import { ChatLifecycleService } from "../../src/modules/chat/chat-lifecycle.service.js";
import { expectOperation } from "../support/contract.js";
import { setSetting } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  api,
  block,
  errorCode,
  groupWith,
  history,
  member,
  openDirect,
  sendRaw,
  sendText,
} from "./support.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

interface Room {
  id: string;
  kind: string;
  title: string;
  peer: { user_id: string; available: boolean } | null;
  can_send: boolean;
  send_restriction: string | null;
  can_manage: boolean;
  member_count: number;
  my_role: string;
  version: string;
  history_visible_from: string | null;
  unread_count: number;
  last_read_message_id: string | null;
  [key: string]: unknown;
}

const getRoom = async (token: string, roomId: string) => {
  const res = await api(t).get(`/chat/rooms/${roomId}`, { token });
  return { res, room: expectOperation("get", "/chat/rooms/{roomId}", res) as Room };
};

describe("AC F11-1: room direct kanonik", () => {
  it("AC F11-1: dibuka dari kedua pihak menghasilkan satu room dengan direct_key min:max (201 lalu 200)", async () => {
    const a = await member(t);
    const b = await member(t);
    const first = await api(t).post("/chat/direct", { user_id: b.userId }, { token: a.token });
    expect(first.statusCode).toBe(201);
    const room = expectOperation("post", "/chat/direct", first) as Room;
    const second = await api(t).post("/chat/direct", { user_id: a.userId }, { token: b.token });
    expect(second.statusCode).toBe(200);
    expect((expectOperation("post", "/chat/direct", second) as Room).id).toBe(room.id);
    const [row] = await t.db.select().from(rooms).where(eq(rooms.id, room.id));
    const [low, high] = [a.userId, b.userId].sort();
    expect(row!.directKey).toBe(`${low}:${high}`);
    expect(room).toMatchObject({
      kind: "direct",
      peer: { user_id: b.userId, available: true },
      can_send: true,
      send_restriction: null,
      can_manage: false,
      member_count: 2,
      name: null,
    });
    // Room direct tanpa pesan tidak muncul di daftar (kontrak listChatRooms).
    const list = await api(t).get("/chat/rooms", { token: a.token });
    expect((expectOperation("get", "/chat/rooms", list) as { items: Room[] }).items.map((r) => r.id)).not.toContain(
      room.id,
    );
  });

  it("AC F11-1 negatif: diri sendiri 400; lawan bicara nonaktif, tidak ada, atau tersembunyi dari direktori tanpa grup bersama 404", async () => {
    const a = await member(t);
    const self = await api(t).post("/chat/direct", { user_id: a.userId }, { token: a.token });
    expect([self.statusCode, errorCode(self)]).toEqual([400, "VALIDATION_ERROR"]);
    expectOperation("post", "/chat/direct", self);
    const invalid = await api(t).post("/chat/direct", { user_id: "bukan-uuid" }, { token: a.token });
    expect(invalid.statusCode).toBe(400);
    const hidden = await member(t, "verified", { showInDirectory: false });
    const expired = await member(t, "expired");
    const suspended = await member(t, "suspended");
    const messagesBefore = await t.db.select().from(rooms);
    for (const userId of [expired.userId, suspended.userId, hidden.userId, uuidv7()]) {
      const res = await api(t).post("/chat/direct", { user_id: userId }, { token: a.token });
      expect([res.statusCode, errorCode(res)]).toEqual([404, "NOT_FOUND"]);
      expectOperation("post", "/chat/direct", res);
    }
    expect((await t.db.select().from(rooms)).length).toBe(messagesBefore.length);
  });

  it("AC F11-1: anggota yang tersembunyi dari direktori tetap dapat dihubungi bila pernah satu grup", async () => {
    const a = await member(t);
    const hidden = await member(t, "verified", { showInDirectory: false });
    await groupWith(t, a, [hidden]);
    const res = await api(t).post("/chat/direct", { user_id: hidden.userId }, { token: a.token });
    expect(res.statusCode).toBe(201);
  });
});

describe("AC F12-1: blokir dua arah pada room direct", () => {
  it("AC F12-1: pemblokir mendapat 403 (blocked); pihak yang diblokir mendapat room lama dengan peer_unavailable atau 404 tanpa room", async () => {
    const a = await member(t);
    const b = await member(t);
    const c = await member(t);
    const room = await openDirect(t, a, b);
    await sendText(t, a, room.id, "Pesan sebelum blokir");
    await block(t, a, b);
    await block(t, c, a);

    // Pemanggil yang memblokir: 403 tanpa room baru, room lama tetap terbaca dengan restriction blocked.
    const opened = await api(t).post("/chat/direct", { user_id: b.userId }, { token: a.token });
    expect([opened.statusCode, errorCode(opened)]).toEqual([403, "FORBIDDEN"]);
    const viaA = await getRoom(a.token, room.id);
    expect(viaA.room).toMatchObject({ can_send: false, send_restriction: "blocked", peer: { available: true } });

    // Pihak yang diblokir tidak mengetahui blokir: peer_unavailable, sama dengan akun nonaktif (N-09).
    const reopened = await api(t).post("/chat/direct", { user_id: a.userId }, { token: b.token });
    expect(reopened.statusCode).toBe(200);
    expect(expectOperation("post", "/chat/direct", reopened)).toMatchObject({
      id: room.id,
      can_send: false,
      send_restriction: "peer_unavailable",
      peer: { user_id: a.userId, available: false },
    });
    // a diblokir c dan belum ada room: 404 yang sama dengan anggota tidak tersedia.
    const toBlocker = await api(t).post("/chat/direct", { user_id: c.userId }, { token: a.token });
    expect([toBlocker.statusCode, errorCode(toBlocker)]).toEqual([404, "NOT_FOUND"]);

    // Kirim dari pihak mana pun ditolak walau room sudah ada (AC F12-1); riwayat lama tetap ada (PRD 3.12).
    const fromA = await sendRaw(t, a, room.id, { kind: "text", body: "Masih?" });
    const fromB = await sendRaw(t, b, room.id, { kind: "text", body: "Halo?" });
    expect([fromA.statusCode, errorCode(fromA)]).toEqual([403, "FORBIDDEN"]);
    expect([fromB.statusCode, errorCode(fromB)]).toEqual([403, "FORBIDDEN"]);
    expectOperation("post", "/chat/rooms/{roomId}/messages", fromB);
    const historyB = await history(t, b, room.id);
    expect(historyB.body.items.map((m) => m.body)).toEqual(["Pesan sebelum blokir"]);
  });

  it("AC F12-1 / N-09: blokir oleh lawan bicara dan lawan bicara nonaktif memberi pesan galat yang sama", async () => {
    const a = await member(t);
    const blocker = await member(t);
    const lapsed = await member(t);
    const roomBlocked = await openDirect(t, a, blocker);
    const roomLapsed = await openDirect(t, a, lapsed);
    await block(t, blocker, a);
    const { alumni } = await import("@kapdh/database");
    await t.db
      .update(alumni)
      .set({ expiresAt: new Date(t.clock.now().getTime() - 1000) })
      .where(eq(alumni.userId, lapsed.userId));
    const blockedRes = await sendRaw(t, a, roomBlocked.id, { kind: "text", body: "Halo" });
    const lapsedRes = await sendRaw(t, a, roomLapsed.id, { kind: "text", body: "Halo" });
    expect(blockedRes.statusCode).toBe(403);
    expect(lapsedRes.statusCode).toBe(403);
    expect((blockedRes.json() as { message: string }).message).toBe(
      (lapsedRes.json() as { message: string }).message,
    );
    expect((await getRoom(a.token, roomBlocked.id)).room.send_restriction).toBe("peer_unavailable");
    expect((await getRoom(a.token, roomLapsed.id)).room.send_restriction).toBe("peer_unavailable");
  });

  it("AC F12-1: undangan grup antara pasangan yang saling memblokir dilewati (not_invitable); blokir baru membatalkan undangan tertunda", async () => {
    const admin = await member(t);
    const blocked = await member(t);
    const later = await member(t);
    await block(t, blocked, admin);
    const created = await api(t).post(
      "/chat/rooms",
      { name: "Grup Blokir", invitee_user_ids: [blocked.userId, later.userId] },
      { token: admin.token },
    );
    expect(created.statusCode).toBe(201);
    const body = expectOperation("post", "/chat/rooms", created) as {
      room: Room;
      invitations: { invited_user_ids: string[]; skipped: { user_id: string; reason: string }[] };
    };
    expect(body.invitations.invited_user_ids).toEqual([later.userId]);
    expect(body.invitations.skipped).toEqual([{ user_id: blocked.userId, reason: "not_invitable" }]);

    // Blokir baru (modul moderation memanggil ChatLifecycleService di transaksi blokir) membatalkan undangan.
    const lifecycle = t.app.get(ChatLifecycleService);
    await withTx(t.db, async (tx) => {
      await tx
        .insert(blocks)
        .values({ blockerId: later.userId, blockedId: admin.userId, createdAt: t.clock.now() });
      expect(await lifecycle.onBlockCreated(tx, later.userId, admin.userId)).toBe(1);
    });
    const invitations = await api(t).get("/chat/invitations", { token: later.token });
    expect((expectOperation("get", "/chat/invitations", invitations) as { items: unknown[] }).items).toEqual([]);
    const accept = await api(t).post(`/chat/invitations/${body.room.id}/accept`, {}, { token: later.token });
    expect(accept.statusCode).toBe(404);
  });
});

describe("Grup: undangan wajib diterima, kapasitas, admin (PRD 3.11)", () => {
  it("PRD 3.11: hanya admin grup yang mengundang; calon anggota wajib menerima; anggota baru hanya melihat pesan sejak bergabung", async () => {
    const admin = await member(t);
    const regular = await member(t);
    const newcomer = await member(t);
    const roomId = await groupWith(t, admin, [regular]);
    await sendText(t, admin, roomId, "Sebelum newcomer bergabung");

    const byMember = await api(t).post(
      `/chat/rooms/${roomId}/invitations`,
      { user_ids: [newcomer.userId] },
      { token: regular.token },
    );
    expect([byMember.statusCode, errorCode(byMember)]).toEqual([403, "FORBIDDEN"]);
    expectOperation("post", "/chat/rooms/{roomId}/invitations", byMember);

    const invited = await api(t).post(
      `/chat/rooms/${roomId}/invitations`,
      { user_ids: [newcomer.userId] },
      { token: admin.token },
    );
    expect(invited.statusCode).toBe(200);
    expect(expectOperation("post", "/chat/rooms/{roomId}/invitations", invited)).toEqual({
      invited_user_ids: [newcomer.userId],
      skipped: [],
    });
    // Belum menerima: bukan anggota (tidak dipaksa masuk), riwayat tertutup.
    expect((await api(t).get(`/chat/rooms/${roomId}/messages`, { token: newcomer.token })).statusCode).toBe(404);
    const pending = await api(t).get("/chat/invitations", { token: newcomer.token });
    const pendingBody = expectOperation("get", "/chat/invitations", pending) as {
      items: { room_id: string; invited_by: { user_id: string } | null; member_count: number }[];
    };
    expect(pendingBody.items).toHaveLength(1);
    expect(pendingBody.items[0]).toMatchObject({
      room_id: roomId,
      invited_by: { user_id: admin.userId },
      member_count: 2,
    });
    const [inbox] = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, newcomer.userId), eq(notifications.category, "chat")));
    expect(inbox?.data).toMatchObject({ route: "/chat/invitations", room_id: roomId });

    // Anggota biasa tidak melihat undangan tertunda (N-09); admin melihat.
    const asRegular = await api(t).get(`/chat/rooms/${roomId}/members`, {
      token: regular.token,
      query: { status: "invited" },
    });
    expect(asRegular.statusCode).toBe(403);
    const asAdmin = await api(t).get(`/chat/rooms/${roomId}/members`, {
      token: admin.token,
      query: { status: "invited" },
    });
    expect(
      (expectOperation("get", "/chat/rooms/{roomId}/members", asAdmin) as { items: { user_id: string }[] }).items.map(
        (m) => m.user_id,
      ),
    ).toEqual([newcomer.userId]);

    const accepted = await api(t).post(`/chat/invitations/${roomId}/accept`, {}, { token: newcomer.token });
    expect(accepted.statusCode).toBe(200);
    const room = expectOperation("post", "/chat/invitations/{roomId}/accept", accepted) as Room;
    expect(room.history_visible_from).not.toBeNull();
    expect(room).toMatchObject({ member_count: 3, my_role: "member", unread_count: 0 });
    const again = await api(t).post(`/chat/invitations/${roomId}/accept`, {}, { token: newcomer.token });
    expect(again.statusCode).toBe(200);

    const visible = await history(t, newcomer, roomId);
    expect(visible.body.items.map((m) => m.body)).not.toContain("Sebelum newcomer bergabung");
    expect(visible.body.items.map((m) => m.kind)).toEqual(["system"]);
    const sinceJoin = await sendText(t, regular, roomId, "Selamat datang");
    expect((await history(t, newcomer, roomId)).body.items.map((m) => m.id)).toContain(sinceJoin.id);
    // Anggota lama tetap melihat seluruh riwayat.
    expect((await history(t, regular, roomId)).body.items.map((m) => m.body)).toContain(
      "Sebelum newcomer bergabung",
    );

    const members = await api(t).get(`/chat/rooms/${roomId}/members`, { token: newcomer.token });
    const memberItems = (
      expectOperation("get", "/chat/rooms/{roomId}/members", members) as {
        items: { user_id: string; role: string; is_me: boolean }[];
      }
    ).items;
    expect(memberItems[0]).toMatchObject({ user_id: admin.userId, role: "admin" });
    expect(memberItems.find((m) => m.is_me)?.user_id).toBe(newcomer.userId);
  });

  it("PRD 3.11: tolak undangan idempoten (204); undangan ulang setelah ditolak diperbolehkan", async () => {
    const admin = await member(t);
    const invitee = await member(t);
    const created = await api(t).post(
      "/chat/rooms",
      { name: "Grup Tolak", invitee_user_ids: [invitee.userId] },
      { token: admin.token },
    );
    const roomId = (created.json() as { room: { id: string } }).room.id;
    const declined = await api(t).post(`/chat/invitations/${roomId}/decline`, {}, { token: invitee.token });
    expect(declined.statusCode).toBe(204);
    expectOperation("post", "/chat/invitations/{roomId}/decline", declined);
    expect((await api(t).post(`/chat/invitations/${roomId}/decline`, {}, { token: invitee.token })).statusCode).toBe(
      204,
    );
    const reinvite = await api(t).post(
      `/chat/rooms/${roomId}/invitations`,
      { user_ids: [invitee.userId] },
      { token: admin.token },
    );
    expect((reinvite.json() as { invited_user_ids: string[] }).invited_user_ids).toEqual([invitee.userId]);
    const stranger = await member(t);
    expect((await api(t).post(`/chat/invitations/${roomId}/decline`, {}, { token: stranger.token })).statusCode).toBe(
      404,
    );
  });

  it("PRD 3.11 (D5): kapasitas grup menghitung undangan tertunda dan alasan dilewati tidak membedakan penyebab", async () => {
    await setSetting(t, "chat", { max_text_chars: 4000, max_group_members: 3 });
    try {
      const admin = await member(t);
      const [m1, m2, m3] = [await member(t), await member(t), await member(t)];
      const expired = await member(t, "expired");
      const created = await api(t).post(
        "/chat/rooms",
        { name: "Grup Kecil", invitee_user_ids: [m1.userId, expired.userId, admin.userId, m2.userId, m3.userId] },
        { token: admin.token },
      );
      const outcome = (expectOperation("post", "/chat/rooms", created) as {
        invitations: { invited_user_ids: string[]; skipped: { user_id: string; reason: string }[] };
      }).invitations;
      expect(outcome.invited_user_ids).toEqual([m1.userId, m2.userId]);
      expect(outcome.skipped).toEqual([
        { user_id: expired.userId, reason: "not_invitable" },
        { user_id: admin.userId, reason: "not_invitable" },
        { user_id: m3.userId, reason: "room_full" },
      ]);
      const roomId = (created.json() as { room: { id: string } }).room.id;
      const again = await api(t).post(
        `/chat/rooms/${roomId}/invitations`,
        { user_ids: [m1.userId, m3.userId] },
        { token: admin.token },
      );
      expect(expectOperation("post", "/chat/rooms/{roomId}/invitations", again)).toEqual({
        invited_user_ids: [],
        skipped: [
          { user_id: m1.userId, reason: "already_invited" },
          { user_id: m3.userId, reason: "room_full" },
        ],
      });
      // Batas kontrak: maksimal 50 per permintaan dan tanpa duplikat.
      const duplicate = await api(t).post(
        `/chat/rooms/${roomId}/invitations`,
        { user_ids: [m3.userId, m3.userId] },
        { token: admin.token },
      );
      expect(duplicate.statusCode).toBe(400);
    } finally {
      await setSetting(t, "chat", { max_text_chars: 4000, max_group_members: 100 });
    }
  });

  it("AC F11-5: admin terakhir wajib menunjuk pengganti untuk keluar; admin terakhir tidak dapat diturunkan", async () => {
    const admin = await member(t);
    const m1 = await member(t);
    const m2 = await member(t);
    const roomId = await groupWith(t, admin, [m1, m2]);

    const withoutSuccessor = await api(t).post(`/chat/rooms/${roomId}/leave`, {}, { token: admin.token });
    expect([withoutSuccessor.statusCode, errorCode(withoutSuccessor)]).toEqual([400, "VALIDATION_ERROR"]);
    expect((withoutSuccessor.json() as { field_errors: Record<string, string[]> }).field_errors).toHaveProperty(
      "successor_user_id",
    );
    const demoteSelf = await api(t).patch(
      `/chat/rooms/${roomId}/members/${admin.userId}`,
      { role: "member" },
      { token: admin.token },
    );
    expect(demoteSelf.statusCode).toBe(400);
    expectOperation("patch", "/chat/rooms/{roomId}/members/{userId}", demoteSelf);
    const strangerSuccessor = await api(t).post(
      `/chat/rooms/${roomId}/leave`,
      { successor_user_id: uuidv7() },
      { token: admin.token },
    );
    expect(strangerSuccessor.statusCode).toBe(400);
    const notAdmin = await api(t).post(
      `/chat/rooms/${roomId}/leave`,
      { successor_user_id: m2.userId },
      { token: m1.token },
    );
    expect(notAdmin.statusCode).toBe(400);

    const left = await api(t).post(
      `/chat/rooms/${roomId}/leave`,
      { successor_user_id: m1.userId },
      { token: admin.token },
    );
    expect(left.statusCode).toBe(204);
    const viewM1 = await getRoom(m1.token, roomId);
    expect(viewM1.room).toMatchObject({ my_role: "admin", can_manage: true, member_count: 2 });
    expect((await api(t).get(`/chat/rooms/${roomId}`, { token: admin.token })).statusCode).toBe(404);

    // Anggota biasa keluar tanpa pengganti; anggota terakhir menutup grup.
    expect((await api(t).post(`/chat/rooms/${roomId}/leave`, {}, { token: m2.token })).statusCode).toBe(204);
    expect((await api(t).post(`/chat/rooms/${roomId}/leave`, {}, { token: m1.token })).statusCode).toBe(204);
    const [closed] = await t.db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(closed!.closedAt).not.toBeNull();
  });

  it("AC F11-5: promosi/turun peran oleh admin; anggota biasa tidak dapat mengelola; room direct tidak dapat ditinggalkan", async () => {
    const admin = await member(t);
    const m1 = await member(t);
    const roomId = await groupWith(t, admin, [m1]);
    const byMember = await api(t).patch(
      `/chat/rooms/${roomId}/members/${admin.userId}`,
      { role: "member" },
      { token: m1.token },
    );
    expect(byMember.statusCode).toBe(403);
    const promoted = await api(t).patch(
      `/chat/rooms/${roomId}/members/${m1.userId}`,
      { role: "admin" },
      { token: admin.token },
    );
    expect(promoted.statusCode).toBe(200);
    expect(expectOperation("patch", "/chat/rooms/{roomId}/members/{userId}", promoted)).toMatchObject({
      user_id: m1.userId,
      role: "admin",
      status: "joined",
    });
    const demoted = await api(t).patch(
      `/chat/rooms/${roomId}/members/${admin.userId}`,
      { role: "member" },
      { token: admin.token },
    );
    expect(demoted.statusCode).toBe(200);
    const unknown = await api(t).patch(
      `/chat/rooms/${roomId}/members/${uuidv7()}`,
      { role: "admin" },
      { token: m1.token },
    );
    expect(unknown.statusCode).toBe(404);

    const b = await member(t);
    const direct = await openDirect(t, admin, b);
    const leaveDirect = await api(t).post(`/chat/rooms/${direct.id}/leave`, {}, { token: admin.token });
    expect(leaveDirect.statusCode).toBe(400);
  });

  it("AC F11-4: admin mengeluarkan anggota (riwayat tertutup) dan membatalkan undangan tertunda", async () => {
    const admin = await member(t);
    const m1 = await member(t);
    const invitee = await member(t);
    const roomId = await groupWith(t, admin, [m1]);
    await api(t).post(`/chat/rooms/${roomId}/invitations`, { user_ids: [invitee.userId] }, { token: admin.token });

    const byMember = await api(t).delete(`/chat/rooms/${roomId}/members/${invitee.userId}`, { token: m1.token });
    expect(byMember.statusCode).toBe(403);
    const self = await api(t).delete(`/chat/rooms/${roomId}/members/${admin.userId}`, { token: admin.token });
    expect(self.statusCode).toBe(400);

    const removed = await api(t).delete(`/chat/rooms/${roomId}/members/${m1.userId}`, { token: admin.token });
    expect(removed.statusCode).toBe(204);
    expectOperation("delete", "/chat/rooms/{roomId}/members/{userId}", removed);
    expect((await api(t).get(`/chat/rooms/${roomId}/messages`, { token: m1.token })).statusCode).toBe(404);
    const [row] = await t.db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, m1.userId)));
    expect(row!.status).toBe("removed");

    const cancelled = await api(t).delete(`/chat/rooms/${roomId}/members/${invitee.userId}`, { token: admin.token });
    expect(cancelled.statusCode).toBe(204);
    expect((await api(t).post(`/chat/invitations/${roomId}/accept`, {}, { token: invitee.token })).statusCode).toBe(
      404,
    );
    expect((await api(t).delete(`/chat/rooms/${roomId}/members/${m1.userId}`, { token: admin.token })).statusCode).toBe(
      404,
    );
  });
});

describe("Info grup: ubah nama/avatar dengan If-Match, mute", () => {
  it("PATCH room: If-Match wajib, versi lama 409 dengan current, hanya admin, room direct 400", async () => {
    const admin = await member(t);
    const m1 = await member(t);
    const roomId = await groupWith(t, admin, [m1]);
    const { room } = await getRoom(admin.token, roomId);

    const noIfMatch = await api(t).patch(`/chat/rooms/${roomId}`, { name: "Baru" }, { token: admin.token });
    expect(noIfMatch.statusCode).toBe(400);
    const byMember = await api(t).patch(
      `/chat/rooms/${roomId}`,
      { name: "Baru" },
      { token: m1.token, headers: { "if-match": room.version } },
    );
    expect(byMember.statusCode).toBe(403);
    const avatar = await uploadTestFile(t, admin.token, "chat_image");
    const renamed = await api(t).patch(
      `/chat/rooms/${roomId}`,
      { name: "  Angkatan 29 Bandung  ", avatar_file_id: avatar.id },
      { token: admin.token, headers: { "if-match": room.version } },
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    const updated = expectOperation("patch", "/chat/rooms/{roomId}", renamed) as Room & {
      name: string;
      avatar_url: string | null;
    };
    expect(updated.name).toBe("Angkatan 29 Bandung");
    expect(updated.avatar_url).toMatch(/\/api\/v1\/files\/content\//);
    expect(Number(updated.version)).toBe(Number(room.version) + 1);
    const stale = await api(t).patch(
      `/chat/rooms/${roomId}`,
      { name: "Lain" },
      { token: admin.token, headers: { "if-match": room.version } },
    );
    expect([stale.statusCode, errorCode(stale)]).toEqual([409, "VERSION_CONFLICT"]);
    expect((stale.json() as { current: { version: string } }).current.version).toBe(updated.version);
    // Avatar lama dilepas saat diganti (tidak dirujuk bukti laporan).
    const removedAvatar = await api(t).patch(
      `/chat/rooms/${roomId}`,
      { avatar_file_id: null },
      { token: admin.token, headers: { "if-match": updated.version } },
    );
    expect(removedAvatar.statusCode).toBe(200);
    const [oldFile] = await t.db.select().from(files).where(eq(files.id, avatar.id));
    expect(oldFile!.status).toBe("deleted");
    const harmful = await api(t).patch(
      `/chat/rooms/${roomId}`,
      { name: "Grup \u202Eevil" },
      { token: admin.token, headers: { "if-match": String(Number(updated.version) + 1) } },
    );
    expect(harmful.statusCode).toBe(400);

    const b = await member(t);
    const direct = await openDirect(t, admin, b);
    const directPatch = await api(t).patch(
      `/chat/rooms/${direct.id}`,
      { name: "X" },
      { token: admin.token, headers: { "if-match": "1" } },
    );
    expect(directPatch.statusCode).toBe(400);
  });

  it("mute hanya menahan push; idempoten; bukan anggota 404", async () => {
    const a = await member(t);
    const b = await member(t);
    const room = await openDirect(t, a, b);
    const muted = await api(t).put(`/chat/rooms/${room.id}/mute`, { muted: true }, { token: b.token });
    expect(muted.statusCode).toBe(204);
    expectOperation("put", "/chat/rooms/{roomId}/mute", muted);
    expect((await api(t).put(`/chat/rooms/${room.id}/mute`, { muted: true }, { token: b.token })).statusCode).toBe(204);
    expect((await getRoom(b.token, room.id)).room.muted).toBe(true);
    await sendText(t, a, room.id, "Pesan saat dibisukan");
    const pushes = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, b.userId), eq(notifications.category, "chat")));
    expect(pushes).toEqual([]);
    const invalid = await api(t).put(`/chat/rooms/${room.id}/mute`, { muted: "ya" }, { token: b.token });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("Daftar room (tab Pesan / Pesan Grup)", () => {
  it("urut aktivitas terakhir, saring jenis, unread dibatasi, lencana undangan dan room belum dibaca, paging keyset tanpa duplikasi", async () => {
    const me = await member(t);
    const peers = [await member(t), await member(t), await member(t)];
    const directRooms = [];
    for (const peer of peers) {
      const room = await openDirect(t, peer, me);
      directRooms.push(room.id);
      await sendText(t, peer, room.id, `Halo dari ${peer.userId}`);
    }
    const groupId = await groupWith(t, peers[0]!, [me]);
    await sendText(t, peers[0]!, groupId, "Info grup");
    // Undangan tertunda lain untuk lencana.
    await api(t).post("/chat/rooms", { name: "Undangan", invitee_user_ids: [me.userId] }, { token: peers[1]!.token });

    const all = await api(t).get("/chat/rooms", { token: me.token });
    const page = expectOperation("get", "/chat/rooms", all) as {
      items: (Room & { last_message: { preview: string | null; kind: string } | null })[];
      pending_invitation_count: number;
      unread_room_count: number;
    };
    expect(page.items.map((r) => r.id)).toEqual([groupId, ...[...directRooms].reverse()]);
    expect(page.items[0]!.last_message).toMatchObject({ preview: "Info grup", kind: "text" });
    expect(page.items[1]!).toMatchObject({ unread_count: 1, kind: "direct" });
    expect(page.pending_invitation_count).toBe(1);
    expect(page.unread_room_count).toBe(4);

    const groups = await api(t).get("/chat/rooms", { token: me.token, query: { kind: "group" } });
    expect((groups.json() as { items: Room[] }).items.map((r) => r.id)).toEqual([groupId]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await api(t).get("/chat/rooms", {
        token: me.token,
        query: { limit: "2", ...(cursor ? { cursor } : {}) },
      });
      const body = expectOperation("get", "/chat/rooms", res) as { items: Room[]; next_cursor: string | null };
      seen.push(...body.items.map((r) => r.id));
      cursor = body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(page.items.map((r) => r.id));
    const broken = await api(t).get("/chat/rooms", { token: me.token, query: { cursor: "rusak!!" } });
    expect(broken.statusCode).toBe(400);
  });
});

describe("Pesan sistem dan urutan (aturan C6)", () => {
  it("AC F11-3: pesan sistem mengikuti aturan urutan; created_at naik ketat dan rooms.last_message_at = pesan terakhir", async () => {
    const admin = await member(t);
    const m1 = await member(t);
    const roomId = await groupWith(t, admin, [m1]);
    await sendText(t, m1, roomId, "satu");
    await sendText(t, admin, roomId, "dua");
    const all = await t.db.select().from(messages).where(eq(messages.roomId, roomId));
    const { rows } = await import("../../src/core/db/rows.js");
    const { sql } = await import("drizzle-orm");
    const ordered = rows<{ id: string; strictly: boolean; last_ok: boolean }>(
      await t.db.execute(sql`
        select m.id,
          coalesce(m.created_at > lag(m.created_at) over (order by m.created_at, m.id), true) as strictly,
          (select r.last_message_at from app.rooms r where r.id = m.room_id) =
            max(m.created_at) over () as last_ok
        from app.messages m where m.room_id = ${roomId}::uuid order by m.created_at, m.id`),
    );
    expect(ordered).toHaveLength(all.length);
    expect(ordered.every((row) => row.strictly && row.last_ok)).toBe(true);
    expect(all.filter((m) => m.kind === "system").length).toBeGreaterThanOrEqual(2);
  });
});
