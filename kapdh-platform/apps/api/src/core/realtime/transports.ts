import { Emitter } from "@socket.io/redis-emitter";
import type { Namespace } from "socket.io";
import type { RedisClient } from "../adapters/redis.js";
import type { RealtimeTransport } from "./realtime.service.js";

/** Namespace Socket.IO tempat semua event realtime dikirim (ARCHITECTURE §4.9). */
export const REALTIME_NAMESPACE = "/realtime";
/** Prefix kanal Redis adapter/emitter; API (adapter) dan worker (emitter) wajib sama. */
export const REALTIME_REDIS_KEY = "kapdh:socket.io";

/**
 * Transport API: namespace milik gateway. Dengan adapter Redis (REDIS_URL), broadcast, join/leave, dan disconnect
 * menjangkau socket di semua replika API.
 */
export class NamespaceTransport implements RealtimeTransport {
  readonly kind = "gateway" as const;

  constructor(private readonly namespace: Namespace) {}

  emit(channels: string[], event: string, data: unknown, exceptChannels: string[]): void {
    let operator = this.namespace.to(channels);
    if (exceptChannels.length > 0) operator = operator.except(exceptChannels);
    operator.emit(event, data);
  }

  join(channel: string, target: string): void {
    this.namespace.in(channel).socketsJoin(target);
  }

  leave(channel: string, target: string): void {
    this.namespace.in(channel).socketsLeave(target);
  }

  disconnect(channel: string): void {
    this.namespace.in(channel).disconnectSockets(true);
  }
}

/**
 * Transport worker: `@socket.io/redis-emitter` menerbitkan ke adapter Redis yang dipakai gateway API, sehingga job
 * worker (mis. notifikasi pengingat) tetap sampai ke socket yang tersambung ke API.
 */
export class RedisEmitterTransport implements RealtimeTransport {
  readonly kind = "redis-emitter" as const;
  private readonly emitter: ReturnType<Emitter["of"]>;

  constructor(redis: RedisClient) {
    this.emitter = new Emitter(redis, { key: REALTIME_REDIS_KEY }).of(REALTIME_NAMESPACE);
  }

  emit(channels: string[], event: string, data: unknown, exceptChannels: string[]): void {
    let operator = this.emitter.to(channels);
    if (exceptChannels.length > 0) operator = operator.except(exceptChannels);
    operator.emit(event, data);
  }

  join(channel: string, target: string): void {
    this.emitter.in(channel).socketsJoin(target);
  }

  leave(channel: string, target: string): void {
    this.emitter.in(channel).socketsLeave(target);
  }

  disconnect(channel: string): void {
    this.emitter.in(channel).disconnectSockets(true);
  }
}
