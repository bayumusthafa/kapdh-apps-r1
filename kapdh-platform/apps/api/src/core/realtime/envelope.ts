import {
  REALTIME_ENVELOPE_VERSION,
  type RealtimeEnvelope,
  type RealtimeEventType,
  type RealtimePayloads,
} from "@kapdh/contracts";
import { v7 as uuidv7 } from "uuid";

/**
 * Amplop event realtime (PRD 5.2, ARCHITECTURE §4.9, packages/contracts/events/envelope.schema.json):
 * `{v, event_id, type, entity_id, ts, payload}`. Event dikirim sesudah commit dengan nama event Socket.IO = `type`,
 * sehingga klien dapat memakai `socket.onAny((type, envelope) => RealtimeEvent.fromJson(envelope))`.
 */
export function buildEnvelope<T extends RealtimeEventType>(
  type: T,
  entityId: string,
  payload: RealtimePayloads[T],
  now: Date,
): RealtimeEnvelope<T> {
  return {
    v: REALTIME_ENVELOPE_VERSION,
    event_id: uuidv7(),
    type,
    entity_id: entityId,
    ts: now.toISOString(),
    payload,
  } as RealtimeEnvelope<T>;
}

/** Kanal (room Socket.IO) per pengguna: semua socket milik akun itu. */
export const userChannel = (userId: string) => `user:${userId}`;
/** Kanal per room chat: socket anggota joined yang effective_status-nya aktif. */
export const roomChannel = (roomId: string) => `room:${roomId}`;
/** Kanal per sesi: socket yang dibuka dengan access token sesi itu (pencabutan satu sesi). */
export const sessionChannel = (sessionId: string) => `session:${sessionId}`;

/** Alasan `session.revoked` (events/session.revoked.schema.json). */
export type SessionRevokedReason =
  | "logout"
  | "logout_all"
  | "session_revoked"
  | "password_changed"
  | "password_reset"
  | "refresh_reuse_detected"
  | "account_suspended"
  | "account_disabled"
  | "deletion_requested"
  | "permissions_changed";
