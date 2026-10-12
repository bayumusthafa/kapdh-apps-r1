// Pembangkit event realtime bertipe untuk SDK Dart (PRD 5.2, ARCHITECTURE §4.9): sealed class RealtimeEvent dengan
// satu subkelas per jenis event; payload didekode ke model `<Type>Payload` dari events/<type>.schema.json.
import { DART_TYPE_RESERVED, enumMemberName, pascalCase } from "../names.mjs";
import { ENVELOPE_TITLE, payloadKinds } from "../events.mjs";
import { GENERATED_HEADER } from "./runtime.mjs";

/** Nama kelas event Dart: `room.member_changed` -> `RoomMemberChangedEvent`. */
export function eventClassName(type) {
  return `${pascalCase(type)}Event`;
}

const UNKNOWN_EVENT = "UnknownRealtimeEvent";

/**
 * @param {import("./model.mjs").ModelRegistry} registry registri yang sudah memuat skema event.
 * @param {ReturnType<typeof import("../events.mjs").analyzeEvents>} analysis
 * @returns {string | undefined} isi realtime_events.dart (undefined bila ada galat; lihat registry.errors).
 */
export function renderRealtimeEvents(registry, analysis) {
  const envelope = registry.types.get(ENVELOPE_TITLE);
  if (envelope?.kind !== "class") {
    registry.error(`model ${ENVELOPE_TITLE} (events/envelope.schema.json) tidak terbentuk`);
    return undefined;
  }
  const typeField = envelope.fields.find((f) => f.jsonName === "type");
  const enumName = typeField?.type.t === "enum" ? typeField.type.name : undefined;
  const enumDef = enumName ? registry.types.get(enumName) : undefined;
  if (enumDef?.kind !== "enum") {
    registry.error(`${ENVELOPE_TITLE}.type wajib enum inline bertitle (RealtimeEventType)`);
    return undefined;
  }
  const kinds = payloadKinds(analysis);
  const classNames = new Set([UNKNOWN_EVENT]);
  for (const { type, kind, title } of kinds) {
    const cls = eventClassName(type);
    if (registry.types.has(cls) || DART_TYPE_RESERVED.has(cls) || classNames.has(cls))
      registry.error(`jenis event '${type}': nama kelas Dart ${cls} bentrok dengan tipe lain`);
    classNames.add(cls);
    if (kind === "schema" && registry.types.get(title)?.kind !== "class")
      registry.error(`payload jenis event '${type}' (${title}) wajib objek`);
  }
  if (registry.errors.length) return undefined;

  const cases = kinds.map(({ type, kind, title }) => {
    const member = `${enumName}.${enumMemberName(type)}`;
    const cls = eventClassName(type);
    return kind === "schema"
      ? `      ${member} => ${cls}(envelope, ${title}.fromJson(envelope.payload)),`
      : `      ${member} => ${cls}(envelope),`;
  });

  const subclasses = kinds.map(({ type, kind, title }) => {
    const cls = eventClassName(type);
    if (kind === "schema") {
      return `/// Event \`${type}\`; payload dari events/${type}.schema.json.
final class ${cls} extends RealtimeEvent {
  const ${cls}(super.envelope, this.payload);

  /// Payload bertipe.
  final ${title} payload;

  @override
  String toString() => '${cls}(eventId: $eventId, entityId: $entityId, payload: $payload)';
}`;
    }
    if (kind === "none") {
      return `/// Event \`${type}\` tanpa payload (x-kapdh-payload-less).
final class ${cls} extends RealtimeEvent {
  const ${cls}(super.envelope);

  @override
  String toString() => '${cls}(eventId: $eventId, entityId: $entityId)';
}`;
    }
    return `/// Event \`${type}\`. Skema payload belum ditulis (x-kapdh-payload-pending, penulis kontrak C6): payload masih
/// objek bebas dan akan menjadi model bertipe saat events/${type}.schema.json ditambahkan.
final class ${cls} extends RealtimeEvent {
  const ${cls}(super.envelope);

  /// Payload mentah.
  Map<String, Object?> get payload => envelope.payload;

  @override
  String toString() => '${cls}(eventId: $eventId, entityId: $entityId)';
}`;
  });

  return `${GENERATED_HEADER}
// Event realtime bertipe dari events/*.schema.json (PRD 5.2, ARCHITECTURE §4.9).

import 'package:meta/meta.dart';

import 'models.dart';

/// Event server ke klien di namespace Socket.IO \`/realtime\` dengan payload bertipe sesuai jenisnya.
/// Event dikirim sesudah commit tetapi bukan sumber kebenaran tunggal: muat ulang lewat HTTP bila ragu (PRD 5.2).
/// Pakai \`switch (event) { case MessageCreatedEvent(:final payload): ... }\`; [${UNKNOWN_EVENT}] diabaikan.
@immutable
sealed class RealtimeEvent {
  const RealtimeEvent(this.envelope);

  /// Mendekode event dari data Socket.IO. Jenis yang belum dikenal versi SDK ini menjadi [${UNKNOWN_EVENT}]
  /// (kompatibilitas maju, N-13). Amplop atau payload yang menyimpang dari kontrak melempar [FormatException].
  factory RealtimeEvent.fromJson(Map<String, Object?> json) {
    final envelope = ${ENVELOPE_TITLE}.fromJson(json);
    return switch (envelope.type) {
${cases.join("\n")}
      ${enumName}.unknown => ${UNKNOWN_EVENT}(envelope),
    };
  }

  /// Amplop mentah (v, event_id, type, entity_id, ts, payload).
  final ${ENVELOPE_TITLE} envelope;

  /// ID event (UUID v7) untuk deduplikasi setelah reconnect (N-02).
  String get eventId => envelope.eventId;

  /// Jenis event.
  ${enumName} get type => envelope.type;

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

${subclasses.join("\n\n")}

/// Jenis event yang belum dikenal versi SDK ini; klien mengabaikannya (kompatibilitas maju).
final class ${UNKNOWN_EVENT} extends RealtimeEvent {
  const ${UNKNOWN_EVENT}(super.envelope);

  @override
  String toString() => '${UNKNOWN_EVENT}(eventId: $eventId, entityId: $entityId)';
}
`;
}
