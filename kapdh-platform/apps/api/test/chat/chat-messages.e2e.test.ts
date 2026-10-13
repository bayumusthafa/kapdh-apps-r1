/**
 * Pesan, riwayat keyset, reaksi, hapus, read cursor dan push chat (F-11; AC F11-2, F11-3, F11-6, F12-1; PRD 3.11;
 * kontrak domains/chat.yaml). Balapan nyata (duplikat bersamaan, read cursor bersamaan) ada di test/pg/chat.pg.test.ts.
 */
import {
  alumni,
  files,
  messageReactions,
  messages,
  notificationPreferences,
  notifications,
  reports,
} from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEmoji } from "../../src/modules/chat/chat-messages.service.js";
import { harmfulContentReason } from "../../src/modules/chat/content-filter.js";
import { expectOperation } from "../support/contract.js";
import { uploadTestFile } from "../support/files.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  api,
  block,
  errorCode,
  groupWith,
  history,
  type Member,
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

const reactionPath = (roomId: string, messageId: string, emoji: string) =>
  `/chat/rooms/${roomId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`;

async function pair(): Promise<[Member, Member, string]> {
  const a = await member(t);
  const b = await member(t);
  const room = await openDirect(t, a, b);
  return [a, b, room.id];
}

describe("AC F11-2: kirim pesan, ack sesudah commit, client_message_id idempoten", () => {
  it("AC F11-2: pesan valid 201 sesudah commit; pengulangan client_message_id mengembalikan pesan yang sama (200) tanpa pesan baru", async () => {
    const [a, , roomId] = await pair();
    const clientMessageId = uuidv7();
    const first = await sendRaw(t, a, roomId, { client_message_id: clientMessageId, kind: "text", body: "Halo" });
    expect(first.statusCode).toBe(201);
    const message = expectOperation("post", "/chat/rooms/{roomId}/messages", first) as {
      id: string;
      client_message_id: string;
      sender: { user_id: string };
    };
    expect(message).toMatchObject({ client_message_id: clientMessageId, sender: { user_id: a.userId } });
    // Ack sesudah commit: pesan sudah terbaca di database saat respons tiba.
    const [stored] = await t.db.select().from(messages).where(eq(messages.id, message.id));
    expect(stored?.body).toBe("Halo");

    const retry = await sendRaw(t, a, roomId, { client_message_id: clientMessageId, kind: "text", body: "Halo" });
    expect(retry.statusCode).toBe(200);
    expect((expectOperation("post", "/chat/rooms/{roomId}/messages", retry) as { id: string }).id).toBe(message.id);
    const all = await t.db
      .select()
      .from(messages)
      .where(and(eq(messages.senderId, a.userId), eq(messages.clientMessageId, clientMessageId)));
    expect(all).toHaveLength(1);

    const conflict = await sendRaw(t, a, roomId, {
      client_message_id: clientMessageId,
      kind: "text",
      body: "Isi lain",
    });
    expect([conflict.statusCode, errorCode(conflict)]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
    expectOperation("post", "/chat/rooms/{roomId}/messages", conflict);
    // client_message_id unik per PENGIRIM: pengguna lain boleh memakai nilai yang sama.
    const [, b2, room2] = await pair();
    const other = await sendRaw(t, b2, room2, { client_message_id: clientMessageId, kind: "text", body: "Halo" });
    expect(other.statusCode).toBe(201);
  });

  it("validasi pesan: kosong/spasi, > 4.000 karakter, konten berbahaya, gambar tanpa berkas, teks dengan lampiran, balasan dari room lain", async () => {
    const [a, b, roomId] = await pair();
    const [c, , otherRoom] = await pair();
    const elsewhere = await sendText(t, b, roomId, "Pesan di room ini");
    const foreign = await sendText(t, c, otherRoom, "Pesan di room lain");
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "text", body: "balas", reply_to_id: foreign.id }, "reply_to_id"],
      [{ kind: "text", body: "   " }, "body"],
      [{ kind: "text" }, "body"],
      [{ kind: "text", body: "x".repeat(4001) }, "body"],
      [{ kind: "text", body: "Klik <a href=javascript:alert(1)>" }, "body"],
      [{ kind: "text", body: "nama\u202Efdp.exe" }, "body"],
      [{ kind: "image" }, "image_file_id"],
      [{ kind: "image", image_file_id: uuidv7() }, "image_file_id"],
      [{ kind: "text", body: "teks", image_file_id: uuidv7() }, "image_file_id"],
      [{ kind: "text", body: "balas", reply_to_id: uuidv7() }, "reply_to_id"],
      [{ kind: "video", body: "x" }, "kind"],
    ];
    for (const [payload, field] of cases) {
      const res = await sendRaw(t, a, roomId, payload);
      expect([res.statusCode, errorCode(res)], JSON.stringify(payload).slice(0, 80)).toEqual([
        400,
        "VALIDATION_ERROR",
      ]);
      expect(Object.keys((res.json() as { field_errors: Record<string, unknown> }).field_errors)).toContain(field);
      expectOperation("post", "/chat/rooms/{roomId}/messages", res);
    }
    // 4.000 karakter (code point, termasuk emoji) diterima; balasan di room yang sama diterima.
    const emojiBody = "😀".repeat(4000);
    expect((await sendRaw(t, a, roomId, { kind: "text", body: emojiBody })).statusCode).toBe(201);
    const reply = await sendText(t, a, roomId, "Balasan", { reply_to_id: elsewhere.id });
    expect(reply.reply_to).toMatchObject({ id: elsewhere.id, available: true, preview: "Pesan di room ini" });
  });

  it("filter dasar konten berbahaya (PRD 3.12) tidak menolak teks wajar", () => {
    for (const ok of [
      "Saya belajar javascript: dasar variabel",
      "Link https://kapdh.or.id/acara",
      "Baris\nbaru\tdan tab",
      "Emoji 👍🏽 dan 🇮🇩",
    ])
      expect(harmfulContentReason(ok), ok).toBeNull();
    for (const bad of ["javascript:alert(1)", "data:text/html;base64,AAAA", "a\u0000b", "x\u202Ey"])
      expect(harmfulContentReason(bad), bad).not.toBeNull();
  });

  it("AC F11-2 + PRD 5.4: pesan gambar memakai berkas chat_image milik pengirim yang belum terpakai; anggota lain dapat membuka gambarnya", async () => {
    const [a, b, roomId] = await pair();
    const image = await uploadTestFile(t, a.token, "chat_image");
    const sent = await sendRaw(t, a, roomId, { kind: "image", image_file_id: image.id, body: "Foto acara" });
    expect(sent.statusCode, sent.body).toBe(201);
    const message = expectOperation("post", "/chat/rooms/{roomId}/messages", sent) as {
      image: { file_id: string; url: string; mime: string; url_expires_at: string };
    };
    expect(message.image).toMatchObject({ file_id: image.id, mime: "image/jpeg" });
    const page = await history(t, b, roomId);
    const asSeenByB = page.body.items.find((m) => m.id === (sent.json() as { id: string }).id) as unknown as {
      image: { url: string };
    };
    const content = await t.app.inject({ method: "GET", url: asSeenByB.image.url.slice(t.env.API_PUBLIC_URL.length) });
    expect(content.statusCode).toBe(200);
    // Berkas yang sama tidak dapat dipakai dua kali; berkas milik orang lain ditolak.
    const reuse = await sendRaw(t, a, roomId, { kind: "image", image_file_id: image.id });
    expect(reuse.statusCode).toBe(400);
    const notMine = await uploadTestFile(t, b.token, "chat_image");
    expect((await sendRaw(t, a, roomId, { kind: "image", image_file_id: notMine.id })).statusCode).toBe(400);
    const avatar = await uploadTestFile(t, a.token, "avatar");
    expect((await sendRaw(t, a, roomId, { kind: "image", image_file_id: avatar.id })).statusCode).toBe(400);
  });

  it("AC F11-6: pengirim yang menjadi expired/suspended saat tersambung ditolak 403 dan tidak ada pesan tersimpan", async () => {
    const [a, b, roomId] = await pair();
    await sendText(t, a, roomId, "Masih aktif");
    await t.db
      .update(alumni)
      .set({ expiresAt: new Date(t.clock.now().getTime() - 1000) })
      .where(eq(alumni.userId, a.userId));
    const expired = await sendRaw(t, a, roomId, { kind: "text", body: "Setelah expired" });
    expect([expired.statusCode, errorCode(expired)]).toEqual([403, "MEMBERSHIP_REQUIRED"]);
    await t.db
      .update(alumni)
      .set({ suspendedAt: t.clock.now(), suspensionReason: "uji" })
      .where(eq(alumni.userId, b.userId));
    const suspended = await sendRaw(t, b, roomId, { kind: "text", body: "Setelah suspend" });
    expect([suspended.statusCode, errorCode(suspended)]).toEqual([403, "ACCOUNT_SUSPENDED"]);
    const stored = await t.db.select().from(messages).where(eq(messages.roomId, roomId));
    expect(stored.map((m) => m.body)).toEqual(["Masih aktif"]);
  });
});

