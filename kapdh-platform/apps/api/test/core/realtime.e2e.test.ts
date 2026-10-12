import { alumni, roomMembers, rooms, sessions, users } from "@kapdh/database";
import { eq, sql } from "drizzle-orm";
import { io, type Socket } from "socket.io-client";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import { MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { NotificationService } from "../../src/core/notifications-kernel/notification.service.js";
import type { RealtimeClient } from "../../src/core/realtime/realtime.service.js";
import { RealtimeGateway } from "../../src/core/realtime/realtime.gateway.js";
import { RealtimeService } from "../../src/core/realtime/realtime.service.js";
import {
  type AlumniFixtureStatus,
  createAdmin,
  createAlumni,
  createMembershipPayment,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { expectRealtimeEnvelope } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { ProbeModule } from "./probe.js";

let t: TestApp;
let baseUrl: string;
let realtime: RealtimeService;
let gateway: RealtimeGateway;
const sockets: Socket[] = [];

const typingCalls: { userId: string; status: string; data: unknown }[] = [];

beforeAll(async () => {
  // ProbeModule menyediakan rute @MemberAccess("active") untuk menguji pencabutan langganan saat request ditolak.
  t = await createTestApp({ extraModules: [ProbeModule] });
  await t.app.listen(0, "127.0.0.1");
  baseUrl = await t.app.getUrl();
  realtime = t.app.get(RealtimeService);
  gateway = t.app.get(RealtimeGateway);
  // Modul chat mendaftarkan handler event klien; di sini handler penguji.
  realtime.registerClientEvent("typing", (client: RealtimeClient, data) => {
    typingCalls.push({ userId: client.userId, status: client.effectiveStatus, data });
  });
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await t.app.close();
});

interface ConnectError extends Error {
  data?: { code: string; message: string };
}

function connect(token: string | null, options: { origin?: string } = {}): Promise<Socket> {
  const socket = io(`${baseUrl}/realtime`, {
    transports: ["websocket"],
    auth: token === null ? {} : { token },
    reconnection: false,
    forceNew: true,
    timeout: 5000,
    ...(options.origin ? { extraHeaders: { origin: options.origin } } : {}),
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error: ConnectError) => reject(error));
  });
}

interface Envelope {
  v: number;
  event_id: string;
  type: string;
  entity_id: string;
  ts: string;
  payload: Record<string, unknown>;
}

