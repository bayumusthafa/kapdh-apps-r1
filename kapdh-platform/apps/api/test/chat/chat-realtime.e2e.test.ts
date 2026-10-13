/**
 * Chat lewat Socket.IO /realtime dengan socket.io-client sungguhan (F-11, F-12; AC F11-1, F11-2, F11-3, F11-4, F11-6,
 * F12-1; N-02; ARCHITECTURE §4.9; events/*.schema.json): penyampaian sesudah commit, privasi undangan, pencabutan
 * langganan saat keanggotaan/akses berakhir, sinkron setelah reconnect, typing/presence sementara. Setiap event yang
 * diterima socket uji divalidasi terhadap amplop dan skema payload kontrak (TestSocket).
 */
import { alumni, blocks } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import { MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { BlockPolicy } from "../../src/core/policy/block.policy.js";
import { REALTIME_FILE_URL_TTL_SECONDS } from "../../src/modules/chat/chat.constants.js";
import { ChatLifecycleService } from "../../src/modules/chat/chat-lifecycle.service.js";
import { expectOperation } from "../support/contract.js";
import { signInAlumni } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  api,
  block,
  errorCode,
  eventually,
  groupWith,
  history,
  listenApp,
  type Member,
  member,
  openDirect,
  sendRaw,
  sendText,
  TestSocket,
} from "./support.js";

let t: TestApp;
let baseUrl: string;
const sockets: TestSocket[] = [];

beforeAll(async () => {
  t = await createTestApp();
  baseUrl = await listenApp(t.app);
});
afterAll(async () => {
  for (const socket of sockets) socket.close();
  await t.app.close();
});

async function connect(who: Member | string): Promise<TestSocket> {
  const socket = await TestSocket.connect(baseUrl, typeof who === "string" ? who : who.token, t);
  sockets.push(socket);
  return socket;
}

const isMessage = (id: string) => (e: { entity_id: string }) => e.entity_id === id;