describe("AC F11-3: riwayat keyset (created_at, id) dan sinkron setelah reconnect", () => {
  it("AC F11-3: halaman terbaru, before, after tanpa celah/duplikasi; urut naik; jangkar wajib pesan room ini", async () => {
    const [a, b, roomId] = await pair();
    const sent: string[] = [];
    for (let i = 0; i < 7; i++) sent.push((await sendText(t, i % 2 ? b : a, roomId, `pesan ${i}`)).id);

    const latest = await history(t, a, roomId, { limit: "3" });
    expect(latest.body.items.map((m) => m.id)).toEqual(sent.slice(4));
    expect(latest.body.next_cursor).toBe(sent[4]);
    const older = await history(t, a, roomId, { limit: "3", before: latest.body.next_cursor! });
    expect(older.body.items.map((m) => m.id)).toEqual(sent.slice(1, 4));
    const oldest = await history(t, a, roomId, { limit: "3", before: older.body.next_cursor! });
    expect(oldest.body.items.map((m) => m.id)).toEqual(sent.slice(0, 1));
    expect(oldest.body.next_cursor).toBeNull();

    // Sinkron: jangkar = pesan terbaru dari halaman HTTP; pesan yang commit sesudahnya diambil lewat after.
    const anchor = sent[2]!;
    const collected: string[] = [];
    let cursor: string | null = anchor;
    while (cursor) {
      const page = await history(t, b, roomId, { limit: "2", after: cursor });
      collected.push(...page.body.items.map((m) => m.id));
      cursor = page.body.next_cursor;
    }
    expect(collected).toEqual(sent.slice(3));

    const both = await history(t, a, roomId, { before: sent[3]!, after: sent[1]! });
    expect(both.res.statusCode).toBe(400);
    const [, , otherRoom] = await pair();
    const foreignAnchor = await history(t, a, roomId, { after: otherRoom });
    expect(foreignAnchor.res.statusCode).toBe(400);
    const bad = await history(t, a, roomId, { limit: "101" });
    expect(bad.res.statusCode).toBe(400);
  });

  it("AC F11-3: pesan yang commit selama klien terputus diambil seluruhnya lewat after=<jangkar> tanpa duplikasi", async () => {
    const [a, b, roomId] = await pair();
    await sendText(t, a, roomId, "sebelum putus");
    const anchorPage = await history(t, b, roomId);
    const anchor = anchorPage.body.items.at(-1)!.id;
    // Klien b "terputus": a mengirim beberapa pesan.
    const missed: string[] = [];
    for (let i = 0; i < 5; i++) missed.push((await sendText(t, a, roomId, `saat putus ${i}`)).id);
    const synced = await history(t, b, roomId, { after: anchor });
    expect(synced.body.items.map((m) => m.id)).toEqual(missed);
    expect(synced.body.next_cursor).toBeNull();
    const again = await history(t, b, roomId, { after: missed.at(-1)! });
    expect(again.body.items).toEqual([]);
  });

  it("PRD 3.11: anggota baru tidak dapat memakai pesan sebelum bergabung sebagai jangkar, balasan, atau target baca", async () => {
    const admin = await member(t);
    const early = await member(t);
    const roomId = await groupWith(t, admin, [early]);
    const old = await sendText(t, admin, roomId, "Lama");
    const newcomer = await member(t);
    await api(t).post(`/chat/rooms/${roomId}/invitations`, { user_ids: [newcomer.userId] }, { token: admin.token });
    await api(t).post(`/chat/invitations/${roomId}/accept`, {}, { token: newcomer.token });
    expect((await history(t, newcomer, roomId, { after: old.id })).res.statusCode).toBe(400);
    expect((await sendRaw(t, newcomer, roomId, { kind: "text", body: "x", reply_to_id: old.id })).statusCode).toBe(400);
    const read = await api(t).put(`/chat/rooms/${roomId}/read`, { message_id: old.id }, { token: newcomer.token });
    expect(read.statusCode).toBe(400);
    // Balasan anggota lama ke pesan lama tampil bagi anggota baru tanpa pratinjau (di luar riwayatnya).
    const reply = await sendText(t, early, roomId, "Membalas pesan lama", { reply_to_id: old.id });
    const seen = (await history(t, newcomer, roomId)).body.items.find((m) => m.id === reply.id)!;
    expect(seen.reply_to).toEqual({ id: old.id, available: false, sender_name: null, preview: null, has_image: false });
  });
});

