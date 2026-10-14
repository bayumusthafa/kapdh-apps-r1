import "reflect-metadata";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { admins, outboxEvents } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { SmtpMailer } from "../../src/core/adapters/mailer.js";
import { DisabledPush } from "../../src/core/adapters/push.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { commitAwareDb } from "../../src/core/db/tx.js";
import type { Db } from "../../src/core/db/types.js";
import { adminInviteTokenHash } from "../../src/core/identity/crypto.js";
import { JobRunner, OUTBOX_LOCK_MS, outboxBackoffMs } from "../../src/core/jobs/job-runner.js";
import { OutboxService } from "../../src/core/outbox/outbox.service.js";
import { OUTBOX_TOPICS, type OutboxPayload, type OutboxTopic } from "../../src/core/outbox/topics.js";
import { deletionRetryBackoffMs } from "../../src/modules/account/deletion-processor.js";
import { deletionRow, ensureAuditPurgeRole, requestDeletionViaApp, runDeletion } from "../account/support.js";
import { createAdmin, createAlumni, signInAlumni } from "../support/factories.js";
import { createTestDatabase, type TestApp, TestClock, testEnv } from "../support/test-app.js";

/**
 * Temuan audit D4-03 (PRD 5.1 "hasil antrean tidak boleh menggandakan notifikasi", PRD 9.2 "worker mati … outbox
 * mengirim hasil sekali"): email yang dikirim job langsung (pemberitahuan keamanan admin F-16, email penghapusan akun
 * F-14) dikirim ulang dengan Message-ID dan isi yang SAMA setelah worker mati sesudah server SMTP menerima pesan, atau
 * setelah balasan SMTP hilang sesudah akhir DATA, sehingga penerima mengenali salinan kedua sebagai pesan yang sama
 * (pola notifikasi F-13). Diuji ujung ke ujung: outbox/job → SmtpMailer → server SMTP tiruan LOKAL (127.0.0.1).
 *
 * Email undangan admin SENGAJA tidak memakai Message-ID stabil: setiap percobaan memuat token sekali pakai baru, jadi
 * salinan terbaru (satu-satunya tautan berlaku) tidak boleh dibuang penerima sebagai duplikat.
 */

interface SmtpSession {
  /** Isi DATA lengkap (header + badan) bila akhir DATA diterima server. */
  data: string | null;
  /** Server membalas 250 setelah akhir DATA. */
  accepted: boolean;
}

