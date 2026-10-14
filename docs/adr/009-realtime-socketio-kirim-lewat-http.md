# ADR-009: Realtime lewat Socket.IO `/realtime`; pesan chat dikirim lewat HTTP, socket hanya mengantar

- Status: Diterima (Fase B, diterapkan Fase C)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 3.11, 5.1, 5.2; F-11; AC F02-6, F11-1..F11-6, F12-4, F16-3; N-02; ARCHITECTURE §3.5, §4.9
- Bukti di kode: `kapdh-platform/apps/api/src/core/realtime/{realtime.gateway.ts,io-adapter.ts,transports.ts}`,
  `packages/contracts/events/*.schema.json`, `packages/contracts/openapi/domains/chat.yaml`
  (`POST /chat/rooms/{roomId}/messages`), `kapdh-mobile/lib/core/realtime/`, `kapdh-mobile/lib/features/chat/`

## Konteks

PRD 5.2: event socket dikirim **sesudah commit** dan **bukan sumber kebenaran tunggal**; klien harus pulih setelah
reconnect tanpa kehilangan atau duplikasi (AC F11-3). Pesan wajib idempoten per pengirim (`client_message_id`), dibatasi
4.000 karakter, dan tunduk pada blokir, keanggotaan room, serta status keanggotaan (aktif saja). Pencabutan hak
(logout-all, suspend, kedaluwarsa, keluar grup, izin dicabut) harus segera memutus akses socket.

## Keputusan

1. **Kirim = HTTP.** `POST /chat/rooms/{roomId}/messages` melewati guard, validasi, idempotensi, dan transaksi yang
   sama dengan endpoint lain; respons (ack) diberikan setelah commit. Socket tidak menerima pesan dari klien.
2. **Antar = Socket.IO.** Namespace `/realtime` saja (namespace root `/` menolak semua koneksi), transport websocket,
   autentikasi `{token: <access JWT>}` saat handshake. Gateway memvalidasi sesi per **keluarga sesi** sehingga rotasi
   refresh tidak memutus socket, dan memvalidasi ulang setiap 60 detik (`REALTIME_REVALIDATE_MS`).
3. Room socket: `user:<id>`, `session:<familyId>`, `room:<id>` (hanya anggota aktif). Emit dijadwalkan lewat
   `afterCommit`; envelope `{v: 1, event_id, type, entity_id, ts, payload}` dengan skema per jenis di
   `packages/contracts/events/`.
4. Klien hanya meng-emit `typing {room_id}` dan `presence.ping`.
5. Pencabutan: `RealtimeService.disconnectUser`, `disconnectSession(familyId)`, `revokeRoomSubscription`,
   `syncRoomSubscriptions` dipanggil dari guard (setiap penolakan MEMBERSHIP_REQUIRED/ACCOUNT_SUSPENDED), kernel
   keanggotaan, dan modul chat; timer kedaluwarsa mengeluarkan anggota dari room pada `alumni.expires_at`.
6. Multi-instance: adapter Redis (`@socket.io/redis-adapter`, key `kapdh:socket.io`) aktif bila `REDIS_URL` diisi.
7. Klien memakai keyset `(created_at, id)` untuk sinkron setelah reconnect dan deduplikasi `event_id`.

## Alternatif yang dipertimbangkan

- **Kirim pesan lewat socket (emit dengan ack)**: ditolak; menduplikasi guard, idempotensi, rate limit dan kontrak
  galat di jalur kedua yang tidak tercakup OpenAPI.
- **WebSocket mentah/SSE**: ditolak; Socket.IO memberi reconnect, room, dan adapter Redis yang teruji, dan klien Dart
  `socket_io_client` tersedia.
- **Polling saja**: ditolak; tidak memenuhi N-02 (p95 <= 2 detik).

## Konsekuensi

- Socket boleh hilang tanpa kehilangan data; kebenaran ada di HTTP/DB.
- Traefik harus meneruskan upgrade WebSocket ke API (`wss://api.kapdh.or.id/socket.io/?...`, namespace `/realtime`);
  diverifikasi di staging (temuan audit D2-07).
- Target latensi N-02 belum diukur (temuan audit D2-04); termasuk UAT U-07 dan U-11.