describe("Hapus pesan sendiri (placeholder) dan bukti laporan", () => {
  it("hapus pesan sendiri menjadi placeholder idempoten; pesan orang lain/sistem 403; reaksi dan gambar ikut dikosongkan", async () => {
    const [a, b, roomId] = await pair();
    const image = await uploadTestFile(t, a.token, "chat_image");
    const sent = await sendRaw(t, a, roomId, { kind: "image", image_file_id: image.id, body: "Keterangan" });
    const id = (sent.json() as { id: string }).id;
    expect((await api(t).put(reactionPath(roomId, id, "👍"), {}, { token: b.token })).statusCode).toBe(200);

    const byOther = await api(t).delete(`/chat/rooms/${roomId}/messages/${id}`, { token: b.token });
    expect([byOther.statusCode, errorCode(byOther)]).toEqual([403, "FORBIDDEN"]);
    const deleted = await api(t).delete(`/chat/rooms/${roomId}/messages/${id}`, { token: a.token });
    expect(deleted.statusCode).toBe(200);
    expect(expectOperation("delete", "/chat/rooms/{roomId}/messages/{messageId}", deleted)).toMatchObject({
      id,
      body: null,
      image: null,
      reactions: [],
    });
    expect((deleted.json() as { deleted_at: string | null }).deleted_at).not.toBeNull();
    const again = await api(t).delete(`/chat/rooms/${roomId}/messages/${id}`, { token: a.token });
    expect(again.statusCode).toBe(200);
    expect(await t.db.select().from(messageReactions).where(eq(messageReactions.messageId, id))).toEqual([]);
    const [file] = await t.db.select().from(files).where(eq(files.id, image.id));
    expect(file!.status).toBe("deleted");
    // Urutan keyset stabil: placeholder tetap di riwayat.
    expect((await history(t, b, roomId)).body.items.find((m) => m.id === id)).toMatchObject({ body: null });

    const admin = await member(t);
    const groupId = await groupWith(t, admin, [b]);
    const system = (await history(t, admin, groupId)).body.items.find((m) => m.kind === "system")!;
    const sys = await api(t).delete(`/chat/rooms/${groupId}/messages/${system.id}`, { token: admin.token });
    expect(sys.statusCode).toBe(403);
    expect((await api(t).delete(`/chat/rooms/${roomId}/messages/${uuidv7()}`, { token: a.token })).statusCode).toBe(
      404,
    );
  });

  it("PRD 3.12: gambar pesan yang dirujuk bukti laporan tidak ikut terhapus saat pengirim menghapus pesannya", async () => {
    const [a, b, roomId] = await pair();
    const image = await uploadTestFile(t, a.token, "chat_image");
    const sent = await sendRaw(t, a, roomId, { kind: "image", image_file_id: image.id });
    const id = (sent.json() as { id: string }).id;
    await t.db.insert(reports).values({
      id: uuidv7(),
      reporterId: b.userId,
      targetType: "message",
      targetUserId: a.userId,
      targetMessageId: id,
      roomId,
      category: "harassment",
      evidence: { messages: [{ message_id: id, image: { file_id: image.id } }] },
      dueAt: new Date(t.clock.now().getTime() + 86_400_000),
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });
    expect((await api(t).delete(`/chat/rooms/${roomId}/messages/${id}`, { token: a.token })).statusCode).toBe(200);
    const [file] = await t.db.select().from(files).where(eq(files.id, image.id));
    expect(file!.status).toBe("ready");
  });
});

