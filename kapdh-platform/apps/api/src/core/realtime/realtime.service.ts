import { Inject, Injectable } from "@nestjs/common";
import type { RealtimeEventType, RealtimePayloads } from "@kapdh/contracts";
import { roomMembers, rooms } from "@kapdh/database";
import { and, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import type { Clock } from "../adapters/clock.js";
import { afterCommit, currentTx } from "../db/tx.js";
import type { Db } from "../db/types.js";
import { safeError } from "../logging/safe-error.js";
import type { EffectiveStatus } from "../membership/effective-status.js";
import { CLOCK, DB, ROOT_LOGGER } from "../tokens.js";
import {
  buildEnvelope,
  roomChannel,
  sessionChannel,
  type SessionRevokedReason,
  userChannel,
} from "./envelope.js";

/**
 * Jalur kirim realtime. API: namespace Socket.IO milik gateway (lintas replika lewat adapter Redis bila REDIS_URL);
 * worker: emitter Redis ke namespace yang sama; tanpa Redis di worker: tidak ada (event bukan sumber kebenaran,
 * klien memuat ulang lewat HTTP, PRD 5.2).
 */
export interface RealtimeTransport {
  readonly kind: "gateway" | "redis-emitter" | "none";
  emit(channels: string[], event: string, data: unknown, exceptChannels: string[]): void;
  /** Semua socket di `channel` bergabung ke `target`. */
  join(channel: string, target: string): void;
  /** Semua socket di `channel` keluar dari `target`. */
  leave(channel: string, target: string): void;
  /** Memutus semua socket di `channel` (koneksi ditutup setelah paket terkirim). */
  disconnect(channel: string): void;
}

const NO_TRANSPORT: RealtimeTransport = {
  kind: "none",
  emit: () => undefined,
  join: () => undefined,
  leave: () => undefined,
  disconnect: () => undefined,
};

/** Identitas socket yang mengirim event klien (`typing`, `presence.ping`). */
export interface RealtimeClient {
  socketId: string;
  userId: string;
  sessionId: string;
  /** effective_status terbaru (dihitung ulang saat event diterima; sesi juga sudah diperiksa ulang). */
  effectiveStatus: EffectiveStatus;
  /** Kanal yang sedang diikuti socket (mis. `room:<id>`). */
  channels(): ReadonlySet<string>;
  /** Melepas langganan socket ini dari kanal (mis. setelah keanggotaan room dicabut, AC F11-6). */
  leave(channel: string): void;
}

/** Event yang boleh dikirim klien (ARCHITECTURE §4.9); lainnya diabaikan gateway. */
export const CLIENT_EVENTS = ["typing", "presence.ping"] as const;
export type ClientEvent = (typeof CLIENT_EVENTS)[number];
export type ClientEventHandler = (client: RealtimeClient, data: unknown) => void | Promise<void>;

/** Menentukan room chat yang diikuti socket pengguna (hanya dipanggil untuk effective_status aktif). */
export type RoomResolver = (userId: string) => Promise<string[]>;

/** Effective status yang boleh berlangganan room chat (PRD 2.2: chat hanya verified/expiring). */
export const CHAT_ACTIVE_STATUSES: ReadonlySet<EffectiveStatus> = new Set(["verified", "expiring"]);

/**
 * Layanan realtime (ARCHITECTURE §4.2, §4.9): emitToUser, emitToRoom, joinRoom, leaveRoom (revokeRoomSubscription),
 * disconnectUser, disconnectSession. SEMUA metode aman dipanggil di dalam transaksi withTx: pemanggilan di dalam
 * transaksi otomatis ditunda sampai commit (afterCommit) dan dibuang bila rollback, sehingga event tidak pernah
 * mendahului data (PRD 5.2). Di luar transaksi dijalankan segera. Galat transport hanya dicatat (data sudah commit).
 *
 *   await withTx(db, async (tx) => {
 *     ...insert pesan...
 *     realtime.emitToRoom(roomId, "message.created", message.id, { room_id: roomId, message: dto });
 *   });
 */
@Injectable()
export class RealtimeService {
  private transport: RealtimeTransport = NO_TRANSPORT;
  private readonly clientHandlers = new Map<ClientEvent, ClientEventHandler>();
  private roomResolver: RoomResolver;

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DB) private readonly db: Db,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {
    this.roomResolver = (userId) => this.joinedRooms(userId);
  }

  /** Dipasang gateway (API) atau worker (emitter Redis). */
  useTransport(transport: RealtimeTransport): void {
    this.transport = transport;
  }

  get transportKind(): RealtimeTransport["kind"] {
    return this.transport.kind;
  }

  emitToUser<T extends RealtimeEventType>(
    userId: string,
    type: T,
    entityId: string,
    payload: RealtimePayloads[T],
  ): void {
    this.emitTo([userChannel(userId)], type, entityId, payload, []);
  }

  emitToUsers<T extends RealtimeEventType>(
    userIds: readonly string[],
    type: T,
    entityId: string,
    payload: RealtimePayloads[T],
  ): void {
    if (userIds.length === 0) return;
    this.emitTo([...new Set(userIds)].map(userChannel), type, entityId, payload, []);
  }

  /** Ke semua socket anggota room; `exceptUserId` dikecualikan (mis. `typing` tidak kembali ke pengirim). */
  emitToRoom<T extends RealtimeEventType>(
    roomId: string,
    type: T,
    entityId: string,
    payload: RealtimePayloads[T],
    options: { exceptUserId?: string } = {},
  ): void {
    this.emitTo(
      [roomChannel(roomId)],
      type,
      entityId,
      payload,
      options.exceptUserId ? [userChannel(options.exceptUserId)] : [],
    );
  }

  /** Semua socket pengguna mulai menerima event room (setelah bergabung/menerima undangan, AC F11-*). */
  joinRoom(userId: string, roomId: string): void {
    this.run("joinRoom", () => this.transport.join(userChannel(userId), roomChannel(roomId)));
  }

  /** Mencabut langganan room seluruh socket pengguna (keluar/dikeluarkan/blokir/expired; AC F11-6). */
  leaveRoom(userId: string, roomId: string): void {
    this.run("leaveRoom", () => this.transport.leave(userChannel(userId), roomChannel(roomId)));
  }

  /** Alias ARCHITECTURE §4.2. */
  revokeRoomSubscription(userId: string, roomId: string): void {
    this.leaveRoom(userId, roomId);
  }

  /**
   * Menyamakan langganan kanal room SEMUA socket pengguna (lintas instance lewat adapter) dengan status efektifnya
   * (kontrak C6 "Pencabutan langganan room" butir 3 dan 5): status aktif (verified/expiring) → bergabung ke setiap room
   * joined; selain itu → keluar dari setiap room joined. Dipanggil saat request ditolak MEMBERSHIP_REQUIRED/
   * ACCOUNT_SUSPENDED (AuthGuard) dan setelah commit yang memulihkan status aktif (persetujuan iuran, unsuspend).
   * Di dalam withTx dijalankan setelah commit; galat hanya dicatat (penyapuan gateway <= 60 detik tetap menjamin).
   */
  syncRoomSubscriptions(userId: string, status: EffectiveStatus | null): void {
    this.runAsync("syncRoomSubscriptions", async () => {
      if (this.transport.kind === "none") return;
      const roomIds = await this.roomResolver(userId);
      const active = status !== null && CHAT_ACTIVE_STATUSES.has(status);
      for (const roomId of roomIds) {
        if (active) this.transport.join(userChannel(userId), roomChannel(roomId));
        else this.transport.leave(userChannel(userId), roomChannel(roomId));
      }
    });
  }

  /**
   * Mengirim `session.revoked` (all_sessions=true) ke semua socket pengguna lalu memutusnya (logout semua, suspend,
   * nonaktif, penghapusan; AC F02-6, F12-4, F16-3).
   */
  disconnectUser(userId: string, reason: SessionRevokedReason): void {
    this.run("disconnectUser", () => {
      const envelope = buildEnvelope(
        "session.revoked",
        userId,
        { reason, all_sessions: true } as RealtimePayloads["session.revoked"],
        this.clock.now(),
      );
      this.transport.emit([userChannel(userId)], "session.revoked", envelope, []);
      this.transport.disconnect(userChannel(userId));
    });
  }

  /**
   * `session.revoked` (all_sessions=false, entity_id = id keluarga sesi = Session.id) ke socket satu keluarga sesi
   * lalu memutusnya (logout, pencabutan satu perangkat, reuse refresh token). Socket yang dibuka sebelum rotasi refresh
   * ikut terjangkau karena kanal berbasis keluarga.
   */
  disconnectSession(familyId: string, reason: SessionRevokedReason): void {
    this.run("disconnectSession", () => {
      const envelope = buildEnvelope(
        "session.revoked",
        familyId,
        { reason, all_sessions: false } as RealtimePayloads["session.revoked"],
        this.clock.now(),
      );
      this.transport.emit([sessionChannel(familyId)], "session.revoked", envelope, []);
      this.transport.disconnect(sessionChannel(familyId));
    });
  }

  /** Modul chat mendaftarkan handler `typing` / `presence.ping` (satu handler per event). */
  registerClientEvent(event: ClientEvent, handler: ClientEventHandler): void {
    if (this.clientHandlers.has(event)) throw new Error(`Handler event klien ${event} sudah terdaftar`);
    this.clientHandlers.set(event, handler);
  }

  clientHandler(event: string): ClientEventHandler | undefined {
    return this.clientHandlers.get(event as ClientEvent);
  }

  /**
   * Mengganti penentu room yang diikuti socket saat terhubung dan saat validasi ulang berkala (bawaan: keanggotaan
   * `joined` pada room yang belum ditutup). Modul chat dapat memperketat aturan.
   */
  setRoomResolver(resolver: RoomResolver): void {
    this.roomResolver = resolver;
  }

  /** Room yang wajib diikuti socket pengguna dengan effective_status tertentu (kosong bila tidak aktif). */
  async roomsFor(userId: string, status: EffectiveStatus | null): Promise<string[]> {
    if (!status || !CHAT_ACTIVE_STATUSES.has(status)) return [];
    return this.roomResolver(userId);
  }

  private async joinedRooms(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(and(eq(roomMembers.userId, userId), eq(roomMembers.status, "joined"), isNull(rooms.closedAt)));
    return rows.map((row) => row.roomId);
  }

  private emitTo<T extends RealtimeEventType>(
    channels: string[],
    type: T,
    entityId: string,
    payload: RealtimePayloads[T],
    except: string[],
  ): void {
    this.run(`emit ${type}`, () => {
      // Amplop dibuat saat dikirim (setelah commit): ts = waktu server sesudah commit (envelope.schema.json).
      const envelope = buildEnvelope(type, entityId, payload, this.clock.now());
      this.transport.emit(channels, type, envelope, except);
    });
  }

  /** Seperti {@link run} untuk aksi async (mis. membaca room joined sebelum mengirim operasi adapter). */
  private runAsync(label: string, action: () => Promise<void>): void {
    const execute = async () => {
      try {
        await action();
      } catch (error) {
        this.logger.warn(
          { error: safeError(error), action: label },
          "pengiriman realtime gagal (data tetap tersimpan)",
        );
      }
    };
    if (currentTx()) afterCommit(execute);
    else void execute();
  }

  /** Di dalam withTx: tunda sampai commit; di luar: segera. Galat transport tidak menggagalkan pemanggil. */
  private run(label: string, action: () => void): void {
    const execute = () => {
      try {
        action();
      } catch (error) {
        this.logger.warn(
          { error: safeError(error), action: label },
          "pengiriman realtime gagal (data tetap tersimpan)",
        );
      }
    };
    if (currentTx()) afterCommit(execute);
    else execute();
  }
}
