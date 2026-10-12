import type { INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { IncomingMessage } from "node:http";
import type { Server, ServerOptions } from "socket.io";
import type { RedisClient } from "../adapters/redis.js";
import { REALTIME_REDIS_KEY } from "./transports.js";

/** Batas ukuran paket dari klien: klien hanya mengirim `typing {room_id}` dan `presence.ping` (ARCHITECTURE §4.9). */
const MAX_CLIENT_PACKET_BYTES = 16 * 1024;

export interface KapdhIoAdapterOptions {
  /** Origin browser yang boleh membuka koneksi (web admin dan situs publik). Klien tanpa Origin (aplikasi) diterima. */
  allowedOrigins: string[];
  /** Adapter Redis (lintas replika API) bila REDIS_URL diisi; null = adapter memori (satu proses). */
  redis: RedisClient | null;
}

/**
 * Adapter Socket.IO untuk Fastify (ARCHITECTURE §4.9): hanya transport websocket, tanpa melayani berkas klien, paket
 * kecil, pemeriksaan Origin browser, dan adapter Redis saat REDIS_URL diisi sehingga emit/join/disconnect menjangkau
 * semua replika. Saat aplikasi ditutup, socket dan engine ditutup tanpa menutup server HTTP (milik Fastify), lalu
 * koneksi Redis pub/sub dilepas.
 */
export class KapdhIoAdapter extends IoAdapter {
  private readonly redisClients: RedisClient[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly options: KapdhIoAdapterOptions,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const allowed = new Set(this.options.allowedOrigins);
    const server = super.createIOServer(port, {
      ...options,
      transports: ["websocket"],
      serveClient: false,
      maxHttpBufferSize: MAX_CLIENT_PACKET_BYTES,
      connectTimeout: 10_000,
      pingInterval: 25_000,
      pingTimeout: 20_000,
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null | undefined, ok: boolean) => void,
      ) => {
        const origin = request.headers.origin;
        callback(null, origin === undefined || allowed.has(origin));
      },
    }) as Server;
    if (this.options.redis) {
      const pub = this.options.redis.duplicate();
      const sub = this.options.redis.duplicate();
      this.redisClients.push(pub, sub);
      server.adapter(createAdapter(pub, sub, { key: REALTIME_REDIS_KEY }));
    }
    return server;
  }

  /** Menutup socket semua namespace dan engine; server HTTP ditutup Fastify sesudahnya. */
  override async close(server: Server): Promise<void> {
    const namespaces = (
      server as unknown as {
        _nsps?: Map<string, { disconnectSockets(close: boolean): void; adapter: { close?(): unknown } }>;
      }
    )._nsps;
    if (!namespaces) return;
    for (const namespace of namespaces.values()) {
      namespace.disconnectSockets(true);
      await namespace.adapter.close?.();
    }
    server.engine?.close();
  }

  override async dispose(): Promise<void> {
    await Promise.all(this.redisClients.map((client) => client.quit().catch(() => undefined)));
    this.redisClients.length = 0;
  }
}
