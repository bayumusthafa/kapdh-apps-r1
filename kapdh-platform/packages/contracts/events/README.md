# Skema event realtime

Event server ke klien di namespace Socket.IO `/realtime` (PRD 5.2, ARCHITECTURE §4.9). Skema ditulis sebagai
JSON Schema 2020-12 dan divalidasi oleh `pnpm contracts:lint` (`scripts/validate-events.mjs`): setiap berkas
`*.schema.json` wajib memiliki `$schema` 2020-12, `$id` unik, `title` PascalCase, minimal satu contoh di `examples`,
dan dikompilasi Ajv mode strict; setiap contoh wajib lolos skemanya.

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
  yang belum dikenal (SDK Dart: `RealtimeEventType.unknown`).
- `entity_id`: entitas utama (pesan, room, notifikasi, pengguna, atau sesi).
- `ts`: waktu server setelah commit. Event bukan sumber kebenaran tunggal; klien memuat ulang lewat HTTP bila ragu.
- `payload`: payload minimum. Notifikasi layar kunci tidak memuat isi chat, bukti bayar atau kontak.

Klien hanya mengirim `typing {room_id}` dan `presence.ping`. Autentikasi handshake `{token: <access JWT>}`;
pencabutan sesi/izin memutus atau melepas langganan (AC F02-6, F11-6, F16-3).

Tipe yang dibangkitkan: TypeScript `RealtimeEnvelope`/`REALTIME_EVENT_TYPES` (`@kapdh/contracts`) dan Dart
`RealtimeEnvelope`/`RealtimeEventType` (`kapdh_api`).

## Menambah payload per jenis event (penulis kontrak C6)

Tambahkan `events/<type>.schema.json` (mis. `message.created.schema.json`, title `MessageCreatedPayload`) dengan
`$id` di bawah `https://kapdh.or.id/contracts/events/`, properti snake_case, `additionalProperties: false`, dan
contoh. Skema lain dapat dirujuk lewat `$id`. Jalankan `pnpm contracts:lint`.