describe("Reaksi emoji (PRD 6.4)", () => {
  it("tambah/hapus idempoten dengan ringkasan; maksimal 10 emoji per pengguna; pesan terhapus/sistem 400; emoji tidak sah 400", async () => {
    const [a, b, roomId] = await pair();
    const msg = await sendText(t, a, roomId, "Beri reaksi");
    const add = await api(t).put(reactionPath(roomId, msg.id, "👍"), {}, { token: b.token });
    expect(add.statusCode).toBe(200);
    expect(expectOperation("put", "/chat/rooms/{roomId}/messages/{messageId}/reactions/{emoji}", add)).toEqual({
      message_id: msg.id,
      reactions: [{ emoji: "👍", count: 1, reacted_by_me: true }],
    });
    await api(t).put(reactionPath(roomId, msg.id, "👍"), {}, { token: b.token });
    const byA = await api(t).put(reactionPath(roomId, msg.id, "👍"), {}, { token: a.token });
    expect((byA.json() as { reactions: unknown[] }).reactions).toEqual([
      { emoji: "👍", count: 2, reacted_by_me: true },
    ]);
    const viewB = (await history(t, b, roomId)).body.items.find((m) => m.id === msg.id)!;
    expect(viewB.reactions).toEqual([{ emoji: "👍", count: 2, reacted_by_me: true }]);

    const removed = await api(t).delete(reactionPath(roomId, msg.id, "👍"), { token: b.token });
    expect(removed.statusCode).toBe(200);
    expect(
      expectOperation("delete", "/chat/rooms/{roomId}/messages/{messageId}/reactions/{emoji}", removed),
    ).toEqual({ message_id: msg.id, reactions: [{ emoji: "👍", count: 1, reacted_by_me: false }] });
    expect((await api(t).delete(reactionPath(roomId, msg.id, "👍"), { token: b.token })).statusCode).toBe(200);

    const emojis = ["😀", "😂", "😍", "🙏", "🎉", "🔥", "👏", "❤️", "🇮🇩", "1️⃣"];
    for (const emoji of emojis)
      expect((await api(t).put(reactionPath(roomId, msg.id, emoji), {}, { token: b.token })).statusCode, emoji).toBe(
        200,
      );
    const eleventh = await api(t).put(reactionPath(roomId, msg.id, "😎"), {}, { token: b.token });
    expect(eleventh.statusCode).toBe(400);
    // Mengulang emoji yang sudah ada tetap idempoten walau sudah 10.
    expect((await api(t).put(reactionPath(roomId, msg.id, "😀"), {}, { token: b.token })).statusCode).toBe(200);

    for (const bad of ["ab", "👍👍", "x", "😀😀😀"])
      expect((await api(t).put(reactionPath(roomId, msg.id, bad), {}, { token: b.token })).statusCode, bad).toBe(400);
    expect(() => parseEmoji("👩‍👩‍👧‍👦")).not.toThrow();

    await api(t).delete(`/chat/rooms/${roomId}/messages/${msg.id}`, { token: a.token });
    expect((await api(t).put(reactionPath(roomId, msg.id, "👍"), {}, { token: b.token })).statusCode).toBe(400);
  });

  it("AC F12-1: reaksi di room direct ditolak bila ada blokir dari salah satu pihak (pesan galat sama)", async () => {
    const [a, b, roomId] = await pair();
    const msg = await sendText(t, a, roomId, "Sebelum blokir");
    await block(t, a, b);
    const fromB = await api(t).put(reactionPath(roomId, msg.id, "👍"), {}, { token: b.token });
    const fromA = await api(t).put(reactionPath(roomId, msg.id, "👍"), {}, { token: a.token });
    expect([fromB.statusCode, fromA.statusCode]).toEqual([403, 403]);
    expect((fromA.json() as { message: string }).message).toBe((fromB.json() as { message: string }).message);
    expectOperation("put", "/chat/rooms/{roomId}/messages/{messageId}/reactions/{emoji}", fromB);
  });
});