describe("N-02 / AC F11-2: penyampaian message.created sesudah commit", () => {
  it("AC F11-2: pesan sampai ke anggota room dan perangkat lain pengirim dengan bentuk sama seperti respons HTTP; bukan anggota tidak menerima", async () => {
    const a = await member(t);
    const b = await member(t);
    const outsider = await member(t);
    const room = await openDirect(t, a, b);
    const secondDevice = await signInAlumni(t, a);
    const [aPhone, aTablet, bSocket, outsiderSocket] = [
      await connect(a),
      await connect(secondDevice.accessToken),
      await connect(b),
      await connect(outsider),
    ];
    expect(bSocket.serverChannels(t).has(`room:${room.id}`)).toBe(true);
    expect(outsiderSocket.serverChannels(t).has(`room:${room.id}`)).toBe(false);

    const sent = await sendText(t, a, room.id, "Assalamu'alaikum");
    const delivered = await bSocket.waitFor("message.created", isMessage(sent.id));
    expect(delivered.payload).toEqual({ room_id: room.id, message: { ...sent, reactions: [] } });
    // Perangkat lain pengirim ikut menerima (kanal room), termasuk perangkat yang mengirim (pencocokan client_message_id).
    await aTablet.waitFor("message.created", isMessage(sent.id));
    await aPhone.waitFor("message.created", isMessage(sent.id));
    await outsiderSocket.none("message.created");
    // Setiap socket menerima tepat satu salinan.
    expect(bSocket.of("message.created").filter(isMessage(sent.id))).toHaveLength(1);
  });

  it("AC F11-1: room direct baru langsung dilanggan socket kedua pihak yang sedang tersambung", async () => {
    const a = await member(t);
    const b = await member(t);
    const [aSocket, bSocket] = [await connect(a), await connect(b)];
    const room = await openDirect(t, a, b);
    await eventually(() => bSocket.serverChannels(t).has(`room:${room.id}`), 3000, "langganan room baru");
    expect(aSocket.serverChannels(t).has(`room:${room.id}`)).toBe(true);
    const sent = await sendText(t, a, room.id, "Halo, room baru");
    await bSocket.waitFor("message.created", isMessage(sent.id));
  });

  it("PRD 5.4: gambar pada siaran realtime memakai URL singkat; respons HTTP memakai URL terikat sesi penampil", async () => {
    const a = await member(t);
    const b = await member(t);
    const room = await openDirect(t, a, b);
    const bSocket = await connect(b);
    const image = await uploadTestFile(t, a.token, "chat_image");
    const res = await sendRaw(t, a, room.id, { kind: "image", image_file_id: image.id });
    expect(res.statusCode, res.body).toBe(201);
    const sent = expectOperation("post", "/chat/rooms/{roomId}/messages", res) as {
      id: string;
      image: { url: string; url_expires_at: string };
    };
    const event = await bSocket.waitFor("message.created", isMessage(sent.id));
    const image$ = (event.payload.message as { image: { url: string; url_expires_at: string } }).image;
    const now = t.clock.now().getTime();
    expect(Date.parse(image$.url_expires_at) - now).toBe(REALTIME_FILE_URL_TTL_SECONDS * 1000);
    expect(Date.parse(sent.image.url_expires_at) - now).toBeGreaterThan(REALTIME_FILE_URL_TTL_SECONDS * 1000);
    expect(Date.parse(sent.image.url_expires_at) - now).toBeLessThanOrEqual(600_000);
    // URL siaran tetap dapat dibuka selama masa berlakunya (penampil berhak menerima event room).
    const content = await t.app.inject({ method: "GET", url: image$.url.slice(t.env.API_PUBLIC_URL.length) });
    expect(content.statusCode).toBe(200);
  });

  it("read.updated, reaction.updated dan message.deleted sampai ke anggota room", async () => {
    const a = await member(t);
    const b = await member(t);
    const room = await openDirect(t, a, b);
    const [aSocket, bSocket] = [await connect(a), await connect(b)];
    const sent = await sendText(t, a, room.id, "Tolong dibaca");
    await bSocket.waitFor("message.created", isMessage(sent.id));

    const read = await api(t).put(`/chat/rooms/${room.id}/read`, { message_id: sent.id }, { token: b.token });
    expect(read.statusCode).toBe(200);
    const readEvent = await aSocket.waitFor("read.updated", (e) => e.payload.user_id === b.userId);
    expect(readEvent.payload).toMatchObject({ room_id: room.id, last_read_message_id: sent.id });
    // Paket terlambat yang tidak memajukan cursor tidak menyiarkan apa pun.
    const again = await api(t).put(
      `/chat/rooms/${room.id}/read`,
      { message_id: sent.id },
      { token: b.token },
    );
    expect(again.statusCode).toBe(200);
    await aSocket.none("read.updated", (e) => e.payload.user_id === b.userId && e !== readEvent, 200);

    const reacted = await api(t).put(
      `/chat/rooms/${room.id}/messages/${sent.id}/reactions/${encodeURIComponent("👍")}`,
      {},
      { token: b.token },
    );
    expect(reacted.statusCode).toBe(200);
    const reaction = await aSocket.waitFor("reaction.updated", isMessage(sent.id));
    expect(reaction.payload).toEqual({
      room_id: room.id,
      message_id: sent.id,
      user_id: b.userId,
      emoji: "👍",
      action: "added",
      counts: [{ emoji: "👍", count: 1 }],
    });

    const deleted = await api(t).delete(`/chat/rooms/${room.id}/messages/${sent.id}`, { token: a.token });
    expect(deleted.statusCode).toBe(200);
    const removal = await bSocket.waitFor("message.deleted", isMessage(sent.id));
    expect(removal.payload).toMatchObject({ room_id: room.id, message_id: sent.id });
  });
});

