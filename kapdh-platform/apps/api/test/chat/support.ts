/**
 * Helper uji modul chat (F-11, F-12): anggota bersesi, room direct/grup lewat API, kirim pesan, dan socket realtime.
 */
import { blocks } from "@kapdh/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Namespace } from "socket.io";
import { io, type Socket } from "socket.io-client";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import { RealtimeGateway } from "../../src/core/realtime/realtime.gateway.js";
import { expectOperation, expectRealtimeEnvelope, type InjectResponse } from "../support/contract.js";
import {
  type AlumniFixture,
  type AlumniFixtureStatus,
  createAlumni,
  type CreateAlumniOptions,
  signInAlumni,
} from "../support/factories.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";

export interface Member extends AlumniFixture {
  token: string;
  refreshToken: string;
}

let counter = 0;

/** Anggota alumni dengan sesi aplikasi (default verified = aktif, PRD 2.2). */
export async function member(
  t: TestApp,
  status: AlumniFixtureStatus = "verified",
  options: Omit<CreateAlumniOptions, "status"> = {},
): Promise<Member> {
  const fixture = await createAlumni(t, {
    status,
    fullName: options.fullName ?? `Anggota Uji ${++counter}`,
    ...options,
  });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken, refreshToken: session.refreshToken };
}

export function api(t: TestApp) {
  return httpClient(t.app);
}

/** POST /chat/direct yang wajib berhasil (200/201); mengembalikan ChatRoom. */
export async function openDirect(t: TestApp, from: Member, to: Member) {
  const res = await api(t).post("/chat/direct", { user_id: to.userId }, { token: from.token });
  expect([200, 201], res.body).toContain(res.statusCode);
  return expectOperation("post", "/chat/direct", res) as { id: string; [key: string]: unknown };
}

/** Grup dengan anggota yang sudah menerima undangan; admin = pembuat. */
export async function groupWith(t: TestApp, admin: Member, members: Member[], name = "Grup Angkatan Uji") {
  const created = await api(t).post(
    "/chat/rooms",
    { name, invitee_user_ids: members.map((m) => m.userId) },
    { token: admin.token },
  );
  expect(created.statusCode, created.body).toBe(201);
  const body = expectOperation("post", "/chat/rooms", created) as {
    room: { id: string };
    invitations: { invited_user_ids: string[] };
  };
  for (const m of members) {
    const accepted = await api(t).post(`/chat/invitations/${body.room.id}/accept`, {}, { token: m.token });
    expect(accepted.statusCode, accepted.body).toBe(200);
  }
  return body.room.id;
}

export interface SentMessage {
  id: string;
  client_message_id: string | null;
  created_at: string;
  body: string | null;
  [key: string]: unknown;
}

/** Kirim pesan teks (201) dan validasi kontrak. */
export async function sendText(
  t: TestApp,
  from: Member,
  roomId: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<SentMessage> {
  const res = await sendRaw(t, from, roomId, { kind: "text", body, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return expectOperation("post", "/chat/rooms/{roomId}/messages", res) as SentMessage;
}

export function sendRaw(t: TestApp, from: Member, roomId: string, payload: Record<string, unknown>) {
  return api(t).post(
    `/chat/rooms/${roomId}/messages`,
    { client_message_id: uuidv7(), ...payload },
    { token: from.token },
  );
}

/** Seluruh riwayat lewat halaman `before` (urut naik). */
export async function history(
  t: TestApp,
  viewer: Member,
  roomId: string,
  query: Record<string, string> = {},
) {
  const res = await api(t).get(`/chat/rooms/${roomId}/messages`, { token: viewer.token, query });
  return { res, body: expectOperation("get", "/chat/rooms/{roomId}/messages", res) as Page };
}

export interface Page {
  items: SentMessage[];
  next_cursor: string | null;
}

export async function block(t: TestApp, blocker: Member, blocked: Member): Promise<void> {
  await t.db
    .insert(blocks)
    .values({ blockerId: blocker.userId, blockedId: blocked.userId, createdAt: t.clock.now() });
}

export function errorCode(res: InjectResponse): string {
  return (res.json() as { code: string }).code;
}

// ------------------------------------------------------------------------------------------------------- socket

export interface Envelope {
  v: number;
  event_id: string;
  type: string;
  entity_id: string;
  ts: string;
  payload: Record<string, unknown>;
}

/** Socket /realtime terautentikasi; setiap event yang diterima direkam dan divalidasi skema kontraknya. */
export class TestSocket {
  readonly events: Envelope[] = [];
  private constructor(readonly socket: Socket) {
    socket.onAny((type: string, envelope: Envelope) => {
      expectRealtimeEnvelope(envelope);
      expect(envelope.type).toBe(type);
      this.events.push(envelope);
    });
  }

  /**
   * Menyambung ke /realtime. Gateway menyelesaikan join kanal (user/sesi/room) dan mendaftarkan listener event klien
   * secara async setelah `connect`; dengan `t` uji menunggu sampai socket sisi server siap (listener `presence.ping`
   * terdaftar = langkah terakhir handleConnection), sehingga tidak bergantung pada jeda waktu tetap.
   */
  static async connect(baseUrl: string, token: string, t?: TestApp): Promise<TestSocket> {
    const socket = io(`${baseUrl}/realtime`, {
      transports: ["websocket"],
      auth: { token },
      reconnection: false,
      forceNew: true,
      timeout: 5000,
    });
    const wrapped = new TestSocket(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", (error) => reject(error));
    });
    if (t) await serverSocketReady(t, socket.id!);
    else await new Promise((resolve) => setTimeout(resolve, 60));
    return wrapped;
  }

  /** Kanal yang diikuti socket ini di sisi server (mis. `room:<id>`). */
  serverChannels(t: TestApp): Set<string> {
    const server = gatewayNamespace(t).sockets.get(this.socket.id!);
    return new Set(server ? [...server.rooms] : []);
  }

  of(type: string): Envelope[] {
    return this.events.filter((e) => e.type === type);
  }

  /** Menunggu event yang cocok (sudah diterima atau datang kemudian). */
  async waitFor(
    type: string,
    match: (e: Envelope) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<Envelope> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find((e) => e.type === type && match(e));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`event ${type} tidak diterima`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  /** Memastikan tidak ada event yang cocok dalam jendela waktu. */
  async none(type: string, match: (e: Envelope) => boolean = () => true, ms = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    expect(this.events.filter((e) => e.type === type && match(e))).toEqual([]);
  }

  emit(event: string, data?: unknown): void {
    if (data === undefined) this.socket.emit(event);
    else this.socket.emit(event, data);
  }

  close(): void {
    this.socket.disconnect();
  }
}

export async function listenApp(app: NestFastifyApplication): Promise<string> {
  await app.listen(0, "127.0.0.1");
  return app.getUrl();
}

/** Namespace /realtime milik gateway (uji membaca status socket sisi server). */
export function gatewayNamespace(t: TestApp): Namespace {
  const namespace = (t.app.get(RealtimeGateway) as unknown as { namespace: Namespace | null }).namespace;
  if (!namespace) throw new Error("Gateway realtime belum siap");
  return namespace;
}

async function serverSocketReady(t: TestApp, socketId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const server = gatewayNamespace(t).sockets.get(socketId);
    if (server && server.listeners("presence.ping").length > 0) return;
    if (Date.now() > deadline) throw new Error("socket sisi server tidak siap");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Menunggu sampai kondisi terpenuhi (mis. langganan kanal yang berubah setelah commit). */
export async function eventually(check: () => boolean, timeoutMs = 3000, label = "kondisi"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} tidak terpenuhi`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
