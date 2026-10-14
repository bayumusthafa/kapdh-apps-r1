# Runbook: monitoring, alert dan laporan ketersediaan KAPDH

Pemilik: pengelola infra (PRD 5.5, D9). Rujukan: PRD 2.4 N-01..N-06 dan N-14, 5.3, 5.4, 5.5, 8.3 langkah 6, 9.1 U-11,
10.1 D8/D9; ARCHITECTURE §4.8, §10. Perkakas: `kapdh-platform/infra/monitoring/`, `infra/backup/` (heartbeat backup).

> **Status bukti.** Probe realtime dan pemeriksaan HTTP restore diuji terhadap API uji yang benar-benar mendengar
> (`apps/api/test/ops`); SQL pemeriksa diuji di PostgreSQL 17 dengan role `kapdh_monitor`. Uptime Kuma, GlitchTip dan
> kanal alert belum dipasang; monitor di bawah adalah konfigurasi yang harus dibuat dan diuji di staging lalu production
> (U-11). Error tracking ke GlitchTip BELUM terpasang di kode aplikasi (bagian 5).

## 1. Prinsip

- **Monitor eksternal** (N-05): Uptime Kuma berjalan di luar VPS production (VPS kecil terpisah atau penyedia lain),
  sehingga VPS mati tetap terdeteksi. Uptime Kuma sendiri diawasi satu monitor gratis pihak ketiga (mis. ping HTTP ke
  halaman status Kuma) agar kematian monitor tidak senyap.
- **Dua jenis monitor**: (a) aktif dari Kuma ke endpoint publik; (b) **Push** dari skrip di VPS (cron/systemd) untuk hal
  yang tidak boleh dibuka ke publik (disk, worker, database, backup). Monitor Push memicu alert bila heartbeat tidak
  datang dalam interval, jadi skrip/cron yang mati juga terdeteksi.
- Pesan alert tidak memuat data pribadi, token atau isi (N-14); skrip hanya mengirim angka dan kode isu.
- URL Push Kuma berisi token: simpan di `/etc/kapdh/monitoring.env` (0600) dan `backup.env`, bukan di repo.

## 2. Daftar monitor

Interval/percobaan ulang adalah usulan awal; ubah bila alert terlalu sering atau terlambat dan catat perubahannya.

| # | Nama | Tipe Kuma | Target | Interval / retry | Alert | Tingkat |
| - | ---- | --------- | ------ | ---------------- | ----- | ------- |
| 1 | API liveness | HTTP(s) - Keyword | `https://api.kapdh.or.id/api/v1/health`, kata kunci `"ok"` | 60 s / 2 | down 2x | Kritis |
| 2 | API readiness | HTTP(s) - Json Query | `https://api.kapdh.or.id/api/v1/health/ready`, ekspresi `status` = `ok` (DB, Redis, storage) | 60 s / 2 | down 2x | Kritis |
| 3 | Konfigurasi publik | HTTP(s) - Keyword | `https://api.kapdh.or.id/api/v1/public/config` (dipakai splash aplikasi) | 120 s / 2 | down 2x | Kritis |
| 4 | Web admin | HTTP(s) - Keyword | `https://admin.kapdh.or.id/` (judul halaman) | 120 s / 2 | down 2x | Tinggi |
| 5 | Situs publik | HTTP(s) - Keyword | `https://kapdh.or.id/` dan `https://kapdh.or.id/delete-account` | 300 s / 2 | down 2x | Tinggi |
| 6 | Realtime WS | Push dari `realtime-probe.mjs` (cron 2 menit) | `wss://api.kapdh.or.id/socket.io/?EIO=4&transport=websocket` namespace `/realtime` | heartbeat 5 menit | down / tak ada heartbeat | Tinggi |
| 7 | Sertifikat TLS | opsi "Certificate Expiry Notification" pada monitor 1, 4, 5 | | 14 hari sebelum habis | | Tinggi |
| 8 | Worker | Push dari `check-worker.sh` (2 menit) | `GET /healthz` worker (status `ok`, isu `outbox_lagging`, `dispatcher_failing`, `scheduler_failing`, `queue_unreachable`) | heartbeat 5 menit | down / tak ada heartbeat | Kritis |
| 9 | Outbox | Push dari `check-app.sh` (5 menit) | event pending tertua > 300 s atau ada `dead` | heartbeat 10 menit | down | Tinggi |
| 10 | Penyedia email/push | Push dari `check-app.sh` | galat penyedia 1 jam: push > 20, email > 5 (kelas FCM/SMTP, bukan token/alamat pengguna) | heartbeat 10 menit | down | Tinggi |
| 11 | Penghapusan akun | Push dari `check-app.sh` | permintaan `failed`, lewat 7 hari, atau gagal menulis ledger luar VPS (D5-07) | heartbeat 10 menit | down | Tinggi |
| 12 | Antrean bayar | Push dari `check-app.sh` | bukti bayar tertua menunggu > 48 jam (D5: eskalasi 2 hari kerja) | heartbeat 10 menit | down | Sedang |
| 13 | Disk peringatan | Push dari `check-host.sh` (5 menit) | salah satu `/`, `/data/files`, `/var/lib/docker` ≥ 60 % atau berkas > 20 GB (PRD 5.4) | heartbeat 10 menit | down | Sedang |
| 14 | Disk kritis | Push dari `check-host.sh` | ≥ 80 % | heartbeat 10 menit | down | Kritis |
| 15 | Backup harian | Push dari `backup.sh` | sukses harian | heartbeat 26 jam | down / tak ada heartbeat | Kritis |
| 16 | Umur backup | Push dari `check-backup.sh` (setiap jam) | snapshot `kapdh-db`/`kapdh-files` terbaru > 26 jam (RPO N-06) | heartbeat 2 jam | down | Kritis |
| 17 | Integritas backup | Push dari `check-backup.sh` (Minggu) | `restic check --read-data-subset=5%` | heartbeat 8 hari | down | Tinggi |
| 18 | Database | ditutup oleh monitor 2 (readiness `database`) dan 9-12 (database tak terjangkau = semua down) | | | | Kritis |