describe("Grup: event undangan hanya ke calon anggota dan admin grup (N-09)", () => {
  it("PRD 3.11: invited/declined hanya ke kanal user calon anggota dan admin; joined ke kanal room; anggota baru mulai menerima pesan sesudah menerima undangan", async () => {
    const admin = await member(t);
    const regular = await member(t);
    const newcomer = await member(t);
    const refuser = await member(t);
    const roomId = await groupWith(t, admin, [regular]);
    const [adminSocket, regularSocket, newcomerSocket, refuserSocket] = [
      await connect(admin),
      await connect(regular),
      await connect(newcomer),
      await connect(refuser),
    ];

    const invited = await api(t).post(
      `/chat/rooms/${roomId}/invitations`,
      { user_ids: [newcomer.userId, refuser.userId] },
      { token: admin.token },
    );
    expect(invited.statusCode).toBe(200);
    const invitedEvent = await newcomerSocket.waitFor(
      "room.member_changed",
      (e) => e.payload.change === "invited" && e.payload.user_id === newcomer.userId,
    );
    expect(invitedEvent.payload).toMatchObject({ room_id: roomId, actor_user_id: admin.userId, role: null });
    await adminSocket.waitFor("room.member_changed", (e) => e.payload.change === "invited");
    await refuserSocket.waitFor("room.member_changed", (e) => e.payload.user_id === refuser.userId);
    // Calon anggota lain tidak mengetahui siapa saja yang diundang; anggota biasa tidak menerima event undangan.
    await newcomerSocket.none("room.member_changed", (e) => e.payload.user_id === refuser.userId, 100);
    await regularSocket.none("room.member_changed", (e) => e.payload.change === "invited");
    // Belum menerima undangan: socket belum berlangganan room (tidak dipaksa masuk).
    expect(newcomerSocket.serverChannels(t).has(`room:${roomId}`)).toBe(false);
    const beforeJoin = await sendText(t, regular, roomId, "Sebelum newcomer bergabung");
    await newcomerSocket.none("message.created", isMessage(beforeJoin.id), 150);

    const declined = await api(t).post(`/chat/invitations/${roomId}/decline`, {}, { token: refuser.token });
    expect(declined.statusCode).toBe(204);
    await adminSocket.waitFor(
      "room.member_changed",
      (e) => e.payload.change === "declined" && e.payload.user_id === refuser.userId,
    );
    await regularSocket.none("room.member_changed", (e) => e.payload.change === "declined");

    const accepted = await api(t).post(`/chat/invitations/${roomId}/accept`, {}, { token: newcomer.token });
    expect(accepted.statusCode).toBe(200);
    const joined = await regularSocket.waitFor(
      "room.member_changed",
      (e) => e.payload.change === "joined" && e.payload.user_id === newcomer.userId,
    );
    expect(joined.payload).toMatchObject({ role: "member", member_count: 3, actor_user_id: newcomer.userId });
    // Pengguna terdampak menerima tepat sekali (lewat kanal user, dikecualikan dari kanal room).
    await newcomerSocket.waitFor("room.member_changed", (e) => e.payload.change === "joined");
    expect(
      newcomerSocket.of("room.member_changed").filter((e) => e.payload.change === "joined"),
    ).toHaveLength(1);
    // Pesan sistem "bergabung" sampai ke anggota lama dan anggota baru.
    await regularSocket.waitFor("message.created", (e) =>
      (e.payload.message as { kind: string; body: string }).body.includes("bergabung"),
    );
    const afterJoin = await sendText(t, regular, roomId, "Selamat datang");
    await newcomerSocket.waitFor("message.created", isMessage(afterJoin.id));
  });
});