let server: Server;
let url: string;
/** Jumlah sesi berikutnya yang menerima akhir DATA tetapi tidak pernah membalas (balasan hilang di jaringan). */
let loseReplies = 0;
const sessions: SmtpSession[] = [];
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const session: SmtpSession = { data: null, accepted: false };
    sessions.push(session);
    let buffer = "";
    let inData = false;
    let silent = false;
    socket.write("220 uji.local ESMTP siap\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          session.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          if (loseReplies > 0) {
            loseReplies -= 1;
            silent = true; // pesan lengkap diterima server, balasan 250 tidak pernah sampai ke klien
          }
          if (silent) return;
          session.accepted = true;
          socket.write("250 2.0.0 OK diterima\r\n");
          continue;
        }
        const index = buffer.indexOf("\r\n");
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (silent) continue;
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") socket.write("250-uji.local\r\n250 8BITMIME\r\n");
        else if (verb === "HELO") socket.write("250 uji.local\r\n");
        else if (verb === "MAIL" || verb === "RCPT" || verb === "RSET") socket.write("250 2.0.0 OK\r\n");
        else if (verb === "DATA") {
          inData = true;
          socket.write("354 Lanjutkan, akhiri dengan <CRLF>.<CRLF>\r\n");
        } else if (verb === "QUIT") socket.end("221 2.0.0 Sampai jumpa\r\n");
        else socket.write("502 5.5.2 Perintah tidak dikenal\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `smtp://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

let app: NestFastifyApplication;
let t: TestApp;

beforeAll(async () => {
  const { pg, db: raw } = await createTestDatabase();
  const db = commitAwareDb(raw as Db);
  const clock = new TestClock();
  // socketTimeout pendek: balasan yang hilang setelah akhir DATA menjadi galat ETIMEDOUT dalam setengah detik.
  const mailer = new SmtpMailer(url, testEnv.MAIL_FROM, { timeouts: { socketTimeout: 500 } });
  const storage = new MemoryDriver();
  app = await createApp(
    { env: testEnv, db, mailer, clock, push: new DisabledPush(), storage, redis: null },
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const close = app.close.bind(app);
  app.close = async () => {
    await close();
    await pg.close();
  };
  t = { app, db, clock, storage, env: testEnv, jobs: app.get(JobRunner) } as unknown as TestApp;
  await ensureAuditPurgeRole(t.db);
});

beforeEach(() => {
  loseReplies = 0;
  sessions.length = 0;
});

afterAll(async () => {
  await app?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ------------------------------------------------------------------------------------------------ bantuan

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

function header(session: SmtpSession, name: string): string | undefined {
  const head = (session.data ?? "").split("\r\n\r\n")[0] ?? "";
  return new RegExp(`^${name}: (.+)$`, "im").exec(head.replace(/\r\n[ \t]+/g, " "))?.[1]?.trim();
}

/** Badan pesan setelah decoding transfer (7bit / quoted-printable / base64). */
function body(session: SmtpSession): string {
  const data = session.data ?? "";
  const raw = data.slice(data.indexOf("\r\n\r\n") + 4);
  const encoding = header(session, "Content-Transfer-Encoding")?.toLowerCase();
  if (encoding === "base64") return Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding === "quoted-printable") {
    const bytes = raw
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return raw;
}

function sessionsTo(email: string): SmtpSession[] {
  return sessions.filter((s) => header(s, "To")?.toLowerCase().includes(email.toLowerCase()));
}

async function publish<T extends OutboxTopic>(topic: T, payload: OutboxPayload<T>): Promise<string> {
  const id = await runAsSystem(() =>
    t.db.transaction((tx) =>
      t.app.get(OutboxService).publish(tx, { topic, dedupKey: `uji-d4-03:${uuidv7()}`, payload }),
    ),
  );
  expect(id).not.toBeNull();
  return id!;
}

/**
 * Worker A mengklaim event lalu menjalankan handler topiknya persis seperti processOutboxClaim, kemudian MATI sebelum
 * finalisasi: server SMTP sudah menerima email, event tetap `pending` dengan lease milik worker A.
 */
async function workerDiesAfterHandler(eventId: string): Promise<void> {
  const claims = await t.jobs.claimOutbox({ limit: 100 });
  const claim = claims.find((c) => c.id === eventId);
  expect(claim, "event diklaim worker A").toBeDefined();
  for (const other of claims) if (other.id !== eventId) await t.jobs.releaseOutboxClaim(other);
  const [row] = await t.db.select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
  const topic = row!.topic as OutboxTopic;
  const handler = t.jobs.registry.handlerFor(topic)!;
  await runAsSystem(() =>
    handler.handle(
      {
        id: row!.id,
        topic,
        dedupKey: row!.dedupKey,
        attempts: claim!.attempts,
        requestId: row!.requestId,
        payload: OUTBOX_TOPICS[topic].parse(row!.payload),
      },
      { jobId: `outbox:${eventId}`, requestId: eventId, logger: silentLogger },
    ),
  );
}

/** Message-ID stabil pemberitahuan keamanan admin: kunci `admin-security-notice.<id event outbox>` (SmtpMailer). */
function noticeMessageId(outboxEventId: string): string {
  return `<admin-security-notice.${outboxEventId}.notifikasi@kapdh.test>`;
}

async function outboxRow(id: string) {
  const [row] = await t.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
  return row!;
}

// ------------------------------------------------------------------------------------------------ uji

describe("D4-03: pemberitahuan keamanan admin dikirim ulang outbox tanpa email ganda baru (PRD 5.1, 9.2)", () => {
  it("worker mati setelah server SMTP menerima pemberitahuan, sebelum event ditandai dispatched → salinan ulang membawa Message-ID dan isi yang sama", async () => {
    const admin = await createAdmin(t, { displayName: "Pengurus Redelivery" });
    const eventId = await publish("admin.security_notice", {
      admin_id: admin.adminId,
      kind: "password_changed",
    });

    await workerDiesAfterHandler(eventId);
    expect(sessionsTo(admin.email).map((s) => s.accepted)).toEqual([true]);
    expect(await outboxRow(eventId)).toMatchObject({ status: "pending", attempts: 1 });

    // Lease worker A habis → worker B mengklaim ulang dan menjalankan handler lagi (outbox at-least-once).
    t.clock.advance(OUTBOX_LOCK_MS + 60_000);
    const result = await t.jobs.drainOutbox();
    expect(result.failed + result.dead).toBe(0);
    expect(await outboxRow(eventId)).toMatchObject({ status: "dispatched", attempts: 2 });

    const copies = sessionsTo(admin.email);
    expect(copies).toHaveLength(2);
    const expectedId = noticeMessageId(eventId);
    expect(copies.map((s) => header(s, "Message-ID"))).toEqual([expectedId, expectedId]);
    expect(header(copies[1]!, "Subject")).toBe(header(copies[0]!, "Subject"));
    // Isi identik walau jam maju > 6 menit: "Waktu" = waktu event outbox ditulis, bukan waktu percobaan kirim.
    expect(body(copies[1]!)).toBe(body(copies[0]!));
    expect(body(copies[0]!)).toContain("Yth. Pengurus Redelivery");
    expect(body(copies[0]!)).toMatch(/Waktu: .+ WIB\./);
  });

  it("balasan SMTP hilang setelah akhir DATA → event gagal lalu diulang outbox dengan Message-ID yang sama", async () => {
    const admin = await createAdmin(t, { displayName: "Pengurus Balasan Hilang" });
    const eventId = await publish("admin.security_notice", { admin_id: admin.adminId, kind: "role_changed" });

    loseReplies = 1;
    const first = await t.jobs.drainOutbox();
    expect(first.failed).toBe(1);
    expect(await outboxRow(eventId)).toMatchObject({ status: "failed", attempts: 1 });

    t.clock.advance(outboxBackoffMs(1));
    const second = await t.jobs.drainOutbox();
    expect(second.dispatched).toBe(1);
    expect(await outboxRow(eventId)).toMatchObject({ status: "dispatched", attempts: 2 });

    const copies = sessionsTo(admin.email);
    // Server menerima pesan lengkap DUA kali (yang pertama tanpa balasan); keduanya pesan yang sama bagi penerima.
    expect(copies.map((s) => s.data !== null)).toEqual([true, true]);
    expect(copies.map((s) => s.accepted)).toEqual([false, true]);
    const expectedId = noticeMessageId(eventId);
    expect(copies.map((s) => header(s, "Message-ID"))).toEqual([expectedId, expectedId]);
    expect(body(copies[1]!)).toBe(body(copies[0]!));
  });

  it("dua event pemberitahuan yang berbeda (dua perubahan sandi) tetap dua email dengan Message-ID berbeda", async () => {
    const admin = await createAdmin(t, { displayName: "Pengurus Dua Perubahan" });
    const firstId = await publish("admin.security_notice", {
      admin_id: admin.adminId,
      kind: "password_changed",
    });
    const secondId = await publish("admin.security_notice", {
      admin_id: admin.adminId,
      kind: "password_changed",
    });
    const result = await t.jobs.drainOutbox();
    expect(result.failed + result.dead).toBe(0);

    const ids = sessionsTo(admin.email).map((s) => header(s, "Message-ID"));
    expect(ids.sort()).toEqual([noticeMessageId(firstId), noticeMessageId(secondId)].sort());
  });

  it("undangan admin: percobaan ulang menerbitkan token baru dan SENGAJA memakai Message-ID berbeda; hanya tautan email terakhir yang cocok dengan hash tersimpan", async () => {
    const invited = await createAdmin(t, { status: "invited", displayName: "Calon Pengurus Ulang" });
    const [row] = await t.db.select().from(admins).where(eq(admins.id, invited.adminId));
    const eventId = await publish("admin.invitation.requested", {
      admin_id: invited.adminId,
      invite_expires_at: row!.inviteExpiresAt!.toISOString(),
    });

    await workerDiesAfterHandler(eventId);
    t.clock.advance(OUTBOX_LOCK_MS + 60_000);
    await t.jobs.drainOutbox();
    expect(await outboxRow(eventId)).toMatchObject({ status: "dispatched", attempts: 2 });

    const copies = sessionsTo(invited.email);
    expect(copies).toHaveLength(2);
    const [firstId, secondId] = copies.map((s) => header(s, "Message-ID"));
    expect(firstId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    expect(firstId).not.toContain(eventId);
    const tokens = copies.map((s) => /\/invite#t=([A-Za-z0-9_-]+)/.exec(body(s))?.[1]);
    expect(tokens[0]).toBeDefined();
    expect(tokens[1]).toBeDefined();
    expect(tokens[1]).not.toBe(tokens[0]);
    const [after] = await t.db.select().from(admins).where(eq(admins.id, invited.adminId));
    expect(after!.inviteTokenHash).toBe(adminInviteTokenHash(tokens[1]!));
    expect(after!.inviteTokenHash).not.toBe(adminInviteTokenHash(tokens[0]!));
  });
});

describe("D4-03: email penghapusan akun dikirim ulang dengan Message-ID stabil per langkah (F-14, PRD 5.1)", () => {
  it("balasan SMTP hilang pada email konfirmasi → langkah notify_requested diulang dengan Message-ID dan isi yang sama; email selesai memakai kunci langkahnya sendiri", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const { id, requestNumber } = await requestDeletionViaApp(t, await signInAlumni(t, member));

    loseReplies = 1;
    expect(await runDeletion(t, id)).toMatchObject({ outcome: "failed", step: "notify_requested" });
    expect((await deletionRow(t.db, id)).stepsDone).toEqual(["ledger_open"]);
    t.clock.advance(deletionRetryBackoffMs(1));
    expect(await runDeletion(t, id)).toMatchObject({ outcome: "completed", requestNumber });

    const copies = sessionsTo(member.email);
    expect(copies.map((s) => header(s, "Subject"))).toEqual([
      `Permintaan penghapusan akun KAPDH ${requestNumber} diterima`,
      `Permintaan penghapusan akun KAPDH ${requestNumber} diterima`,
      `Penghapusan akun KAPDH ${requestNumber} selesai`,
    ]);
    expect(copies.map((s) => s.accepted)).toEqual([false, true, true]);
    const requested = `<account-deletion.${id}.notify-requested.notifikasi@kapdh.test>`;
    const completed = `<account-deletion.${id}.notify-completed.notifikasi@kapdh.test>`;
    expect(copies.map((s) => header(s, "Message-ID"))).toEqual([requested, requested, completed]);
    expect(body(copies[1]!)).toBe(body(copies[0]!));
  });

  it("SmtpMailer.sendTransactional: dedupKey menjadi Message-ID stabil; tanpa dedupKey Message-ID tetap acak per pesan", async () => {
    const mailer = new SmtpMailer(url, testEnv.MAIL_FROM);
    const mail = { to: "penerima@contoh.test", subject: "Uji", text: "Isi uji." };
    await mailer.sendTransactional({ ...mail, dedupKey: "account-deletion.kunci.notify_requested" });
    await mailer.sendTransactional({ ...mail, dedupKey: "account-deletion.kunci.notify_requested" });
    await mailer.sendTransactional(mail);
    await mailer.sendTransactional(mail);
    const ids = sessionsTo(mail.to).map((s) => header(s, "Message-ID"));
    expect(ids.slice(0, 2)).toEqual([
      "<account-deletion.kunci.notify-requested.notifikasi@kapdh.test>",
      "<account-deletion.kunci.notify-requested.notifikasi@kapdh.test>",
    ]);
    expect(ids[2]).toBeDefined();
    expect(ids[3]).not.toBe(ids[2]);
  });
});
