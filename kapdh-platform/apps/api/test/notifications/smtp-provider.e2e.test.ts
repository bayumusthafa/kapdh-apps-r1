import "reflect-metadata";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { SMTP_SEND_TIMEOUTS, SmtpMailer } from "../../src/core/adapters/mailer.js";
import { DisabledPush } from "../../src/core/adapters/push.js";
import { commitAwareDb } from "../../src/core/db/tx.js";
import type { Db } from "../../src/core/db/types.js";
import { JobRunner } from "../../src/core/jobs/job-runner.js";
import {
  classifyMailError,
  DELIVERY_SEND_TIMEOUT_MS,
  deliveryBackoffMs,
  ProviderTimeoutError,
} from "../../src/modules/notifications/delivery-policy.js";
import { createAlumni } from "../support/factories.js";
import { createTestDatabase, type TestApp, TestClock, testEnv } from "../support/test-app.js";
import { deliveryOf, deliveryService, notify } from "./support.js";

/**
 * SmtpMailer.send (email transaksional F-13) diuji terhadap server SMTP tiruan LOKAL (127.0.0.1, tanpa jaringan nyata):
 * pembatalan pemanggil MENUTUP koneksi sebelum akhir DATA sehingga server tidak pernah menerima pesan (AC F13-4: retry
 * tanpa email ganda), batas waktu koneksi/socket di bawah batas waktu percobaan, Message-ID stabil per kunci pesan, dan
 * jalur penuh prosesor pengiriman → SMTP tiruan yang lambat.
 */

type Stall = "greeting" | "DATA" | "end-of-data";

interface Session {
  commands: string[];
  /** Isi DATA lengkap (tanpa terminator) bila akhir DATA diterima. */
  data: string | null;
  /** Server membalas 250 setelah akhir DATA (pesan diterima). */
  accepted: boolean;
  closed: boolean;
  closedAt: number | null;
}

