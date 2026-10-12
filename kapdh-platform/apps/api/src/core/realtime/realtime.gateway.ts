import { Inject, type OnModuleDestroy } from "@nestjs/common";
import type { RealtimePayloads } from "@kapdh/contracts";
import { type OnGatewayConnection, type OnGatewayInit, WebSocketGateway } from "@nestjs/websockets";
import type { Logger } from "pino";
import type { Namespace, Socket } from "socket.io";
import type { Clock } from "../adapters/clock.js";
import { SessionValidator } from "../guards/session-validator.js";
import { safeError } from "../logging/safe-error.js";
import type { EffectiveStatus } from "../membership/effective-status.js";
import { MembershipKernel } from "../membership/membership.kernel.js";
import { CLOCK, ROOT_LOGGER } from "../tokens.js";
import { buildEnvelope, roomChannel, sessionChannel, type SessionRevokedReason, userChannel } from "./envelope.js";
import { CLIENT_EVENTS, type ClientEvent, type RealtimeClient, RealtimeService } from "./realtime.service.js";
import { NamespaceTransport, REALTIME_NAMESPACE } from "./transports.js";

/** Validasi ulang berkala sesi + effective_status socket yang tersambung (ARCHITECTURE §4.9). */
export const REALTIME_REVALIDATE_MS = 60_000;
/** Batas event klien per socket: 20 per 10 detik; kelebihan diabaikan. */
const CLIENT_EVENT_LIMIT = 20;
const CLIENT_EVENT_WINDOW_MS = 10_000;

/** Identitas yang disimpan di `socket.data` setelah handshake. */
export interface SocketIdentity {
  userId: string;
  sessionId: string;
  sessionVersion: number;
  effectiveStatus: EffectiveStatus;
  eventWindowStart: number;
  eventCount: number;
}

class HandshakeError extends Error {
  readonly data: { code: string; message: string };
  constructor(code: "UNAUTHENTICATED" | "FORBIDDEN", message: string) {
    super(code);
    this.data = { code, message };
  }
}