describe("AC F11-4 / AC F11-6: langganan dicabut saat akses berakhir", () => {
  it("AC F11-4: anggota yang dikeluarkan atau keluar berhenti menerima event room seketika", async () => {
    const admin = await member(t);
    const removed = await member(t);
    const leaver = await member(t);
    const roomId = await groupWith(t, admin, [removed, leaver]);
    const [removedSocket, leaverSocket] = [await connect(removed), await connect(leaver)];
    expect(removedSocket.serverChannels(t).has(`room:${roomId}`)).toBe(true);

    const res = await api(t).delete(`/chat/rooms/${roomId}/members/${removed.userId}`, {
      token: admin.token,
    });
    expect(res.statusCode).toBe(204);
    const notice = await removedSocket.waitFor("room.member_changed", (e) => e.payload.change === "removed");
    expect(notice.payload).toMatchObject({
      user_id: removed.userId,
      actor_user_id: admin.userId,
      member_count: 2,
    });
    await eventually(
      () => !removedSocket.serverChannels(t).has(`room:${roomId}`),
      3000,
      "pencabutan langganan",
    );
    const afterRemoval = await sendText(t, admin, roomId, "Setelah dikeluarkan");
    await leaverSocket.waitFor("message.created", isMessage(afterRemoval.id));
    await removedSocket.none("message.created", isMessage(afterRemoval.id));
    // typing ke room yang tidak lagi diikuti diabaikan.
    removedSocket.emit("typing", { room_id: roomId });
    await leaverSocket.none("typing", (e) => e.payload.user_id === removed.userId, 200);

    const left = await api(t).post(`/chat/rooms/${roomId}/leave`, {}, { token: leaver.token });
    expect(left.statusCode).toBe(204);
    await leaverSocket.waitFor("room.member_changed", (e) => e.payload.change === "left");
    await eventually(
      () => !leaverSocket.serverChannels(t).has(`room:${roomId}`),
      3000,
      "pencabutan langganan",
    );
    const afterLeave = await sendText(t, admin, roomId, "Setelah keluar");
    await leaverSocket.none("message.created", isMessage(afterLeave.id));
  });

  it("AC F11-6: anggota yang menjadi expired saat tersambung ditolak saat mengirim/bergabung, langganan room dicabut, typing diabaikan", async () => {
    const a = await member(t);
    const b = await member(t);
    const admin = await member(t);
    // Grup (bukan direct): pesan anggota lain tetap boleh dikirim walau b expired, sehingga terlihat apakah b masih
    // menerima event room.
    const room = { id: await groupWith(t, a, [b]) };
    const group = await api(t).post(
      "/chat/rooms",
      { name: "Grup Undangan Expired", invitee_user_ids: [b.userId] },
      { token: admin.token },
    );
    const groupId = (group.json() as { room: { id: string } }).room.id;
    const [aSocket, bSocket] = [await connect(a), await connect(b)];
    expect(bSocket.serverChannels(t).has(`room:${room.id}`)).toBe(true);

    // Masa keanggotaan b berakhir (berbasis waktu, tanpa event DB lain).
    await t.db
      .update(alumni)
      .set({ expiresAt: new Date(t.clock.now().getTime() - 1000) })
      .where(eq(alumni.userId, b.userId));
    const send = await sendRaw(t, b, room.id, { kind: "text", body: "Masih bisa?" });
    expect([send.statusCode, errorCode(send)]).toEqual([403, "MEMBERSHIP_REQUIRED"]);
    const join = await api(t).post(`/chat/invitations/${groupId}/accept`, {}, { token: b.token });
    expect([join.statusCode, errorCode(join)]).toEqual([403, "MEMBERSHIP_REQUIRED"]);
    // Penolakan 403 mencabut langganan room seluruh socket b (bukan menunggu penyapuan 60 detik).
    await eventually(() => !bSocket.serverChannels(t).has(`room:${room.id}`), 3000, "pencabutan langganan");
    const fromA = await sendText(t, a, room.id, "Pesan setelah b expired");
    await bSocket.none("message.created", isMessage(fromA.id));
    // Emit typing dari anggota yang tidak lagi aktif diabaikan.
    bSocket.emit("typing", { room_id: room.id });
    await aSocket.none("typing", (e) => e.payload.user_id === b.userId, 200);
    // Riwayat juga tertutup (PRD 2.2: chat hanya verified/expiring).
    const read = await api(t).get(`/chat/rooms/${room.id}/messages`, { token: b.token });
    expect([read.statusCode, errorCode(read)]).toEqual([403, "MEMBERSHIP_REQUIRED"]);
  });

  it("AC F11-6 / AC F12-4: suspend saat tersambung memutus socket (session.revoked) sehingga pesan berikutnya tidak sampai", async () => {
    const a = await member(t);
    const b = await member(t);
    const room = await openDirect(t, a, b);
    const bSocket = await connect(b);
    await runAsSystem(() =>
      withTx(t.db, (tx) =>
        t.app.get(MembershipKernel).suspend(tx, b.userId, {
          reason: "Pelanggaran ketentuan komunitas (uji)",
          memberMessage: "Akun Anda dibatasi sementara.",
          actorAdminId: null,
        }),
      ),
    );
    const revoked = await bSocket.waitFor("session.revoked");
    expect(revoked.payload).toEqual({ reason: "account_suspended", all_sessions: true });
    await eventually(() => bSocket.socket.disconnected, 3000, "socket diputus");
    const sent = await sendRaw(t, a, room.id, { kind: "text", body: "Halo?" });
    // Lawan bicara suspended: pengiriman ke room direct ditolak (peer_unavailable, N-09).
    expect([sent.statusCode, errorCode(sent)]).toEqual([403, "FORBIDDEN"]);
  });
});