let server: Server;
let url: string;
let stall: Stall | null = null;
let rcptReply = "250 2.1.5 OK\r\n";
const sessions: Session[] = [];
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((socket) => {
    sockets.add(socket);
    const session: Session = { commands: [], data: null, accepted: false, closed: false, closedAt: null };
    sessions.push(session);
    const behaviour = stall;
    const rcpt = rcptReply;
    socket.on("close", () => {
      session.closed = true;
      session.closedAt = Date.now();
      sockets.delete(socket);
    });
    socket.on("error", () => {});
    if (behaviour !== "greeting") socket.write("220 uji.local ESMTP siap\r\n");
    let buffer = "";
    let inData = false;
    const process = () => {
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          session.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          if (behaviour === "end-of-data") return; // pesan lengkap, balasan tidak pernah dikirim
          session.accepted = true;
          socket.write("250 2.0.0 OK diterima\r\n");
          continue;
        }
        const index = buffer.indexOf("\r\n");
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        session.commands.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") socket.write("250-uji.local\r\n250 8BITMIME\r\n");
        else if (verb === "HELO") socket.write("250 uji.local\r\n");
        else if (verb === "MAIL") socket.write("250 2.1.0 OK\r\n");
        else if (verb === "RCPT") socket.write(rcpt);
        else if (verb === "DATA") {
          if (behaviour === "DATA") return; // server macet: tidak pernah membalas 354
          inData = true;
          socket.write("354 Lanjutkan, akhiri dengan <CRLF>.<CRLF>\r\n");
        } else if (verb === "QUIT") socket.end("221 2.0.0 Sampai jumpa\r\n");
        else if (verb === "RSET") socket.write("250 2.0.0 OK\r\n");
        else socket.write("502 5.5.2 Perintah tidak dikenal\r\n");
      }
    };
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      process();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `smtp://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  stall = null;
  rcptReply = "250 2.1.5 OK\r\n";
  sessions.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function until(condition: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  expect(condition(), label).toBe(true);
}

const message = {
  to: "anggota@contoh.test",
  subject: "KAPDH: Pembayaran disetujui\r\nBcc: sisipan@contoh.test",
  text: "Iuran Anda telah disetujui pengurus.",
  dedupKey: "0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f",
};

describe("SmtpMailer.send terhadap server SMTP tiruan (F-13)", () => {
  it("mengirim pesan: Message-ID stabil dari dedupKey, subjek satu baris (tanpa sisipan header), Auto-Submitted", async () => {
    const mailer = new SmtpMailer(url, "KAPDH <noreply@kapdh.test>");
    const result = await mailer.send(message);
    expect(result).toEqual({ messageId: `<${message.dedupKey}.notifikasi@kapdh.test>` });
    const [session] = sessions;
    expect(session!.accepted).toBe(true);
    expect(session!.commands.some((c) => /^MAIL FROM:<noreply@kapdh\.test>/i.test(c))).toBe(true);
    expect(session!.commands.some((c) => /^RCPT TO:<anggota@contoh\.test>/i.test(c))).toBe(true);
    expect(session!.data).toContain(`Message-ID: <${message.dedupKey}.notifikasi@kapdh.test>`);
    expect(session!.data).toContain("Auto-Submitted: auto-generated");
    expect(session!.data).toMatch(/^Subject: KAPDH: Pembayaran disetujui Bcc: sisipan@contoh\.test\r$/m);
    expect(session!.data).not.toMatch(/^Bcc:/m);
    await until(() => session!.closed, "koneksi ditutup setelah terkirim");
  });

  it("AC F13-4: pembatalan pemanggil saat server macet sebelum akhir DATA → koneksi DITUTUP, server tidak pernah menerima pesan, galat timeout", async () => {
    stall = "DATA";
    const mailer = new SmtpMailer(url, "noreply@kapdh.test");
    const controller = new AbortController();
    const sending = mailer.send(message, { signal: controller.signal }).catch((e: unknown) => e);
    await until(() => sessions[0]?.commands.includes("DATA") === true, "server menerima perintah DATA");
    const abortedAt = Date.now();
    const reason = new ProviderTimeoutError();
    controller.abort(reason);
    const error = await sending;
    expect(error).toBe(reason);
    expect(classifyMailError(error)).toEqual({ kind: "retry", errorClass: "timeout" });
    await until(() => sessions[0]!.closed, "koneksi SMTP ditutup klien", 3_000);
    expect(sessions[0]!.closedAt! - abortedAt).toBeLessThan(3_000);
    expect(sessions[0]!.data).toBeNull();
    expect(sessions[0]!.accepted).toBe(false);
  });

  it("AC F13-4: sinyal yang sudah dibatalkan tidak membuka koneksi", async () => {
    const mailer = new SmtpMailer(url, "noreply@kapdh.test");
    const reason = new ProviderTimeoutError();
    await expect(mailer.send(message, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    await new Promise((r) => setTimeout(r, 50));
    expect(sessions).toHaveLength(0);
  });

  it("AC F13-4: balasan hilang setelah akhir DATA (sisa ambiguitas jaringan) → percobaan ulang memakai Message-ID yang sama", async () => {
    stall = "end-of-data";
    const mailer = new SmtpMailer(url, "noreply@kapdh.test");
    const controller = new AbortController();
    const first = mailer.send(message, { signal: controller.signal }).catch((e: unknown) => e);
    await until(
      () => sessions[0]?.data !== null && sessions[0]?.data !== undefined,
      "akhir DATA diterima server",
    );
    controller.abort(new ProviderTimeoutError());
    expect(await first).toBeInstanceOf(ProviderTimeoutError);
    stall = null;
    await mailer.send(message);
    const ids = sessions.map((s) => /^Message-ID: (.+)\r$/m.exec(s.data ?? "")?.[1]);
    expect(ids).toEqual([
      `<${message.dedupKey}.notifikasi@kapdh.test>`,
      `<${message.dedupKey}.notifikasi@kapdh.test>`,
    ]);
  });

  it("AC F13-4: server tidak menyapa / tidak membalas → batas waktu koneksi dan socket nodemailer (bukan 2–10 menit)", async () => {
    for (const key of Object.keys(SMTP_SEND_TIMEOUTS) as (keyof typeof SMTP_SEND_TIMEOUTS)[])
      expect(SMTP_SEND_TIMEOUTS[key], key).toBeLessThan(DELIVERY_SEND_TIMEOUT_MS);
    const mailer = new SmtpMailer(url, "noreply@kapdh.test", {
      timeouts: { connectionTimeout: 300, greetingTimeout: 200, socketTimeout: 300 },
    });

    stall = "greeting";
    let started = Date.now();
    const greeting = await mailer.send(message).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(greeting).toMatchObject({ code: "ETIMEDOUT" });
    expect(classifyMailError(greeting)).toEqual({ kind: "retry", errorClass: "timeout" });

    stall = "DATA";
    started = Date.now();
    const silent = await mailer.send(message).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(classifyMailError(silent)).toEqual({ kind: "retry", errorClass: "timeout" });
    expect(sessions.every((s) => !s.accepted)).toBe(true);
  });

  it("batas waktu yang lebih besar di SMTP_URL tidak melonggarkan batas pengiriman", async () => {
    const mailer = new SmtpMailer(`${url}?socketTimeout=600000&connectionTimeout=5000`, "noreply@kapdh.test");
    const options = (mailer as unknown as { connectionOptions: Record<string, unknown> }).connectionOptions;
    expect(options).toMatchObject({
      socketTimeout: SMTP_SEND_TIMEOUTS.socketTimeout,
      connectionTimeout: 5_000,
      greetingTimeout: SMTP_SEND_TIMEOUTS.greetingTimeout,
      dnsTimeout: SMTP_SEND_TIMEOUTS.dnsTimeout,
    });
  });

  it("penerima ditolak server (550) → galat dengan responseCode untuk klasifikasi bounce_hard", async () => {
    rcptReply = "550 5.1.1 Alamat tidak ada\r\n";
    const mailer = new SmtpMailer(url, "noreply@kapdh.test");
    const error = await mailer.send(message).catch((e: unknown) => e);
    expect(classifyMailError(error)).toEqual({
      kind: "failed",
      errorClass: "bounce_hard",
      revokeToken: false,
    });
    expect(sessions[0]!.accepted).toBe(false);
  });
});

describe("Prosesor pengiriman → SMTP tiruan yang lambat (F-13, AC F13-1, F13-4)", () => {
  let app: NestFastifyApplication;
  let t: TestApp;

  beforeAll(async () => {
    const { pg, db: raw } = await createTestDatabase();
    const db = commitAwareDb(raw as Db);
    const clock = new TestClock();
    const mailer = new SmtpMailer(url, testEnv.MAIL_FROM);
    app = await createApp(
      { env: testEnv, db, mailer, clock, push: new DisabledPush(), storage: new MemoryDriver(), redis: null },
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const close = app.close.bind(app);
    app.close = async () => {
      await close();
      await pg.close();
    };
    t = { app, db, clock, mailer, jobs: app.get(JobRunner) } as unknown as TestApp;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("AC F13-4: percobaan pertama macet melewati batas waktu → koneksi ditutup tanpa pesan diterima; retry diterima tepat sekali", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const realSetTimeout = globalThis.setTimeout;
    // Batas waktu percobaan 60 detik dipersingkat hanya untuk timer itu.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) =>
      realSetTimeout(
        handler,
        ms === DELIVERY_SEND_TIMEOUT_MS ? 200 : ms,
        ...args,
      )) as unknown as typeof setTimeout);
    stall = "DATA";
    const created = await notify(t, member.userId, { category: "membership", route: "/kta" });
    expect(await deliveryService(t).deliver(created.id)).toMatchObject({ claimed: 1, retried: 1 });
    vi.mocked(globalThis.setTimeout).mockRestore();

    const first = await deliveryOf(t, created.id, "email");
    expect(first).toMatchObject({ status: "pending", errorClass: "timeout", attempt: 1 });
    await until(() => sessions[0]?.closed === true, "koneksi percobaan pertama ditutup", 3_000);
    expect(sessions[0]!.accepted).toBe(false);

    stall = null;
    t.clock.advance(deliveryBackoffMs(1));
    await t.jobs.runScheduled("notifications.retry");
    const sent = await deliveryOf(t, created.id, "email");
    expect(sent).toMatchObject({ status: "sent", attempt: 2, providerStatus: "accepted" });
    expect(sent.providerMessageId).toBe(`<${first.id}.notifikasi@kapdh.test>`);
    expect(sessions.filter((s) => s.accepted)).toHaveLength(1);
    expect(sessions.filter((s) => s.commands.some((c) => /^RCPT TO:/i.test(c)))).toHaveLength(2);
  });
});
