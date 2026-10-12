# Skema event realtime

Event server ke klien di namespace Socket.IO `/realtime` (PRD 5.2, ARCHITECTURE §4.9). Skema ditulis sebagai
JSON Schema 2020-12 dan divalidasi oleh `pnpm contracts:lint` (`scripts/validate-events.mjs`, aturan di
`scripts/lib/events.mjs`): setiap berkas `*.schema.json` wajib memiliki `$schema` 2020-12, `$id` URI unik, `title`
PascalCase unik (tidak bentrok dengan `components.schemas` kontrak HTTP), minimal satu contoh di `examples`, dan
dikompilasi Ajv mode strict; setiap contoh wajib lolos skemanya.

## Amplop (`envelope.schema.json`)

```json
{
  "v": 1,
  "event_id": "<uuid v7>",
  "type": "message.created",
  "entity_id": "<uuid>",
  "ts": "<RFC 3339 UTC>",
  "payload": {}
}
```

- `v`: versi amplop; perubahan yang memutus klien lama menaikkan versi (N-13).
- `event_id`: unik per event; klien mendeduplikasi setelah reconnect (N-02).
- `type`: `message.created`, `message.deleted`, `reaction.updated`, `read.updated`, `room.updated`,
  `room.member_changed`, `typing`, `presence`, `notification.created`, `session.revoked`. Klien mengabaikan jenis
  yang belum dikenal (SDK Dart: `UnknownRealtimeEvent`).
- `entity_id`: entitas utama (pesan, room, notifikasi, pengguna, atau sesi).
- `ts`: waktu server setelah commit. Event bukan sumber kebenaran tunggal; klien memuat ulang lewat HTTP bila ragu.
- `payload`: payload minimum. Notifikasi layar kunci tidak memuat isi chat, bukti bayar atau kontak. Payload tidak
  dicetak `toString()` SDK (`x-sensitive`).

Klien hanya mengirim `typing {room_id}` dan `presence.ping`. Autentikasi handshake `{token: <access JWT>}`;
pencabutan sesi/izin memutus atau melepas langganan (AC F02-6, F11-6, F16-3).

## Payload per jenis event (penulis kontrak C6)

Setiap jenis di `properties.type.enum` amplop WAJIB berada di tepat satu keadaan:

| Keadaan       | Cara                                                                   | Tipe terbangkit                                  |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| Bertipe       | berkas `events/<type>.schema.json`                                     | TS dan Dart `<Type>Payload`                      |
| Tanpa payload | jenis tercantum di `x-kapdh-payload-less` amplop (payload selalu `{}`) | TS `Record<string, never>`, Dart tanpa `payload` |
| Pending       | jenis tercantum di `x-kapdh-payload-pending` amplop (lint: peringatan) | TS `Record<string, unknown>`, Dart `Map` mentah  |

Saat ini kesepuluh jenis masih pending. Untuk menulis payload:

1. Tambahkan `events/<type>.schema.json`, mis. `message.created.schema.json`, dengan `$id`
   `https://kapdh.or.id/contracts/events/<type>.schema.json`, `title` `<Type>Payload` (`MessageCreatedPayload`,
   `RoomMemberChangedPayload`), `type: object`, `additionalProperties: false`, properti snake_case, dan contoh.
2. Hapus jenis itu dari `x-kapdh-payload-pending` (atau pindahkan ke `x-kapdh-payload-less` bila payload memang
   selalu `{}`).
3. Skema bersama (mis. pesan chat) ditaruh di berkas sendiri `events/<nama>.schema.json` (title PascalCase tanpa
   akhiran `Payload`) dan dirujuk utuh lewat `$id`, relatif (`"$ref": "chat-message.schema.json"`) atau absolut;
   rujukan diri memakai `"$ref": "#"`. Rujukan fragmen (`#/$defs/...`, `x.schema.json#/properties/...`) dan `$defs`
   tidak didukung generator.
4. Nullable mengikuti konvensi kontrak HTTP (`type: [X, "null"]`; enum inline nullable memuat `null` di `enum`).
5. Pastikan contoh amplop di `envelope.schema.json` untuk jenis itu lolos skema payload-nya, lalu jalankan
   `pnpm contracts:lint`, `pnpm contracts:gen`, dan `pnpm contracts:test-dart`.

Tipe yang dibangkitkan: TypeScript `RealtimeEnvelope<T>`, `RealtimePayloads`, `RealtimeEvent` (union terdiskriminasi
`type`), `REALTIME_EVENT_TYPES` (`@kapdh/contracts`) dan Dart `RealtimeEvent.fromJson` (sealed class; satu subkelas
`<Type>Event` per jenis dengan `payload` bertipe, `UnknownRealtimeEvent` untuk jenis baru) di `kapdh_api`.
