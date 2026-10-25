// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

// Event realtime bertipe dari events/*.schema.json (PRD 5.2, ARCHITECTURE §4.9).

import 'package:meta/meta.dart';

import 'models.dart';

/// Event server ke klien di namespace Socket.IO `/realtime` dengan payload bertipe sesuai jenisnya.
/// Event dikirim sesudah commit tetapi bukan sumber kebenaran tunggal: muat ulang lewat HTTP bila ragu (PRD 5.2).
/// Pakai `switch (event) { case MessageCreatedEvent(:final payload): ... }`; [UnknownRealtimeEvent] diabaikan.
@immutable
sealed class RealtimeEvent {
  const RealtimeEvent(this.envelope);

  /// Mendekode event dari data Socket.IO. Jenis yang belum dikenal versi SDK ini menjadi [UnknownRealtimeEvent]
  /// (kompatibilitas maju, N-13). Amplop atau payload yang menyimpang dari kontrak melempar [FormatException].
  factory RealtimeEvent.fromJson(Map<String, Object?> json) {
    final envelope = RealtimeEnvelope.fromJson(json);
    return switch (envelope.type) {
      RealtimeEventType.messageCreated => MessageCreatedEvent(envelope, MessageCreatedPayload.fromJson(envelope.payload)),
      RealtimeEventType.messageDeleted => MessageDeletedEvent(envelope, MessageDeletedPayload.fromJson(envelope.payload)),
      RealtimeEventType.reactionUpdated => ReactionUpdatedEvent(envelope, ReactionUpdatedPayload.fromJson(envelope.payload)),
      RealtimeEventType.readUpdated => ReadUpdatedEvent(envelope, ReadUpdatedPayload.fromJson(envelope.payload)),
      RealtimeEventType.roomUpdated => RoomUpdatedEvent(envelope, RoomUpdatedPayload.fromJson(envelope.payload)),
      RealtimeEventType.roomMemberChanged => RoomMemberChangedEvent(envelope, RoomMemberChangedPayload.fromJson(envelope.payload)),
      RealtimeEventType.typing => TypingEvent(envelope, TypingPayload.fromJson(envelope.payload)),
      RealtimeEventType.presence => PresenceEvent(envelope, PresencePayload.fromJson(envelope.payload)),
      RealtimeEventType.notificationCreated => NotificationCreatedEvent(envelope, NotificationCreatedPayload.fromJson(envelope.payload)),
      RealtimeEventType.sessionRevoked => SessionRevokedEvent(envelope, SessionRevokedPayload.fromJson(envelope.payload)),
      RealtimeEventType.unknown => UnknownRealtimeEvent(envelope),
    };
  }

  /// Amplop mentah (v, event_id, type, entity_id, ts, payload).
  final RealtimeEnvelope envelope;

  /// ID event (UUID v7) untuk deduplikasi setelah reconnect (N-02).
  String get eventId => envelope.eventId;

  /// Jenis event.
  RealtimeEventType get type => envelope.type;

  /// ID entitas utama (pesan, room, notifikasi, pengguna, atau sesi).
  String get entityId => envelope.entityId;

  /// Waktu server (UTC).
  DateTime get ts => envelope.ts;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is RealtimeEvent && other.runtimeType == runtimeType && other.envelope == envelope;

  @override
  int get hashCode => Object.hash(runtimeType, envelope);
}

/// Event `message.created`; payload dari events/message.created.schema.json.
final class MessageCreatedEvent extends RealtimeEvent {
  const MessageCreatedEvent(super.envelope, this.payload);

  /// Payload bertipe.
  final MessageCreatedPayload payload;

  @override
  String toString() => 'MessageCreatedEvent(eventId: $eventId, entityId: $entityId, payload: $payload)';
}

/// Event `message.deleted`; payload dari events/message.deleted.schema.json.
final class MessageDeletedEvent extends RealtimeEvent {
  const MessageDeletedEvent(super.envelope, this.payload);

  /// Payload bertipe.
  final MessageDeletedPayload payload;

  @override
  String toString() => 'MessageDeletedEvent(eventId: $eventId, entityId: $entityId, payload: $payload)';
}

/// Event `reaction.updated`; payload dari events/reaction.updated.schema.json.
final class ReactionUpdatedEvent extends RealtimeEvent {
  const ReactionUpdatedEvent(super.envelope, this.payload);

  /// Payload bertipe.
  final ReactionUpdatedPayload payload;

  @override
  String toString() => 'ReactionUpdatedEvent(eventId: $eventId, entityId: $entityId, payload: $payload)';
}

/// Event `read.updated`; payload dari events/read.updated.schema.json.
final class ReadUpdatedEvent extends RealtimeEvent {
  const ReadUpdatedEvent(super.envelope, this.payload);

  /// Payload bertipe.
  final ReadUpdatedPayload payload;

  @override
  String toString() => 'ReadUpdatedEvent(eventId: $eventId, entityId: $entityId, payload: $payload)';
}

/// Event `room.updated`; payload dari events/room.updated.schema.json.
final class RoomUpdatedEvent extends RealtimeEvent {
  const RoomUpdatedEvent(super.envelope, this.payload);

  /// Payload bertipe.
  final RoomUpdatedPayload payload;

  @override
  String toString() => 'RoomUpdatedEvent(eventId: $eventId, entityId: $entityId, payload: $payload)';
}

/// Event `room.member_changed`; payload dari events/room.member_changed.schema.json.
final class RoomMemberChangedEvent extends RealtimeEvent {
  const RoomMemberChangedEvent(super.envelope, this.payload);

  /// Payload bertipe.
  final RoomMemberChangedPayload payload;

  @override
  String toString() => 'RoomMemberChangedEvent(eventId: $eventId, entityId: $entityId, payload: $payload)';
}

/// Event `typing`; payload dari events/typing.schema.json.
final class TypingEvent extends RealtimeEvent {
  const TypingEvent(super.envelope, this.payload);

  /// Payload bertipe.
  final TypingPayload payload;

  @override
  String toString() => 'TypingEvent(eventId: $eventId, entityId: $entityId, payload: $payload)';
}

/// Event `presence`; payload dari events/presence.schema.json.
final class PresenceEvent extends RealtimeEvent {
  const PresenceEvent(super.envelope, this.payload);

  /// Payload bertipe.
  final PresencePayload payload;

  @override
  String toString() => 'PresenceEvent(eventId: $eventId, entityId: $entityId, payload: $payload)';
}

/// Event `notification.created`; payload dari events/notification.created.schema.json.
final class NotificationCreatedEvent extends RealtimeEvent {
  const NotificationCreatedEvent(super.envelope, this.payload);

  /// Payload bertipe.
  final NotificationCreatedPayload payload;

  @override
  String toString() => 'NotificationCreatedEvent(eventId: $eventId, entityId: $entityId, payload: $payload)';
}

/// Event `session.revoked`; payload dari events/session.revoked.schema.json.
final class SessionRevokedEvent extends RealtimeEvent {
  const SessionRevokedEvent(super.envelope, this.payload);

  /// Payload bertipe.
  final SessionRevokedPayload payload;

  @override
  String toString() => 'SessionRevokedEvent(eventId: $eventId, entityId: $entityId, payload: $payload)';
}

/// Jenis event yang belum dikenal versi SDK ini; klien mengabaikannya (kompatibilitas maju).
final class UnknownRealtimeEvent extends RealtimeEvent {
  const UnknownRealtimeEvent(super.envelope);

  @override
  String toString() => 'UnknownRealtimeEvent(eventId: $eventId, entityId: $entityId)';
}