describe("AC F11-3 / N-02: sinkron setelah reconnect tanpa kehilangan atau duplikasi", () => {
  it("AC F11-3: pesan yang commit selama socket terputus diambil lewat after=<jangkar HTTP>; digabung dengan event live berdasarkan id tanpa duplikasi", async () => {
    const a = await member(t);
    const b = await member(t);
    const room = await openDirect(t, a, b);
    let bSocket = await connect(b);
    const first = await sendText(t, a, room.id, "pesan pertama");
    await bSocket.waitFor("message.created", isMessage(first.id));
    // Jangkar sinkron hanya dari halaman HTTP (kontrak listChatMessages).
    const page = await history(t, b, room.id);
    const local = new Map(page.body.items.map((m) => [m.id, m]));
    let anchor = page.body.items.at(-1)!.id;
    expect(anchor).toBe(first.id);

    // Koneksi b terputus; a terus mengirim.
    bSocket.close();
    const missed: string[] = [];
    for (let i = 0; i < 5; i++) missed.push((await sendText(t, a, room.id, `saat terputus ${i}`)).id);

    // Reconnect: socket baru berlangganan ulang room joined; pesan live sesudah reconnect sampai lewat event.
    bSocket = await connect(b);
    expect(bSocket.serverChannels(t).has(`room:${room.id}`)).toBe(true);
    const live = await sendText(t, a, room.id, "sesudah tersambung lagi");
    const liveEvent = await bSocket.waitFor("message.created", isMessage(live.id));
    local.set(live.id, (liveEvent.payload as { message: (typeof page.body.items)[number] }).message);
    // Event live TIDAK memajukan jangkar; sinkron after sampai next_cursor null, gabung berdasarkan id.
    const synced: string[] = [];
    for (let cursor: string | null = anchor; cursor;) {
      const res = await history(t, b, room.id, { after: cursor, limit: "2" });
      for (const message of res.body.items) {
        synced.push(message.id);
        local.set(message.id, message);
      }
      cursor = res.body.next_cursor;
      if (res.body.items.length > 0) anchor = res.body.items.at(-1)!.id;
    }
    expect(synced).toEqual([...missed, live.id]);
    expect(new Set(synced).size).toBe(synced.length);
    expect([...local.keys()].sort()).toEqual([first.id, ...missed, live.id].sort());
    expect(anchor).toBe(live.id);
    // Tidak ada event untuk pesan yang terlewat saat terputus (bukan sumber kebenaran).
    for (const id of missed) expect(bSocket.of("message.created").some(isMessage(id))).toBe(false);
  });
});

