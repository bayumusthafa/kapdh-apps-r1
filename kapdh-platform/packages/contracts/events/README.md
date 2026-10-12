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

Emit klien (tidak memakai amplop; tidak ada endpoint HTTP untuk typing/presence, PRD 3.11):

- `typing` dengan data `{ "room_id": "<uuid>" }`. Server memeriksa ulang sesi, effective_status aktif
  (verified/expiring, tidak suspended) dan keanggotaan joined pada setiap emit; bila tidak lagi berizin emit
  diabaikan dan subscription room dicabut (AC F11-4, F11-6). Diteruskan sebagai event `typing` (dibatasi laju).
- `presence.ping` tanpa data, dikirim berkala selama aplikasi aktif dan lebih sering daripada `ttl_seconds` event
  `presence` yang diterima. Presence dan typing hanya sementara (TTL), bukan bukti pesan dibaca.
- Pesan TIDAK dikirim lewat socket: klien memakai `POST /chat/rooms/{roomId}/messages` (ack sesudah commit,
  AC F11-2), lalu menerima `message.created`.

## Sinkron setelah reconnect (AC F11-3, N-02)

Event hanya sampai ke socket yang sedang tersambung dan event dari transaksi berbeda dapat tiba tidak berurutan.
Aturan klien dan server berikut mencegah pesan atau penghapusan hilang:

1. Server: setiap insert pesan (termasuk pesan sistem) mengunci baris room lebih dulu, mengisi `created_at` =
   `greatest(clock_timestamp(), rooms.last_message_at + 1 mikrodetik)` dan memperbarui `rooms.last_message_at` dalam
   transaksi yang sama. Urutan commit per room sama dengan urutan keyset `(created_at, id)`.
2. Klien menyimpan jangkar sinkron per room = ID pesan terbaru dari respons HTTP
   `GET /chat/rooms/{roomId}/messages` (halaman HTTP selalu tanpa celah). `message.created` tidak memajukan jangkar.
3. Setelah reconnect klien memanggil `GET /chat/rooms/{roomId}/messages?after=<jangkar>` sampai `next_cursor` null,
   menggabungkan berdasarkan `id` (pesan yang sudah diterima lewat event tidak terduplikasi), lalu memajukan jangkar.
4. Penghapusan (`message.deleted`) dan reaksi (`reaction.updated`) pada pesan lama tidak ikut sinkron `after`.
   Setelah reconnect dan setiap kali room dibuka, klien memuat ulang jendela pesan yang ditampilkan (halaman terbaru;
   halaman lama lewat `before` saat digulir) dan mengganti salinan lokal. Salinan lokal hanya tampil sementara sampai
   halaman HTTP tiba, sehingga placeholder penghapusan (termasuk AC F14-3) selalu diterapkan.
5. Metadata room dan keanggotaan dimuat ulang lewat `GET /chat/rooms` dan `GET /chat/rooms/{roomId}` setelah
   reconnect; undangan lewat `GET /chat/invitations`; kotak masuk lewat `GET /notifications`.

## Payload per jenis event (penulis kontrak C6)

Setiap jenis di `properties.type.enum` amplop WAJIB berada di tepat satu keadaan:

| Keadaan       | Cara                                                                   | Tipe terbangkit                                  |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| Bertipe       | berkas `events/<type>.schema.json`                                     | TS dan Dart `<Type>Payload`                      |
| Tanpa payload | jenis tercantum di `x-kapdh-payload-less` amplop (payload selalu `{}`) | TS `Record<string, never>`, Dart tanpa `payload` |
| Pending       | jenis tercantum di `x-kapdh-payload-pending` amplop (lint: peringatan) | TS `Record<string, unknown>`, Dart `Map` mentah  |

Kesepuluh jenis sudah bertipe (penulis kontrak C6). Ringkasan payload, `entity_id` dan kanal pengiriman:

| Jenis                  | `entity_id`   | Kanal                                      | Payload (ringkas)                                                         |
| ---------------------- | ------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `message.created`      | ID pesan      | `room:<id>`                                | `room_id`, `message` (`RealtimeChatMessage`, bentuk = `ChatMessage` HTTP) |
| `message.deleted`      | ID pesan      | `room:<id>`                                | `room_id`, `message_id`, `deleted_at`                                     |
| `reaction.updated`     | ID pesan      | `room:<id>`                                | `room_id`, `message_id`, `user_id`, `emoji`, `action`, `counts`           |
| `read.updated`         | ID room       | `room:<id>`                                | `room_id`, `user_id`, `last_read_message_id`, `last_read_at`              |
| `room.updated`         | ID room       | `room:<id>`; `user:<id>` untuk mute/blokir | `room_id`, `version`, `changes`, `name`, `avatar_url`, `closed_at`        |
| `room.member_changed`  | ID room       | lihat catatan kanal di bawah               | `room_id`, `user_id`, `change`, `role`, `member_count`, `actor_user_id`   |
| `typing`               | ID room       | `room:<id>` (kecuali pengirim)             | `room_id`, `user_id`, `ttl_seconds`                                       |
| `presence`             | user_id       | anggota room yang sama                     | `user_id`, `status`, `ttl_seconds`                                        |
| `notification.created` | ID notifikasi | `user:<id>`                                | field `InboxNotification` (tanpa `read_at`) + `unread_count`              |
| `session.revoked`      | ID sesi       | socket sesi yang dicabut                   | `reason`, `all_sessions`                                                  |

Kanal `room.member_changed` (undangan tertunda hanya terlihat admin grup, PRD 3.11, N-09):

- `joined`, `left`, `removed`, `role_changed`: `room:<room_id>` dan `user:<user_id>` pengguna yang terdampak.
- `invited`, `invitation_cancelled`, `declined`: HANYA `user:<user_id>` calon anggota dan `user:<id>` setiap admin grup
  yang joined; tidak pernah `room:<room_id>`. Pembatalan karena blokir, grup ditutup, atau penghapusan akun memakai
  `actor_user_id` null agar blokir tidak terungkap.

Skema bersama: `realtime-chat-message`, `realtime-chat-user`, `realtime-chat-image`, `realtime-chat-reply`,
`realtime-chat-reaction` (bentuk JSON sama dengan `ChatMessage`, `ChatUserRef`, `ChatImage`, `ChatMessageReply`,
`ChatReaction` di `openapi/domains/chat.yaml`; ubah keduanya bersamaan) dan `realtime-reaction-count`.

Fixture generator (`scripts/lib/dart/fixture.mjs`) tetap memaksa `session.revoked` tanpa payload dan `typing`
pending agar kedua keadaan itu terus teruji walaupun kontrak nyata sudah bertipe semua.

Untuk menambah atau mengubah payload:

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