describe("AC F11-4: ID pesan dari room lain tidak memberi akses (UUID bukan izin)", () => {
  it("AC F11-4 negatif: anggota room X memakai ID pesan room Y pada path room X → 404/400 tanpa efek pada pesan Y", async () => {
    const [a, b, roomX] = await pair();
    const [c, d, roomY] = await pair();
    const foreign = await sendText(t, c, roomY, "Pesan room Y");
    const own = await sendText(t, a, roomX, "Pesan room X");
    for (const res of [
      await api(t).delete(`/chat/rooms/${roomX}/messages/${foreign.id}`, { token: a.token }),
      await api(t).put(reactionPath(roomX, foreign.id, "👍"), {}, { token: a.token }),
      await api(t).delete(reactionPath(roomX, foreign.id, "👍"), { token: a.token }),
    ]) {
      expect([res.statusCode, errorCode(res)]).toEqual([404, "NOT_FOUND"]);
      expect(res.body).not.toContain("Pesan room Y");
    }
    const read = await api(t).put(`/chat/rooms/${roomX}/read`, { message_id: foreign.id }, { token: b.token });
    expect([read.statusCode, errorCode(read)]).toEqual([400, "VALIDATION_ERROR"]);
    const anchor = await history(t, a, roomX, { before: foreign.id });
    expect(anchor.res.statusCode).toBe(400);
    // Pesan room Y tidak berubah; pemilik room X juga tidak dapat dipakai pihak Y.
    const [stored] = await t.db.select().from(messages).where(eq(messages.id, foreign.id));
    expect(stored).toMatchObject({ body: "Pesan room Y", deletedAt: null });
    expect(await t.db.select().from(messageReactions).where(eq(messageReactions.messageId, foreign.id))).toEqual([]);
    const crossDelete = await api(t).delete(`/chat/rooms/${roomY}/messages/${own.id}`, { token: d.token });
    expect(crossDelete.statusCode).toBe(404);
  });
});