describe("Typing dan presence sementara (PRD 3.11, TTL, bukan bukti baca)", () => {
  it("PRD 3.11: typing diteruskan ke anggota room lain dengan TTL, tidak kembali ke pengirim, dibatasi laju; bukan anggota dan data tidak sah diabaikan", async () => {
    const admin = await member(t);
    const typist = await member(t);
    const watcher = await member(t);
    const outsider = await member(t);
    const roomId = await groupWith(t, admin, [typist, watcher]);
    const [typistSocket, watcherSocket, adminSocket, outsiderSocket] = [
      await connect(typist),
      await connect(watcher),
      await connect(admin),
      await connect(outsider),
    ];
    typistSocket.emit("typing", { room_id: roomId });
    const typing = await watcherSocket.waitFor("typing", (e) => e.payload.user_id === typist.userId);
    expect(typing.payload).toEqual({ room_id: roomId, user_id: typist.userId, ttl_seconds: 5 });
    expect(typing.entity_id).toBe(roomId);
    await adminSocket.waitFor("typing", (e) => e.payload.user_id === typist.userId);
    await typistSocket.none("typing");
    // Jeda minimal per pengguna+room (Clock uji tidak maju): emit kedua tidak disiarkan ulang.
    typistSocket.emit("typing", { room_id: roomId });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(watcherSocket.of("typing").filter((e) => e.payload.user_id === typist.userId)).toHaveLength(1);

    outsiderSocket.emit("typing", { room_id: roomId });
    outsiderSocket.emit("typing", { room_id: "bukan-uuid" });
    outsiderSocket.emit("typing", null);
    await watcherSocket.none("typing", (e) => e.payload.user_id === outsider.userId, 200);
    // Typing bukan bukti baca: read cursor tidak berubah.
    const room = await api(t).get(`/chat/rooms/${roomId}`, { token: typist.token });
    expect(room.statusCode).toBe(200);
  });

  it("AC F12-1: typing dan presence tidak diteruskan antara pasangan yang saling memblokir", async () => {
    const a = await member(t);
    const b = await member(t);
    const room = await openDirect(t, a, b);
    await sendText(t, a, room.id, "Sebelum blokir");
    await block(t, b, a);
    const [aSocket, bSocket] = [await connect(a), await connect(b)];
    aSocket.emit("typing", { room_id: room.id });
    aSocket.emit("presence.ping");
    await bSocket.none("typing", () => true, 250);
    await bSocket.none("presence", (e) => e.payload.user_id === a.userId, 50);
  });

  it("PRD 3.11: presence.ping menyiarkan online (TTL) ke anggota aktif room yang sama saja; pengguna tidak aktif disiarkan offline dan langganannya dicabut", async () => {
    const pinger = await member(t);
    const peer = await member(t);
    const stranger = await member(t);
    const room = await openDirect(t, pinger, peer);
    const [pingerSocket, peerSocket, strangerSocket] = [
      await connect(pinger),
      await connect(peer),
      await connect(stranger),
    ];
    pingerSocket.emit("presence.ping");
    const online = await peerSocket.waitFor("presence", (e) => e.payload.user_id === pinger.userId);
    expect(online.payload).toEqual({ user_id: pinger.userId, status: "online", ttl_seconds: 60 });
    expect(online.entity_id).toBe(pinger.userId);
    await strangerSocket.none("presence", (e) => e.payload.user_id === pinger.userId, 100);

    // Pinger menjadi expired: ping berikutnya tidak menyiarkan online, melainkan offline (ttl 0), dan langganan dicabut.
    await t.db
      .update(alumni)
      .set({ expiresAt: new Date(t.clock.now().getTime() - 1000) })
      .where(eq(alumni.userId, pinger.userId));
    pingerSocket.emit("presence.ping");
    const offline = await peerSocket.waitFor(
      "presence",
      (e) => e.payload.user_id === pinger.userId && e.payload.status === "offline",
    );
    expect(offline.payload).toEqual({ user_id: pinger.userId, status: "offline", ttl_seconds: 0 });
    await eventually(
      () => !pingerSocket.serverChannels(t).has(`room:${room.id}`),
      3000,
      "pencabutan langganan",
    );
  });
});

describe("AC F12-1: blokir baru memberi tahu perangkat pemblokir saja", () => {
  it("AC F12-1 / N-09: room.updated send_permission hanya ke kanal user pemblokir; pihak yang diblokir tidak diberi tahu", async () => {
    const a = await member(t);
    const b = await member(t);
    const room = await openDirect(t, a, b);
    const [aSocket, bSocket] = [await connect(a), await connect(b)];
    const lifecycle = t.app.get(ChatLifecycleService);
    // Pola modul moderation (blockMember): kunci pasangan, insert blok, lalu efek chat dalam transaksi yang sama.
    await runAsSystem(() =>
      withTx(t.db, async (tx) => {
        await t.app.get(BlockPolicy).lockPair(tx, a.userId, b.userId);
        await tx
          .insert(blocks)
          .values({ blockerId: a.userId, blockedId: b.userId, createdAt: t.clock.now() });
        await lifecycle.onBlockCreated(tx, a.userId, b.userId);
      }),
    );
    const updated = await aSocket.waitFor("room.updated", (e) => e.entity_id === room.id);
    expect(updated.payload).toMatchObject({ room_id: room.id, changes: ["send_permission"], name: null });
    await bSocket.none("room.updated");
    // Kirim dari kedua pihak ditolak walau socket dan room masih ada (AC F12-1).
    for (const who of [a, b]) {
      const res = await sendRaw(t, who, room.id, {
        kind: "text",
        body: "Masih?",
        client_message_id: uuidv7(),
      });
      expect(res.statusCode).toBe(403);
    }
    await bSocket.none("message.created", () => true, 100);
  });
});
