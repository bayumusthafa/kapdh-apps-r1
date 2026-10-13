/**
 * Chat di bawah konkurensi nyata PostgreSQL 17 (PRD 9.2 "direct-room race", PRD 3.11, AC F11-1, F11-2, F11-3; kontrak
 * domains/chat.yaml aturan urutan commit C6). API berjalan dengan login role kapdh_app (grant production) dan pool
 * postgres-js sungguhan, sehingga transaksi benar-benar berjalan bersamaan.
 *
 * Bukti konkurensi deterministik: transaksi penahan memegang kunci yang sama dengan jalur layanan (kunci pasangan
 * advisory, baris rooms, baris room_members), lalu semua request ditembakkan dan uji menunggu sampai SEMUA backend
 * request terlihat menunggu kunci (pg_stat_activity wait_event_type = 'Lock') sebelum penahan commit. Dengan begitu
 * request pasti saling berebut, bukan berjalan berurutan karena kebetulan waktu.
 */
import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { ADVISORY_LOCK_NAMESPACES } from "../../src/core/db/locks.js";
import type { Db } from "../../src/core/db/types.js";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import {
  connectAs,
  createPgTestDatabase,
  LOCK_WAIT_TIMEOUT_MS,
  type PgTestDatabase,
  sleep,
  type Sql,
} from "./support.js";

let tdb: PgTestDatabase;
let sql: Sql;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
const clock = new TestClock();

beforeAll(async () => {
  tdb = await createPgTestDatabase("chat", 8);
  sql = tdb.sql;
  api = connectAs(tdb, "kapdh_app", 16);
  app = await createApp(
    {
      env: testEnv,
      db: api.db as unknown as Db,
      mailer: new MemoryMailer(),
      clock,
      push: new FakePush(),
      redis: null,
    },
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb?.drop();
});

interface Member {
  userId: string;
  token: string;
}

let counter = 0;
/** Anggota verified (aktif) dengan sesi aplikasi; fixture ditulis superuser, login lewat API nyata. */
async function member(): Promise<Member> {
  const fixture = await createAlumni(
    { db: tdb.db as unknown as Db, clock },
    { status: "verified", fullName: `Anggota PG ${++counter}` },
  );
  const session = await signInAlumni({ app }, fixture);
  return { userId: fixture.userId, token: session.accessToken };
}

interface Reply {
  statusCode: number;
  body: Record<string, unknown>;
}

async function call(method: "GET" | "POST" | "PUT", url: string, who: Member, payload?: object): Promise<Reply> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${who.token}` },
    ...(payload ? { payload } : {}),
  });
  return { statusCode: res.statusCode, body: res.json() };
}

async function openDirect(from: Member, to: Member): Promise<string> {
  const res = await call("POST", "/chat/direct", from, { user_id: to.userId });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.statusCode);
  return res.body.id as string;
}

async function sendText(from: Member, roomId: string, body: string): Promise<string> {
  const res = await call("POST", `/chat/rooms/${roomId}/messages`, from, {
    client_message_id: uuidv7(),
    kind: "text",
    body,
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** Jumlah backend database ini yang sedang menunggu kunci (baris, transaksi, atau advisory). */
async function lockWaiters(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'`;
  return row?.n ?? 0;
}

/** Menunggu sampai minimal `n` backend menunggu kunci; false bila batas waktu habis. */
async function untilLockWaiters(n: number): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await lockWaiters()) >= n) return true;
    await sleep(5);
  }
  return false;
}

/**
 * Transaksi penahan pada koneksi superuser terpisah: mengambil kunci lewat `lock`, lalu menahan commit sampai
 * `release()` dipanggil.
 */
async function holdLock(lock: (tx: Sql) => Promise<unknown>): Promise<{ release: () => Promise<void> }> {
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    failed = reject;
  });
  let letGo!: () => void;
  const gate = new Promise<void>((resolve) => (letGo = resolve));
  const holder = sql
    .begin(async (tx) => {
      await lock(tx as unknown as Sql);
      acquired();
      await gate;
    })
    .catch((error: unknown) => failed(error));
  await ready;
  return {
    release: async () => {
      letGo();
      await holder;
    },
  };
}