/**
 * Gateway Socket.IO namespace `/realtime` (ARCHITECTURE §4.9, PRD 5.2). Handshake `auth: {token: <access JWT>}`
 * divalidasi seperti AuthGuard (SessionValidator: token, sesi belum dicabut, session_version, akun aktif) dan hanya
 * untuk sesi aplikasi anggota (audience mobile). Socket bergabung ke `user:<id>`, `session:<id>`, dan `room:<id>`
 * untuk room yang di-join bila effective_status aktif (verified/expiring, PRD 2.2). Setiap 60 detik sesi dan
 * effective_status divalidasi ulang: sesi tidak sah → `session.revoked` lalu putus; tidak aktif lagi → langganan
 * room dicabut (AC F02-6, F11-6, F16-3). Event klien (`typing`, `presence.ping`) diteruskan ke handler yang didaftarkan
 * modul chat setelah sesi diperiksa ulang.
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway implements OnGatewayInit<Namespace>, OnGatewayConnection<Socket>, OnModuleDestroy {
  private namespace: Namespace | null = null;
  private timer: NodeJS.Timeout | null = null;
  private revalidating: Promise<void> | null = null;

  constructor(
    private readonly realtime: RealtimeService,
    private readonly sessions: SessionValidator,
    private readonly membership: MembershipKernel,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  afterInit(namespace: Namespace): void {
    this.namespace = namespace;
    namespace.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (error: unknown) => {
          if (error instanceof HandshakeError) return next(error);
          this.logger.error({ error: safeError(error) }, "handshake realtime gagal");
          next(new HandshakeError("UNAUTHENTICATED", "Tidak dapat memverifikasi sesi. Coba lagi."));
        },
      );
    });
    this.realtime.useTransport(new NamespaceTransport(namespace));
    this.timer = setInterval(() => void this.revalidateAll(), REALTIME_REVALIDATE_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async handleConnection(socket: Socket): Promise<void> {
    const identity = socket.data as SocketIdentity | undefined;
    if (!identity?.userId) {
      socket.disconnect(true);
      return;
    }
    await socket.join([userChannel(identity.userId), sessionChannel(identity.sessionId)]);
    await this.syncRooms(socket, identity.effectiveStatus);
    for (const event of CLIENT_EVENTS) socket.on(event, (data: unknown) => void this.onClientEvent(socket, event, data));
  }

  /**
   * Validasi ulang semua socket lokal (dipanggil timer; uji memanggil langsung). Pemanggilan bersamaan digabung.
   */
  revalidateAll(): Promise<void> {
    if (!this.revalidating)
      this.revalidating = this.doRevalidate()
        .catch((error: unknown) => {
          this.logger.warn({ error: safeError(error) }, "validasi ulang socket realtime gagal");
        })
        .finally(() => {
          this.revalidating = null;
        });
    return this.revalidating;
  }

  private async authenticate(socket: Socket): Promise<void> {
    const raw = (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
    const token = typeof raw === "string" ? raw.trim() : "";
    const validated = token ? await this.sessions.authenticate(token) : null;
    if (!validated) throw new HandshakeError("UNAUTHENTICATED", "Sesi berakhir. Silakan masuk kembali.");
    if (validated.claims.audience !== "mobile")
      throw new HandshakeError("FORBIDDEN", "Koneksi realtime hanya untuk aplikasi anggota.");
    const snapshot = await this.membership.effectiveStatusFor(validated.claims.userId);
    const identity: SocketIdentity = {
      userId: validated.claims.userId,
      sessionId: validated.claims.sessionId,
      sessionVersion: validated.claims.sessionVersion,
      effectiveStatus: snapshot?.status ?? "unverified",
      eventWindowStart: 0,
      eventCount: 0,
    };
    socket.data = identity;
  }

  private async doRevalidate(): Promise<void> {
    const namespace = this.namespace;
    if (!namespace) return;
    const sockets = [...namespace.sockets.values()].filter((s) => (s.data as SocketIdentity | undefined)?.userId);
    if (sockets.length === 0) return;
    const identities = sockets.map((s) => s.data as SocketIdentity);
    const verdicts = await this.sessions.revalidate(
      identities.map((i) => ({
        sessionId: i.sessionId,
        userId: i.userId,
        sessionVersion: i.sessionVersion,
        audience: "mobile" as const,
      })),
    );
    const alive = sockets.filter((socket) => {
      const identity = socket.data as SocketIdentity;
      const reason = verdicts.get(identity.sessionId);
      if (reason) this.revokeSocket(socket, reason);
      return !reason;
    });
    const statuses = await this.membership.effectiveStatusesFor(alive.map((s) => (s.data as SocketIdentity).userId));
    const roomsCache = new Map<string, Promise<string[]>>();
    for (const socket of alive) {
      const identity = socket.data as SocketIdentity;
      identity.effectiveStatus = statuses.get(identity.userId)?.status ?? "unverified";
      await this.syncRooms(socket, identity.effectiveStatus, roomsCache);
    }
  }

  /** Menyamakan langganan `room:*` socket dengan room yang berhak diikuti saat ini. */
  private async syncRooms(
    socket: Socket,
    status: EffectiveStatus,
    cache?: Map<string, Promise<string[]>>,
  ): Promise<void> {
    const identity = socket.data as SocketIdentity;
    let pending = cache?.get(identity.userId);
    if (!pending) {
      pending = this.realtime.roomsFor(identity.userId, status);
      cache?.set(identity.userId, pending);
    }
    const desired = new Set((await pending).map(roomChannel));
    for (const channel of socket.rooms) if (channel.startsWith("room:") && !desired.has(channel)) socket.leave(channel);
    const missing = [...desired].filter((channel) => !socket.rooms.has(channel));
    if (missing.length > 0) await socket.join(missing);
  }

  private revokeSocket(socket: Socket, reason: SessionRevokedReason): void {
    const identity = socket.data as SocketIdentity;
    const envelope = buildEnvelope(
      "session.revoked",
      identity.sessionId,
      { reason, all_sessions: reason !== "session_revoked" } as RealtimePayloads["session.revoked"],
      this.clock.now(),
    );
    socket.emit("session.revoked", envelope);
    socket.disconnect(true);
  }

  private async onClientEvent(socket: Socket, event: ClientEvent, data: unknown): Promise<void> {
    const identity = socket.data as SocketIdentity;
    const handler = this.realtime.clientHandler(event);
    if (!handler) return;
    const now = this.clock.now().getTime();
    if (now - identity.eventWindowStart > CLIENT_EVENT_WINDOW_MS) {
      identity.eventWindowStart = now;
      identity.eventCount = 0;
    }
    if (++identity.eventCount > CLIENT_EVENT_LIMIT) return;
    try {
      // Sesi diperiksa ulang pada setiap event klien (C6: typing/presence tidak boleh melewati pencabutan).
      const [verdict] = [
        ...(
          await this.sessions.revalidate([
            {
              sessionId: identity.sessionId,
              userId: identity.userId,
              sessionVersion: identity.sessionVersion,
              audience: "mobile",
            },
          ])
        ).values(),
      ];
      if (verdict) {
        this.revokeSocket(socket, verdict);
        return;
      }
      const snapshot = await this.membership.effectiveStatusFor(identity.userId);
      identity.effectiveStatus = snapshot?.status ?? "unverified";
      const client: RealtimeClient = {
        socketId: socket.id,
        userId: identity.userId,
        sessionId: identity.sessionId,
        effectiveStatus: identity.effectiveStatus,
        channels: () => socket.rooms,
        leave: (channel) => void socket.leave(channel),
      };
      await handler(client, data);
    } catch (error) {
      this.logger.warn({ error: safeError(error), event }, "event klien realtime gagal diproses");
    }
  }
}