Staging memakai monitor yang sama ke subdomain staging (D12) dengan kanal alert terpisah bertanda `[STAGING]`;
staging tidak boleh menjalankan uji beban yang mengganggu production (PRD 5.3).

### 2.1 Pemasangan pemeriksa di VPS

1. Salin `infra/monitoring` dan `infra/backup` ke `/opt/kapdh/infra/`.
2. Buat `/etc/kapdh/monitoring.env` dari `infra/monitoring/monitoring.env.example` (0600). Isi sandi `kapdh_monitor`
   (role dibuat `infra/db/roles.sql`, hanya membaca kolom status/waktu) lewat PGPASSFILE atau `PG_EXEC`.
3. Pasang jadwal `infra/backup/cron/kapdh-backup` ke `/etc/cron.d/` (atau unit systemd setara). Node ≥ 22 dibutuhkan
   `realtime-probe.mjs`; tanpa Node di host, jalankan probe di kontainer: `docker run --rm -e REALTIME_URL -e
   KUMA_PUSH_REALTIME <image-api> node - < /opt/kapdh/infra/monitoring/realtime-probe.mjs`.
4. Uji setiap skrip sekali secara manual, pastikan monitor Push di Kuma berubah hijau, lalu uji jalur merah: hentikan
   worker staging → monitor 8 merah; isi `DISK_WARN_PCT=1` sementara → monitor 13 merah; kembalikan.
5. Worker health: publikasikan port 3001 hanya ke `127.0.0.1` host (`WORKER_HEALTH_URL`) atau isi
   `WORKER_CONTAINER` agar diperiksa lewat `docker exec`.

## 3. Rute alert (D9)

| Tingkat | Kanal | Siapa | Waktu tanggap usulan |
| ------- | ----- | ----- | -------------------- |
| Kritis | Telegram grup "KAPDH Infra" + WhatsApp + email | pengelola infra (utama + cadangan), pemberitahuan ke Super Admin | ≤ 15 menit jam kerja, ≤ 1 jam di luar jam kerja |
| Tinggi | Telegram + email | pengelola infra, pengembang | ≤ 1 jam jam kerja |
| Sedang | email + ringkasan harian Telegram | pengelola infra; antrean bayar ke pengurus payments.decide | hari kerja berikut |

- Telegram: notifikasi "Telegram" Kuma (bot token + chat id grup).
- WhatsApp: notifikasi Kuma lewat gateway WhatsApp yang didukung (mis. WAHA/Whapi/Evolution API) atau penyedia SMS
  sebagai pengganti; nomor penerima adalah nomor pengelola infra dan cadangan.
- Email: SMTP **berbeda** dari penyedia email transaksional aplikasi (D10) agar kegagalan penyedia tetap terkirim.
- Nama pemegang peran dan nomor kanal ditetapkan D9 sebelum go-live dan disimpan di password manager/daftar kontak, tidak
  di repo.

## 4. Menangani alert

