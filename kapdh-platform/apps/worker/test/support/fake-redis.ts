/**
 * Server RESP minimal untuk menguji tumpukan ioredis + BullMQ SUNGGUHAN tanpa Redis (tidak tersedia di mesin uji):
 * cukup untuk sambungan ioredis (ready check INFO), inisialisasi BullMQ (versi, kebijakan eviction), PING, dan skrip
 * Lua BullMQ yang dijawab array kosong (hitungan job 0). Perintah blocking (BZPOPMIN) tidak pernah dijawab, seperti
 * antrean kosong. Uji dapat menyalakan/mematikan server di port yang sama dan membuatnya "membisu" (koneksi setengah
 * terbuka: perintah diterima tetapi tidak dijawab).
 */
import { createServer, type Server, type Socket } from "node:net";

export type FakeReply = string | null;

const INFO = [
  "# Server",
  "redis_version:7.2.4",
  "redis_mode:standalone",
  "# Persistence",
  "loading:0",
  "# Memory",
  "maxmemory_policy:noeviction",
  "",
].join("\r\n");

const bulk = (value: string) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`;

export function defaultReply(command: string[]): FakeReply {
  const name = (command[0] ?? "").toUpperCase();
  switch (name) {
    case "PING":
      return "+PONG\r\n";
    case "INFO":
      return bulk(INFO);
    case "EVALSHA":
    case "EVAL":
      return "*0\r\n";
    case "BZPOPMIN":
    case "BRPOPLPUSH":
    case "BLMOVE":
      return null;
    default:
      return "+OK\r\n";
  }
}

/** Mengurai perintah RESP (array bulk string) dari buffer; mengembalikan perintah lengkap dan sisa buffer. */
function parseCommands(buffer: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  for (;;) {
    if (offset >= buffer.length || buffer[offset] !== 0x2a /* * */) break;
    const headerEnd = buffer.indexOf("\r\n", offset);
    if (headerEnd < 0) break;
    const count = Number(buffer.toString("utf8", offset + 1, headerEnd));
    let cursor = headerEnd + 2;
    const parts: string[] = [];
    let complete = true;
    for (let i = 0; i < count; i++) {
      const lenEnd = buffer.indexOf("\r\n", cursor);
      if (lenEnd < 0 || buffer[cursor] !== 0x24 /* $ */) {
        complete = false;
        break;
      }
      const len = Number(buffer.toString("utf8", cursor + 1, lenEnd));
      const start = lenEnd + 2;
      if (start + len + 2 > buffer.length) {
        complete = false;
        break;
      }
      parts.push(buffer.toString("utf8", start, start + len));
      cursor = start + len + 2;
    }
    if (!complete) break;
    commands.push(parts);
    offset = cursor;
  }
  return { commands, rest: buffer.subarray(offset) };
}

export class FakeRedis {
  /** Semua perintah yang diterima (nama perintah huruf besar di indeks 0). */
  readonly received: string[][] = [];
  /** Bila true: perintah diterima tetapi tidak pernah dijawab (Redis menggantung / TCP setengah terbuka). */
  silent = false;
  /** Penjawab yang dapat diganti uji; null = tidak dijawab. */
  reply: (command: string[]) => FakeReply = defaultReply;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private boundPort = 0;

  /** Port tetap: dipesan sekali, dipakai ulang setiap start sehingga klien menyambung ulang ke alamat yang sama. */
  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    return `redis://127.0.0.1:${this.boundPort}/0`;
  }

  /** Memesan port bebas tanpa mendengarkan (Redis "mati" sejak awal). */
  async reservePort(): Promise<number> {
    await this.start();
    await this.stop();
    return this.boundPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.boundPort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.boundPort = (server.address() as { port: number }).port;
    this.server = server;
  }

  /** Mematikan server: berhenti mendengarkan dan memutus semua koneksi (Redis mati). */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  count(name: string): number {
    return this.received.filter((command) => command[0]?.toUpperCase() === name).length;
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let pending = Buffer.alloc(0);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      const { commands, rest } = parseCommands(Buffer.concat([pending, chunk]));
      pending = Buffer.from(rest);
      for (const command of commands) {
        command[0] = (command[0] ?? "").toUpperCase();
        this.received.push(command);
        if (this.silent) continue;
        if (command[0] === "QUIT") {
          socket.end("+OK\r\n");
          continue;
        }
        const answer = this.reply(command);
        if (answer !== null && !socket.destroyed) socket.write(answer);
      }
    });
  }
}