function nextEvent(socket: Socket, event: string, timeoutMs = 3000): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`event ${event} tidak diterima`)), timeoutMs);
    socket.once(event, (data: Envelope) => {
      clearTimeout(timer);
      try {
        // Setiap event yang diterima wajib lolos amplop + skema payload kontrak (events/<type>.schema.json).
        resolve(expectRealtimeEnvelope(data));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Memastikan event TIDAK diterima dalam jendela waktu singkat. */
function noEvent(socket: Socket, event: string, ms = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = () => reject(new Error(`event ${event} tidak boleh diterima`));
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
  });
}

function disconnected(socket: Socket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (socket.disconnected) return resolve("sudah terputus");
    const timer = setTimeout(() => reject(new Error("socket tidak diputus")), timeoutMs);
    socket.once("disconnect", (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

async function memberSocket(status: AlumniFixtureStatus = "verified") {
  const member = await createAlumni(t, { status });
  const session = await signInAlumni(t, member);
  const socket = await connect(session.accessToken);
  return { member, session, socket };
}

function inTx<T>(fn: Parameters<typeof withTx<T>>[1]): Promise<T> {
  return runAsSystem(() => withTx(t.db, fn));
}

describe("Gateway /realtime: handshake (ARCHITECTURE §4.9)", () => {
  it("tanpa token, token rusak, atau sesi admin ditolak; Origin browser asing ditolak", async () => {
    await expect(connect(null)).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    await expect(connect("bukan.token.sah")).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    const admin = await createAdmin(t, { permissions: ["members.read"] });
    const adminSession = await signInAdmin(t, admin);
    await expect(connect(adminSession.accessToken)).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });

    const member = await createAlumni(t);
    const session = await signInAlumni(t, member);
    await expect(connect(session.accessToken, { origin: "https://situs-lain.test" })).rejects.toBeDefined();
    const fromAdminOrigin = await connect(session.accessToken, { origin: t.env.ADMIN_ORIGIN });
    expect(fromAdminOrigin.connected).toBe(true);

    // Sesi yang sudah dicabut (logout) tidak dapat membuka socket baru.
    expect(
      (await httpClient(t.app).post("/auth/logout", {}, { token: session.accessToken })).statusCode,
    ).toBe(204);
    await expect(connect(session.accessToken)).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
  });
});

describe("RealtimeService: emit setelah commit (PRD 5.2)", () => {
  it("emitToUser di dalam withTx dikirim setelah commit dengan amplop {v,event_id,type,entity_id,ts,payload}; rollback → tidak dikirim", async () => {
    const { member, socket } = await memberSocket();
    const entityId = uuidv7();
    const received = nextEvent(socket, "presence");
    await inTx(async () => {
      realtime.emitToUser(member.userId, "presence", entityId, {
        user_id: member.userId,
        status: "online",
        ttl_seconds: 60,
      });
    });
    const envelope = await received;
    expect(envelope).toMatchObject({
      v: 1,
      type: "presence",
      entity_id: entityId,
      payload: { user_id: member.userId, status: "online", ttl_seconds: 60 },
    });
    expect(envelope.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(envelope.ts).toISOString()).toBe(envelope.ts);

    const silent = noEvent(socket, "presence");
    await expect(
      inTx(async () => {
        realtime.emitToUser(member.userId, "presence", entityId, {
          user_id: member.userId,
          status: "offline",
          ttl_seconds: 0,
        });
        throw new Error("batal");
      }),
    ).rejects.toThrow("batal");
    await silent;
  });

  it("NotificationService.notify: inbox + outbox dalam transaksi, event notification.created setelah commit, dedup", async () => {
    const { member, socket } = await memberSocket();
    const notificationsService = t.app.get(NotificationService);
    const received = nextEvent(socket, "notification.created");
    const first = await inTx((tx) =>
      notificationsService.notify(tx, {
        userId: member.userId,
        category: "payment",
        title: "Pembayaran disetujui",
        body: "Iuran pendaftaran telah diverifikasi.",
        route: `/payments/${uuidv7()}`,
        dedupKey: "payment.decided:uji-1",
      }),
    );
    expect(first.created).toBe(true);
    const envelope = await received;
    expect(envelope).toMatchObject({
      type: "notification.created",
      entity_id: first.id,
      payload: { id: first.id, category: "payment", title: "Pembayaran disetujui", unread_count: 1 },
    });
    expect(String(envelope.payload.deep_link)).toMatch(/^kapdh:\/\/app\/payments\/[0-9a-f-]{36}$/);

    const silent = noEvent(socket, "notification.created");
    const again = await inTx((tx) =>
      notificationsService.notify(tx, {
        userId: member.userId,
        category: "payment",
        title: "Pembayaran disetujui",
        dedupKey: "payment.decided:uji-1",
      }),
    );
    expect(again).toEqual({ id: first.id, created: false });
    await silent;
  });

  it("joinRoom/emitToRoom/leaveRoom: anggota menerima event room, pengirim dapat dikecualikan, langganan dapat dicabut", async () => {
    const a = await memberSocket();
    const b = await memberSocket();
    const roomId = uuidv7();
    realtime.joinRoom(a.member.userId, roomId);
    realtime.joinRoom(b.member.userId, roomId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const toA = nextEvent(a.socket, "typing");
    const notToB = noEvent(b.socket, "typing");
    realtime.emitToRoom(
      roomId,
      "typing",
      roomId,
      { room_id: roomId, user_id: b.member.userId, ttl_seconds: 5 },
      {
        exceptUserId: b.member.userId,
      },
    );
    expect((await toA).payload).toMatchObject({ room_id: roomId });
    await notToB;

    realtime.revokeRoomSubscription(a.member.userId, roomId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const notToA = noEvent(a.socket, "typing");
    const toB = nextEvent(b.socket, "typing");
    realtime.emitToRoom(roomId, "typing", roomId, {
      room_id: roomId,
      user_id: b.member.userId,
      ttl_seconds: 5,
    });
    await toB;
    await notToA;
  });
});

/** Room grup sintetis dengan anggota joined (modul chat belum ada; cukup baris rooms + room_members). */
async function groupWith(...userIds: string[]): Promise<string> {
  const now = t.clock.now();
  const roomId = uuidv7();
  await t.db.insert(rooms).values({
    id: roomId,
    kind: "group",
    name: "Grup Uji Langganan",
    createdBy: userIds[0]!,
    createdAt: now,
    updatedAt: now,
  });
  for (const userId of userIds)
    await t.db.insert(roomMembers).values({
      roomId,
      userId,
      role: "admin",
      status: "joined",
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  return roomId;
}

const roomPing = (roomId: string) =>
  realtime.emitToRoom(roomId, "room.updated", roomId, {
    room_id: roomId,
    version: "1",
    changes: ["group_name"],
    name: "Grup Uji Langganan",
    avatar_url: null,
    closed_at: null,
  });

describe("Langganan kanal room mengikuti status efektif (kontrak C6 'Pencabutan langganan room')", () => {
  it("butir 2: socket dikeluarkan dari kanal room tepat saat expires_at tanpa menunggu penyapuan", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const expiresAt = new Date(t.clock.now().getTime() + 150);
    await t.db.update(alumni).set({ expiresAt }).where(eq(alumni.userId, member.userId));
    const roomId = await groupWith(member.userId);
    const socket = await connect((await signInAlumni(t, member)).accessToken);
    const before = nextEvent(socket, "room.updated");
    roomPing(roomId);
    await before;

    // Waktu server melewati expires_at; timer gateway (bukan penyapuan 60 detik) melepas langganan room.
    t.clock.advance(1000);
    await expect
      .poll(async () => {
        const silent = noEvent(socket, "room.updated", 100);
        roomPing(roomId);
        return silent.then(
          () => "lepas",
          () => "masih",
        );
      })
      .toBe("lepas");
    expect(socket.connected).toBe(true);
  });

  it("butir 3: request yang ditolak MEMBERSHIP_REQUIRED langsung mencabut langganan room socket pengguna", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const roomId = await groupWith(member.userId);
    const session = await signInAlumni(t, member);
    const socket = await connect(session.accessToken);
    const before = nextEvent(socket, "room.updated");
    roomPing(roomId);
    await before;

    // Masa aktif berakhir di database; timer socket masih menunggu expires_at lama.
    await t.db
      .update(alumni)
      .set({ expiresAt: new Date(t.clock.now().getTime() - 1000) })
      .where(eq(alumni.userId, member.userId));
    const denied = await httpClient(t.app).get("/__probe/member/active", { token: session.accessToken });
    expect(denied.json().code).toBe("MEMBERSHIP_REQUIRED");
    await expect
      .poll(async () => {
        const silent = noEvent(socket, "room.updated", 100);
        roomPing(roomId);
        return silent.then(
          () => "lepas",
          () => "masih",
        );
      })
      .toBe("lepas");
  });

  it("butir 5: perpanjangan yang disetujui memasukkan ulang socket anggota expired ke kanal room setelah commit", async () => {
    const member = await createAlumni(t, { status: "expired" });
    const roomId = await groupWith(member.userId);
    const socket = await connect((await signInAlumni(t, member)).accessToken);
    const outside = noEvent(socket, "room.updated");
    roomPing(roomId);
    await outside;

    const payment = await createMembershipPayment(t, { userId: member.userId, type: "renewal" });
    await inTx((tx) => t.app.get(MembershipKernel).applyPaidPayment(tx, payment, t.clock.now()));
    await expect
      .poll(async () => {
        const received = nextEvent(socket, "room.updated", 150);
        roomPing(roomId);
        return received.then(
          () => "masuk",
          () => "belum",
        );
      })
      .toBe("masuk");
  });
});

describe("Pencabutan socket (AC F02-6, F11-6, F12-4, F16-3)", () => {
  it("AC F12-4: suspend → session.revoked (account_suspended) lalu socket diputus setelah commit", async () => {
    const { member, socket } = await memberSocket();
    const revoked = nextEvent(socket, "session.revoked");
    const closed = disconnected(socket);
    await inTx((tx) =>
      t.app.get(MembershipKernel).suspend(tx, member.userId, {
        reason: "Pelanggaran (uji)",
        memberMessage: "Akun Anda dibatasi.",
        actorAdminId: null,
      }),
    );
    expect((await revoked).payload).toEqual({ reason: "account_suspended", all_sessions: true });
    expect(await closed).toBe("io server disconnect");
  });

  it("AC F02-6: logout semua perangkat dan logout satu sesi memutus socket terkait", async () => {
    const { member, session, socket } = await memberSocket();
    const other = await signInAlumni(t, member);
    const otherSocket = await connect(other.accessToken);

    // Logout satu sesi: hanya socket sesi itu.
    const single = nextEvent(otherSocket, "session.revoked");
    const untouched = noEvent(socket, "session.revoked");
    expect((await httpClient(t.app).post("/auth/logout", {}, { token: other.accessToken })).statusCode).toBe(
      204,
    );
    expect((await single).payload).toEqual({ reason: "logout", all_sessions: false });
    await untouched;

    const all = nextEvent(socket, "session.revoked");
    const closed = disconnected(socket);
    expect(
      (await httpClient(t.app).post("/auth/logout-all", {}, { token: session.accessToken })).statusCode,
    ).toBe(204);
    expect((await all).payload).toEqual({ reason: "logout_all", all_sessions: true });
    await closed;
  });

  it("AC F02-3: rotasi refresh tidak memutus socket keluarga sesi; logout dengan token hasil rotasi memutusnya", async () => {
    const { member, session, socket } = await memberSocket();
    const api = httpClient(t.app);
    const rotated = await api.post("/auth/refresh", { refresh_token: session.refreshToken });
    expect(rotated.statusCode).toBe(200);
    // Baris sesi lama kini replaced_by + revoked, tetapi keluarganya masih aktif: socket tetap sah.
    const stillAlive = noEvent(socket, "session.revoked");
    await gateway.revalidateAll();
    await stillAlive;
    expect(socket.connected).toBe(true);

    const [row] = await t.db
      .select({ familyId: sessions.familyId })
      .from(sessions)
      .where(eq(sessions.userId, member.userId))
      .limit(1);
    const revoked = nextEvent(socket, "session.revoked");
    const closed = disconnected(socket);
    expect((await api.post("/auth/logout", {}, { token: rotated.json().access_token })).statusCode).toBe(204);
    const envelope = await revoked;
    // entity_id = Session.id = keluarga sesi (kontrak C1, events/session.revoked.schema.json).
    expect(envelope).toMatchObject({
      entity_id: row!.familyId,
      payload: { reason: "logout", all_sessions: false },
    });
    await closed;
  });

  it("validasi ulang berkala: session_version berubah di luar proses ini → session.revoked lalu putus", async () => {
    const { member, socket } = await memberSocket();
    const revoked = nextEvent(socket, "session.revoked");
    const closed = disconnected(socket);
    await t.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, member.userId));
    await gateway.revalidateAll();
    expect((await revoked).payload).toMatchObject({ reason: "session_revoked" });
    await closed;
  });

  it("validasi ulang berkala: room yang di-join diikuti saat aktif dan dilepas saat masa keanggotaan habis (AC F11-6)", async () => {
    const member = await createAlumni(t, { status: "expiring" });
    const now = t.clock.now();
    const roomId = uuidv7();
    await t.db.insert(rooms).values({
      id: roomId,
      kind: "group",
      name: "Grup Angkatan Uji",
      createdBy: member.userId,
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(roomMembers).values({
      roomId,
      userId: member.userId,
      role: "admin",
      status: "joined",
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const session = await signInAlumni(t, member);
    const socket = await connect(session.accessToken);

    const inRoom = nextEvent(socket, "room.updated");
    realtime.emitToRoom(roomId, "room.updated", roomId, {
      room_id: roomId,
      version: "1",
      changes: ["group_name"],
      name: "Grup Angkatan Uji",
      avatar_url: null,
      closed_at: null,
    });
    await inRoom;

    // Masa aktif habis (tanpa worker): validasi ulang melepas langganan room tetapi socket pengguna tetap hidup.
    t.clock.set(new Date(member.expiresAt!.getTime() + 1000));
    try {
      await gateway.revalidateAll();
      const gone = noEvent(socket, "room.updated");
      realtime.emitToRoom(roomId, "room.updated", roomId, {
        room_id: roomId,
        version: "1",
        changes: ["group_name"],
        name: "Grup Angkatan Uji",
        avatar_url: null,
        closed_at: null,
      });
      await gone;
      expect(socket.connected).toBe(true);
    } finally {
      t.clock.set(now);
    }
  });

  it("event klien (typing) diteruskan ke handler modul setelah sesi diperiksa ulang; sesi dicabut → diputus", async () => {
    const { member, socket } = await memberSocket();
    const roomId = uuidv7();
    socket.emit("typing", { room_id: roomId });
    await expect
      .poll(() => typingCalls.find((c) => c.userId === member.userId))
      .toMatchObject({
        status: "verified",
        data: { room_id: roomId },
      });

    await t.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, member.userId));
    const revoked = nextEvent(socket, "session.revoked");
    const closed = disconnected(socket);
    const before = typingCalls.length;
    socket.emit("typing", { room_id: roomId });
    await revoked;
    await closed;
    expect(typingCalls.length).toBe(before);
  });
});