| Alert | Langkah pertama |
| ----- | --------------- |
| API liveness/readiness | Lihat `checks` di `/health/ready` (database/redis/storage). Coolify: status kontainer, log 15 menit terakhir. Lanjut incident-response.md bagian 5 |
| Worker | `issues` di heartbeat: `queue_unreachable` → Redis; `dispatcher_failing` → DB/lock; `outbox_lagging` → beban/handler macet. Worker keluar sendiri bila Redis tidak siap 30 s, orkestrator memulai ulang |
| Outbox dead | Lihat event `dead` dan `last_error` (web admin notifikasi/pengiriman atau SQL sebagai pemilik). Perbaiki penyebab, lalu jadwalkan ulang hanya event yang aman diulang (handler idempoten) |
| Penyedia email/push | Status penyedia (D10/FCM). Kelas `AUTH_ERROR`/`auth_error` = kredensial: perbarui secret. Pengiriman diulang otomatis dengan backoff; inbox in-app tetap terisi |
| Penghapusan akun | `last_error` permintaan (tanpa PII). `ledger_*:OffsiteLedgerWriteError:*` = bucket ledger luar VPS (kunci, kuota, object lock); job mengulang otomatis setelah diperbaiki. Batas 7 hari F-14 |
| Disk ≥ 60 % | Proyeksi pertumbuhan; rencanakan migrasi S3 (storage-migration.md) atau tambah disk. Bersihkan image Docker lama (`docker image prune`) |
| Disk ≥ 80 % | Segera: hapus log/image lama, perbesar disk; bila `/data/files` penuh, unggahan gagal (`FILE_INVALID`/500) |
| Backup/umur backup | backup-restore.md bagian 6 |
| Antrean bayar | Beri tahu pengurus dengan izin payments.decide (PRD 8.3 langkah 6) |

## 5. Error tracking (GlitchTip, kompatibel Sentry)

PRD 7.1 menetapkan GlitchTip/Uptime Kuma sebagai kandidat observabilitas. Rencana:

- GlitchTip self-host di host monitoring (bukan VPS production) atau GlitchTip hosted; proyek terpisah `kapdh-api`,
  `kapdh-worker`, `kapdh-admin` per lingkungan; retensi event 30 hari (PRD 5.5).
- Env yang dicadangkan: `SENTRY_DSN` (API dan worker), `VITE_SENTRY_DSN` (build web admin), `SENTRY_ENVIRONMENT`
  (`production`/`staging`), `SENTRY_RELEASE` (= tag image).
- Wajib sebelum diaktifkan: scrubber yang sama dengan logger (N-14): tanpa header Authorization/Cookie, body request,
  query string, sandi, OTP, token, isi chat, bukti bayar; hanya `request_id`/`job_id`, kode galat dan frame stack.
- **Belum diimplementasikan di kode**: tidak ada SDK atau pengirim event di API/worker/admin. Sampai terpasang, galat
  tak terduga dideteksi lewat log JSON pino (level `error`/`fatal`) di log kontainer Coolify; tinjau harian selama
  minggu pertama go-live (PRD 8.3 langkah 6): `docker logs --since 24h <kontainer-api> 2>&1 | grep -c '"level":50'`.

## 6. Log

- API dan worker menulis JSON pino ke stdout dengan `request_id`/`job_id` (N-14). Atur rotasi log Docker di Coolify
  (`max-size=50m`, `max-file=5`) atau log driver ke penyimpanan dengan retensi 30 hari tanpa PII (PRD 5.5).
- Akses log dibatasi pemegang akses Coolify/root (D9); ekspor log untuk analisis insiden dicatat di log insiden.

## 7. Ketersediaan bulanan (N-05) dan laporan

- Sasaran usulan: 99,5 % per bulan untuk API publik dan auth (≈ 3 jam 36 menit gangguan per 30 hari), diukur monitor
  eksternal; downtime deployment tetap dihitung. Definisi pengukuran (disahkan D8): **monitor 2 (readiness)** sebagai
  ukuran API dan auth (readiness gagal = API tidak dapat melayani login), dilengkapi monitor 3.
- Setiap awal bulan pengelola infra mengekspor persentase uptime 30 hari monitor 1-6 dari Kuma (halaman status atau
  ekspor CSV), mencatat setiap insiden (mulai, selesai, durasi, penyebab, tautan post-mortem) dan deployment yang
  menimbulkan downtime, lalu menyimpan laporan di paket penerimaan (`docs/qa/availability/<yyyy-mm>.md`, U-11).
- Bila < 99,5 %: tindakan perbaikan dengan pemilik dan tenggat pada laporan.

## 8. Kapasitas

Ambang kapasitas (N-04) berasal dari uji beban bertingkat (docs/runbooks/load-test.md bagian 5,
`infra/loadtest/api-load.mjs --steps`). Pantau dari Coolify/`docker stats`: CPU rata-rata > 70 % selama 15 menit,
RAM > 85 %, laju permintaan produksi > 70 % kapasitas terukur, atau p95 API mendekati batas N-01 adalah pemicu
menambah kapasitas sebelum target gagal.

| Tanggal uji | Image | Kapasitas terukur (kedatangan/detik) | Titik gagal | Ambang naik kapasitas | Laporan |
| ----------- | ----- | ------------------------------------ | ----------- | --------------------- | ------- |
| belum diuji | | | | | docs/qa/load/ |