describe("Read cursor monoton (PRD 3.11)", () => {
  it("read cursor maju, paket terlambat tidak memundurkan, unread dihitung dari anggota lain", async () => {
    const [a, b, roomId] = await pair();
    const m1 = await sendText(t, a, roomId, "satu");
    const m2 = await sendText(t, a, roomId, "dua");
    const m3 = await sendText(t, a, roomId, "tiga");
    const before = await api(t).get(`/chat/rooms/${roomId}`, { token: b.token });
    expect((before.json() as { unread_count: number }).unread_count).toBe(3);

    const read2 = await api(t).put(`/chat/rooms/${roomId}/read`, { message_id: m2.id }, { token: b.token });
    expect(read2.statusCode).toBe(200);
    expect(expectOperation("put", "/chat/rooms/{roomId}/read", read2)).toMatchObject({
      room_id: roomId,
      last_read_message_id: m2.id,
      unread_count: 1,
    });
    const late = await api(t).put(`/chat/rooms/${roomId}/read`, { message_id: m1.id }, { token: b.token });
    expect(late.statusCode).toBe(200);
    expect((late.json() as { last_read_message_id: string }).last_read_message_id).toBe(m2.id);
    const read3 = await api(t).put(`/chat/rooms/${roomId}/read`, { message_id: m3.id }, { token: b.token });
    expect((read3.json() as { unread_count: number }).unread_count).toBe(0);
    // Status "terbaca" room direct untuk pengirim.
    const asA = await api(t).get(`/chat/rooms/${roomId}`, { token: a.token });
    expect((asA.json() as { peer_last_read_message_id: string }).peer_last_read_message_id).toBe(m3.id);
    // Pesan sendiri tidak dihitung unread; pengirim otomatis membaca pesannya.
    expect((asA.json() as { unread_count: number; last_read_message_id: string }).unread_count).toBe(0);
    const invalid = await api(t).put(`/chat/rooms/${roomId}/read`, { message_id: uuidv7() }, { token: b.token });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("Push chat tanpa isi pesan (PRD 3.13, kontrak sendChatMessage)", () => {
  it("push hanya untuk anggota aktif, tidak mute, preferensi chat menyala; satu notifikasi per episode belum dibaca, tanpa isi pesan", async () => {
    const admin = await member(t);
    const active = await member(t);
    const optedOut = await member(t);
    const lapsing = await member(t);
    const roomId = await groupWith(t, admin, [active, optedOut, lapsing], "Grup Push");
    await t.db.insert(notificationPreferences).values({
      userId: optedOut.userId,
      category: "chat",
      channel: "push",
      enabled: false,
      updatedAt: t.clock.now(),
    });
    await t.db
      .update(alumni)
      .set({ expiresAt: new Date(t.clock.now().getTime() - 1000) })
      .where(eq(alumni.userId, lapsing.userId));
    const chatInbox = (userId: string) =>
      t.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, userId), eq(notifications.category, "chat")));
    const before = (await chatInbox(active.userId)).length;

    await sendText(t, admin, roomId, "Isi rahasia pertama");
    await sendText(t, admin, roomId, "Isi rahasia kedua");
    const forActive = (await chatInbox(active.userId)).slice(before);
    expect(forActive).toHaveLength(1);
    expect(forActive[0]).toMatchObject({ title: "Pesan baru" });
    expect(forActive[0]!.data).toMatchObject({ route: `/chat/${roomId}` });
    expect(JSON.stringify(forActive[0])).not.toContain("rahasia");
    const optedOutInbox = (await chatInbox(optedOut.userId)).filter((n) => n.title === "Pesan baru");
    expect(optedOutInbox).toEqual([]);
    expect((await chatInbox(lapsing.userId)).filter((n) => n.title === "Pesan baru")).toEqual([]);
    expect((await chatInbox(admin.userId)).filter((n) => n.title === "Pesan baru")).toEqual([]);

    // Setelah membaca, pesan berikutnya membuka episode baru.
    const page = await history(t, active, roomId);
    await api(t).put(`/chat/rooms/${roomId}/read`, { message_id: page.body.items.at(-1)!.id }, { token: active.token });
    await sendText(t, admin, roomId, "Pesan ketiga");
    expect((await chatInbox(active.userId)).slice(before)).toHaveLength(2);
  });
});