describe("AC F11-1 / PRD 9.2: direct-room race (PostgreSQL 17, role kapdh_app)", () => {
  it("AC F11-1: pembuatan bersamaan dari kedua pihak yang benar-benar berebut kunci pasangan menghasilkan tepat satu room kanonik", async () => {
    const a = await member();
    const b = await member();
    const [low, high] = [a.userId, b.userId].sort();
    const directKey = `${low}:${high}`;
    const gate = await holdLock(
      (tx) => tx`select pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACES.blockPair}::int4, hashtext(${directKey}))`,
    );
    const callers = [a, b, a, b, a, b];
    const pending = callers.map((from) =>
      call("POST", "/chat/direct", from, { user_id: (from === a ? b : a).userId }),
    );
    // Keenam transaksi request menunggu kunci pasangan yang sama sebelum penahan commit.
    expect(await untilLockWaiters(callers.length)).toBe(true);
    await gate.release();
    const results = await Promise.all(pending);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    const roomsRows = await sql<{ id: string; kind: string }[]>`
      select id, kind::text as kind from app.rooms where direct_key = ${directKey}`;
    expect(roomsRows).toHaveLength(1);
    expect(roomsRows[0]!.id).toBe([...ids][0]);
    const members = await sql<{ user_id: string; status: string }[]>`
      select user_id, status::text as status from app.room_members where room_id = ${roomsRows[0]!.id}
      order by user_id`;
    expect(members).toEqual([
      { user_id: low, status: "joined" },
      { user_id: high, status: "joined" },
    ]);
  });

  it("AC F11-1: banyak pasangan membuka room dari kedua sisi bersamaan tanpa gerbang: satu room dan satu 201 per pasangan", async () => {
    const pairs: [Member, Member][] = [];
    for (let i = 0; i < 6; i++) pairs.push([await member(), await member()]);
    const results = await Promise.all(
      pairs.flatMap(([a, b]) =>
        [a, b, a, b].map(async (from) => ({
          key: [a.userId, b.userId].sort().join(":"),
          res: await call("POST", "/chat/direct", from, { user_id: (from === a ? b : a).userId }),
        })),
      ),
    );
    for (const [a, b] of pairs) {
      const key = [a.userId, b.userId].sort().join(":");
      const mine = results.filter((r) => r.key === key).map((r) => r.res);
      expect(mine.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 201]);
      expect(new Set(mine.map((r) => r.body.id)).size).toBe(1);
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from app.rooms where direct_key = ${key}`;
      expect(row!.n).toBe(1);
    }
  });
});

describe("AC F11-2: client_message_id duplikat bersamaan (PostgreSQL 17)", () => {
  it("AC F11-2: pengulangan bersamaan dengan client_message_id sama di room yang sama menghasilkan satu pesan; satu 201 dan sisanya 200 dengan pesan yang sama", async () => {
    const a = await member();
    const b = await member();
    const roomId = await openDirect(a, b);
    const clientMessageId = uuidv7();
    const payload = { client_message_id: clientMessageId, kind: "text", body: "Retry bersamaan" };
    const gate = await holdLock((tx) => tx`select id from app.rooms where id = ${roomId} for update`);
    const pending = Array.from({ length: 6 }, () => call("POST", `/chat/rooms/${roomId}/messages`, a, payload));
    expect(await untilLockWaiters(6)).toBe(true);
    await gate.release();
    const results = await Promise.all(pending);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const stored = await sql<{ id: string }[]>`
      select id from app.messages where sender_id = ${a.userId} and client_message_id = ${clientMessageId}`;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(results[0]!.body.id);
  });

  it("AC F11-2: client_message_id sama dikirim bersamaan ke dua room berbeda: unique per pengirim menjadi wasit, satu 201 dan satu 409 IDEMPOTENCY_CONFLICT", async () => {
    const a = await member();
    const b = await member();
    const c = await member();
    const roomB = await openDirect(a, b);
    const roomC = await openDirect(a, c);
    const clientMessageId = uuidv7();
    const gate = await holdLock(
      (tx) => tx`select id from app.rooms where id in (${roomB}, ${roomC}) order by id for update`,
    );
    const pending = [roomB, roomC].map((roomId) =>
      call("POST", `/chat/rooms/${roomId}/messages`, a, {
        client_message_id: clientMessageId,
        kind: "text",
        body: "Sama",
      }),
    );
    expect(await untilLockWaiters(2)).toBe(true);
    await gate.release();
    const results = await Promise.all(pending);

    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.body.code).toBe("IDEMPOTENCY_CONFLICT");
    const stored = await sql<{ id: string }[]>`
      select id from app.messages where sender_id = ${a.userId} and client_message_id = ${clientMessageId}`;
    expect(stored).toHaveLength(1);
  });
});

describe("PRD 3.11: read cursor monoton di bawah pembaruan bersamaan (PostgreSQL 17)", () => {
  it("PRD 3.11: paket baca terlambat yang menunggu kunci baris yang sama tidak pernah memundurkan cursor", async () => {
    const a = await member();
    const b = await member();
    const roomId = await openDirect(a, b);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await sendText(a, roomId, `pesan ${i}`));
    const newest = ids.at(-1)!;

    const gate = await holdLock(
      (tx) => tx`select 1 from app.room_members where room_id = ${roomId} and user_id = ${b.userId} for update`,
    );
    // Pembaruan terbaru antre lebih dulu; paket lama (terlambat) antre di belakangnya pada baris yang sama.
    const first = call("PUT", `/chat/rooms/${roomId}/read`, b, { message_id: newest });
    expect(await untilLockWaiters(1)).toBe(true);
    const older = [...ids.slice(0, -1)].reverse();
    const late = older.map((id) => call("PUT", `/chat/rooms/${roomId}/read`, b, { message_id: id }));
    expect(await untilLockWaiters(ids.length)).toBe(true);
    await gate.release();
    const results = await Promise.all([first, ...late]);

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    // Setiap respons melaporkan cursor yang tidak lebih lama dari pesan yang diminta, dan akhirnya pesan terbaru.
    [newest, ...older].forEach((requested, i) => {
      const reported = results[i]!.body.last_read_message_id as string;
      expect(ids.indexOf(reported)).toBeGreaterThanOrEqual(ids.indexOf(requested));
    });
    const [state] = await sql<{ last_read_message_id: string }[]>`
      select last_read_message_id from app.room_members where room_id = ${roomId} and user_id = ${b.userId}`;
    expect(state!.last_read_message_id).toBe(newest);
    expect(results[0]!.body).toMatchObject({ last_read_message_id: newest, unread_count: 0 });
  });

  it("PRD 3.11: banyak pembaruan baca bersamaan dalam urutan acak berakhir pada pesan terbaru", async () => {
    const a = await member();
    const b = await member();
    const roomId = await openDirect(a, b);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await sendText(a, roomId, `acak ${i}`));
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    const results = await Promise.all(
      shuffled.map((id) => call("PUT", `/chat/rooms/${roomId}/read`, b, { message_id: id })),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const [state] = await sql<{ last_read_message_id: string }[]>`
      select last_read_message_id from app.room_members where room_id = ${roomId} and user_id = ${b.userId}`;
    expect(state!.last_read_message_id).toBe(ids.at(-1));
  });
});

describe("AC F11-3 / N-02: urutan commit = urutan keyset; sinkron after tanpa celah saat pengiriman bersamaan", () => {
  it("AC F11-3: pembaca yang terus menyinkron after=<jangkar> selama 30 pengiriman bersamaan menerima setiap pesan tepat sekali dan berurutan", async () => {
    const admin = await member();
    const senders = [await member(), await member(), await member()];
    const reader = await member();
    const created = await call("POST", "/chat/rooms", admin, {
      name: "Grup Balapan",
      invitee_user_ids: [...senders, reader].map((m) => m.userId),
    });
    expect(created.statusCode).toBe(201);
    const roomId = (created.body.room as { id: string }).id;
    for (const m of [...senders, reader]) {
      const accepted = await call("POST", `/chat/invitations/${roomId}/accept`, m);
      expect(accepted.statusCode).toBe(200);
    }
    const start = await call("GET", `/chat/rooms/${roomId}/messages`, reader);
    let anchor = (start.body.items as { id: string }[]).at(-1)!.id;

    const collected: string[] = [];
    const drain = async () => {
      for (;;) {
        const page = await call("GET", `/chat/rooms/${roomId}/messages?after=${anchor}&limit=100`, reader);
        expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
        const items = page.body.items as { id: string }[];
        for (const item of items) collected.push(item.id);
        if (items.length > 0) anchor = items.at(-1)!.id;
        if (!page.body.next_cursor) return;
      }
    };
    let sending = true;
    const poller = (async () => {
      while (sending) {
        await drain();
        await sleep(2);
      }
    })();
    const sent = await Promise.all(
      senders.flatMap((sender, s) =>
        Array.from({ length: 10 }, (_, i) => sendText(sender, roomId, `pengirim ${s} pesan ${i}`)),
      ),
    );
    sending = false;
    await poller;
    await drain();

    // Setiap pesan diterima tepat sekali, tanpa celah walau pembaca menyinkron selagi commit berlangsung.
    expect(new Set(collected).size).toBe(collected.length);
    expect([...collected].sort()).toEqual([...sent].sort());
    // Urutan yang diterima = urutan keyset (created_at, id) = urutan commit (created_at naik ketat).
    const ordered = await sql<{ id: string; strictly: boolean }[]>`
      select id, coalesce(created_at > lag(created_at) over (order by created_at, id), true) as strictly
      from app.messages where room_id = ${roomId} and kind <> 'system' order by created_at, id`;
    expect(ordered.map((r) => r.id)).toEqual(collected);
    expect(ordered.every((r) => r.strictly)).toBe(true);
    const [room] = await sql<{ ok: boolean }[]>`
      select r.last_message_at = (select max(m.created_at) from app.messages m where m.room_id = r.id) as ok
      from app.rooms r where r.id = ${roomId}`;
    expect(room!.ok).toBe(true);
  });
});
