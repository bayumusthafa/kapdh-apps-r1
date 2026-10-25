# Runbook: Inisialisasi lingkungan production (PRD 8.2)

Rujukan: PRD 5.3, 5.4, 5.5, 7.1, 8.2, 8.3, 9.2, 9.3, 10.2; D1, D4, D7, D9, D10, D12, D13, D16; U-12.
Keputusan teknis terkait: ADR-006, 007, 008, 010, 011, 013, 014, 015, 016 (`docs/adr/`).
Langkah berikutnya: `docs/runbooks/go-live.md`. Persiapan toko aplikasi: `docs/runbooks/app-store-submission.md`.

> Production dimulai dari database kosong; tidak ada data yang dipindahkan (PRD 8.2). Seluruh runbook ini dijalankan
> **lebih dahulu di staging** sebagai gladi (langkah 7), baru kemudian di production. Tidak ada tanda tangan yang
> dianggap sudah diberikan oleh dokumen ini (PRD 9.3).

## Cara memakai

- Centang `[ ]` setelah langkah selesai dan isi kolom bukti. Langkah bertanda **[bukti]** menghasilkan keluaran yang
  disimpan di folder paket bukti rilis (mis. `bukti-rilis/<versi>/production-init/`), tanpa secret.
- `<...>` adalah nilai yang diisi saat eksekusi. Jangan menempelkan sandi, token, tautan undangan, atau isi `.env` ke
  chat, tiket, atau log (ARCHITECTURE §2 butir 3).
- Peran (pemegang nama ditetapkan D9/D1 sebelum go-live): **PI** pengelola infra, **SA** Super Admin, **BD** bendahara,
  **DEV** pengembang, **QA**, **PP** pemilik produk.
- Perintah shell ditulis untuk VPS Linux (sh). Kontainer PostgreSQL/aplikasi dikelola Coolify; nama kontainer dan
  jaringan Docker dilihat di panel Coolify atau `docker ps`. Perintah database memakai `psql` di dalam kontainer
  PostgreSQL karena image aplikasi tidak memuat `psql`; `-U postgres` berarti superuser resource PostgreSQL (ganti
  bila Coolify memakai nama lain).
- Urutan langkah 2 (dan gerbang go-live) dijalankan otomatis oleh job rilis (ADR-023, ADR-024): jalur CI lewat
  `infra/ci/remote-migrate.sh` (`docs/runbooks/ci-cd.md` bagian 5) atau manual/Compose lewat image `kapdh-release`
  (`docs/runbooks/rilis-dan-gerbang-go-live.md` bagian 4). Pakai job itu; urutan, keluaran yang diharapkan, dan
  pemeriksaan di bawah tetap menjadi acuan dan cara manual bila job tidak tersedia.

## Ringkasan urutan

| Langkah PRD 8.2 | Isi | Pelaksana | Gerbang keluar |
| --------------- | --- | --------- | -------------- |
| 1 Infrastruktur | VPS, Coolify, DNS, TLS, header/HSTS, secrets, firewall, backup luar VPS, monitoring | PI | Image API/worker terbangun di CI; backup + restore database kosong terbukti |
| 2 Skema | `roles.sql` → migrasi → `roles.sql` → seed referensi | PI | Migrasi tercatat sama dengan journal image; tanpa fixture dev |
| 3 Bootstrap Super Admin | CLI sekali pakai, undangan + TOTP; Super Admin kedua lewat web admin (butuh 5.1-5.2) | PI, SA | >= 2 Super Admin aktif ber-TOTP |
| 4 Data referensi | Master, legal, nominal D4, metode bayar, kontak, versi minimum | SA, BD, PP | Semua nilai disahkan; tidak ada DRAF |
| 5 Layanan eksternal | Provider email (D10) + SPF/DKIM/DMARC `noreply@kapdh.or.id` (sebelum 3.4), FCM/APNs | PI, DEV | Email dan push terkirim di smoke test |
| 6 Toko aplikasi | Akun Apple/Google organisasi, signing, listing, formulir privasi, akun demo | PP, DEV | Lihat `app-store-submission.md` |
| 7 Gladi | Seluruh langkah dari nol di staging + smoke test semua peran + restore bersih | PI, QA | Laporan gladi disetujui |

---

## Langkah 1. Infrastruktur (PRD 8.2 langkah 1; PRD 5.3; D7, D9, D12)

### 1.1 VPS, akses, firewall

- [ ] VPS 4 vCPU, RAM 8 GB, disk 100 GB, region Jakarta atau Singapura (D7). Catat penyedia, region, ukuran.
- [ ] Akses root/Coolify hanya pemilik produk dan satu cadangan, SSH key, 2FA (D9). Login SSH dengan sandi dimatikan.
- [ ] Firewall: hanya 80/443 publik; SSH 22 dari IP tepercaya/VPN. PostgreSQL dan Redis **tidak** punya port publik
      (PRD 5.3). Port panel Coolify (8000/6001/6002) dan 8080 milik `coolify-proxy` dipublikasikan Docker sehingga
      melewati ufw; paketnya dari antarmuka publik di-DROP rantai `DOCKER-USER`. **[bukti]** pemeriksaan port
      `go-live.md` 2.4: `nmap -Pn -sV` dengan port kontrol 9999 dari jaringan tanpa VPN, ditambah `ss`, `docker ps`
      dan `iptables -S DOCKER-USER` di VPS.
- [ ] Panel Coolify di subdomain tersendiri dengan 2FA dan daftar pengelola yang tercatat.

### 1.2 DNS, TLS, dan header keamanan (D12; N-07)

| Nama | Isi | Staging |
| ---- | --- | ------- |
| `kapdh.or.id` | situs publik (`apps/web`) | `staging.kapdh.or.id` |
| `www.kapdh.or.id` | **hanya** pengalihan permanen ke `https://kapdh.or.id` (301 untuk GET, 308 untuk HEAD/POST; path dan query dipertahankan) | tidak dipakai |
| `admin.kapdh.or.id` | web admin (`apps/admin`) | `staging-admin.kapdh.or.id` |
| `api.kapdh.or.id` | API + Socket.IO (`apps/api`) | `staging-api.kapdh.or.id` |

- [ ] Record A/AAAA ke VPS; sertifikat TLS diterbitkan Traefik (Coolify). **[bukti]** `curl -sI https://api.kapdh.or.id/api/v1/health`.
- [ ] `www.kapdh.or.id` **tidak** melayani situs; Traefik mengalihkannya permanen ke apex. Alasannya: API hanya menerima
      Origin `new URL(PUBLIC_WEB_URL).origin` untuk CORS dan Socket.IO (`apps/api/src/bootstrap.ts`), jadi di `www`
      halaman legal (isinya dibaca dari `GET /public/pages/{slug}`), verifikasi KTA dan `/delete-account` gagal CORS.
      Pada API lokal (14 Oktober 2026) permintaan ber-Origin `https://www.kapdh.or.id` tidak menerima
      `access-control-allow-origin`. Pengalihan dipasang lewat berkas dinamis Traefik (`rilis-dan-gerbang-go-live.md`
      bagian 7.1), bukan lewat pilihan Direction "Redirect to non-www" di resource Coolify: pilihan itu memakai
      pengalihan sementara (`302` untuk GET, `307` untuk HEAD/POST). **[bukti]** `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n'
      https://www.kapdh.or.id/kebijakan-privasi` → `301 https://kapdh.or.id/kebijakan-privasi`; `curl -sI` (HEAD) pada
      alamat yang sama menjawab `308` dengan `location` yang sama.
- [ ] Admin dan API berada pada site yang sama (`*.kapdh.or.id`); cookie refresh admin SameSite=Strict bergantung pada
      ini (ADR-013).
- [ ] Traefik meneruskan upgrade WebSocket ke API (`/socket.io/`, namespace `/realtime`; ADR-009). **[bukti]** cek WSS
      di 1.6.
- [ ] **Header keamanan web admin.** `apps/admin/index.html` tidak memuat CSP dan mengandalkan proxy; tanpa header,
      konsol pengurus (termasuk tombol setuju pembayaran) dapat dibingkai situs lain (clickjacking). Hosting admin
      wajib mengirim minimal:
  - `Content-Security-Policy` yang memuat `default-src 'self'`, `connect-src 'self' https://api.kapdh.or.id`,
    `img-src 'self' blob: data: https://api.kapdh.or.id`, `object-src 'none'`, `base-uri 'none'`,
    `form-action 'self'`, `frame-ancestors 'none'`;
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, dan
    `Permissions-Policy` yang hanya mengizinkan `camera=(self)` (pemindai check-in).

  Image admin (`infra/Dockerfile.admin`) sudah mengirim header ini dari `infra/nginx-admin.conf`: `default-src 'none'`,
  `style-src 'self'` tanpa `'unsafe-inline'` (editor TipTap `injectCSS: false`, gaya dasar di `tiptap-base.css`),
  `connect-src`/`img-src` = origin API persis yang dirender saat build (bukan wildcard), dan gerbang CSP hasil build
  (`infra/scripts/admin-csp.mjs`). **[bukti]** di staging: login + MFA, detail
  pembayaran dengan pratinjau bukti, editor konten, dan check-in kamera berjalan tanpa pelanggaran CSP di konsol
  peramban; keluaran `curl -sI https://staging-admin.kapdh.or.id/`.
- [ ] **HSTS (N-07)**, diaktifkan setelah semua host yang dicakup melayani HTTPS dan **sebelum** go-live:
  - Traefik: header `Strict-Transport-Security` `max-age=31536000` untuk `kapdh.or.id`, `www.kapdh.or.id` dan
    `admin.kapdh.or.id` (`infra/nginx-web.conf` menyerahkan HSTS ke Traefik). `includeSubDomains` hanya bila setiap
    subdomain `kapdh.or.id` (termasuk staging dan panel Coolify) sudah HTTPS. Jalur Coolify: middleware dynamic
    `kapdh-hsts` + middleware entrypoint `https` beserta pengalihan HTTP → HTTPS permanen (301 untuk GET, 308 untuk
    HEAD/POST; `rilis-dan-gerbang-go-live.md` bagian 7;
    aktif di production sejak 17 Oktober 2026, tanpa `includeSubDomains`).
  - API: `HSTS_ENABLED=true` (helmet, `max-age=31536000; includeSubDomains`).
  - **[bukti]** keluaran `curl -sI` empat host pada gerbang transport `go-live.md` bagian 2.4.

### 1.3 Resource per lingkungan (staging dan production terpisah penuh, PRD 5.3)

- [ ] PostgreSQL 17 (database `kapdh`, superuser hanya untuk langkah 2), tanpa port publik.
- [ ] Redis 7 dengan sandi dan persistensi; tanpa port publik. Wajib di production (`REDIS_URL`, `packages/config`).
- [ ] Direktori berkas host dipasang di `/data/files` pada **API dan worker** (volume yang sama; `STORAGE_LOCAL_ROOT`
      bawaan `/data/files`, PRD 5.4). Pemilik uid 1000 (`node` di image).
- [ ] Aplikasi dari image yang dibangun CI (bukan di VPS, PRD 5.3):
  - API: `infra/Dockerfile.api`, port 3000. Healthcheck Coolify **wajib** `GET /api/v1/health/ready` (bukan
    `/api/v1/health`), agar replika yang database-nya belum menerapkan deletion ledger (503
    `deletion_ledger: "fail"`, ADR-014) atau kehilangan dependensi tidak menerima trafik
    (`docs/runbooks/restore-backup.md` langkah 1). `GET /api/v1/health` hanya liveness proses.
  - Worker: `infra/Dockerfile.worker`, tanpa domain, health internal `GET /healthz` port 3001 (tidak dirutekan publik).
  - Situs publik: `infra/Dockerfile.web` (nginx non-root port **8080**), varian per lingkungan dari katalog
    `infra/ci/images.json` (`PUBLIC_API_URL`).
  - Web admin: `infra/Dockerfile.admin` (nginx non-root port **8080**), varian per lingkungan (`VITE_API_BASE_URL`;
    CSP dirender dari origin yang sama, header 1.2 sudah ada di image).
- [ ] **Image dibangun CI dari tag rilis yang sama** (`deploy-staging.yml`, lalu `release.yml` mempromosikan digest
      yang sama; `docs/runbooks/ci-cd.md`). `infra/Dockerfile.api` memakai `pnpm deploy --prod --legacy` (pnpm 10
      menolak deploy tanpa `inject-workspace-packages`, `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`) dan build gagal bila
      `dist/main.js`, `dist/cli/{bootstrap-admin,golive-check}.js`, `node_modules/@kapdh/database/dist/bin/
      {migrate,seed-reference}.js` atau `migrations/meta/_journal.json` hilang; uji asap image (`infra/ci/images.json`)
      memeriksa berkas, commit dan proses non-root. Image Docker belum pernah dibangun di mesin build (tanpa Docker):
      **[bukti]** run CI pertama yang hijau (job `docker` dan `compose-stack`) dan log `deploy-staging.yml`.
- [ ] Stop grace period: API >= 30 detik; worker > `WORKER_SHUTDOWN_TIMEOUT_MS` + 10 detik (bawaan 25 s → >= 35 s).

### 1.4 Secrets dan environment

Nilai disimpan di Coolify/GitHub Secrets, tidak pernah di repo, image, log, atau frontend (PRD 5.3). Setiap
lingkungan punya nilai **berbeda**. Skema dan aturan: `kapdh-platform/packages/config/src/index.ts`; contoh berkomentar:
`kapdh-platform/.env.example`. Kolom "Ditegakkan saat start" hanya memuat aturan yang membuat API/worker **menolak
start** (`packages/config`); kolom "Nilai production" adalah keputusan operasional yang tidak diperiksa kode dan harus
diperiksa manusia.

| Variabel | API | Worker | Ditegakkan saat start | Nilai production (diperiksa manual) |
| -------- | --- | ------ | --------------------- | ----------------------------------- |
| `NODE_ENV` | ya | ya | salah satu `development`/`test`/`staging`/`production` | `production` (staging: `staging`) |
| `DATABASE_URL` | ya | ya | wajib, URL | API: login `kapdh_app`; worker: login `kapdh_worker` |
| `REDIS_URL` | ya | ya | wajib bila `production` | Redis internal bersandi |
| `SMTP_URL` | ya | ya | wajib bila `staging`/`production` | kredensial provider D10 |
| `MAIL_FROM` | ya | ya | bawaan `KAPDH <noreply@kapdh.or.id>` | biarkan bawaan (D10) |
| `PUBLIC_WEB_URL` | ya | ya | URL; bawaan `https://kapdh.or.id` | `https://kapdh.or.id` (Origin CORS situs publik) |
| `API_PUBLIC_URL` | ya | ya | wajib `https://` bila `staging`/`production` | `https://api.kapdh.or.id` |
| `ADMIN_ORIGIN` | ya | ya | origin; bawaan `https://admin.kapdh.or.id` | `https://admin.kapdh.or.id` (Origin cookie admin dan tautan undangan) |
| `STORAGE_DRIVER`, `STORAGE_LOCAL_ROOT` | ya | ya | `S3_*` wajib bila `s3` | `local`, `/data/files` (S3 setelah migrasi storage, PRD 5.4) |
| `FILE_URL_SECRET` | ya | ya | >= 32 karakter; bukan placeholder `.env.example` bila `staging`/`production` | acak, berbeda per lingkungan |
| `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON` | ya | ya | diisi berpasangan; wajib bila `production`; JSON memuat `client_email` dan `private_key` | JSON satu baris dari proyek Firebase production |
| `LOG_LEVEL` | ya | ya | enum; bawaan `info` | `info` |
| `PORT`, `TRUST_PROXY_HOPS` | ya | - | bawaan `3000`; hop bawaan `1` bila `staging`/`production` | `3000`, `1` (satu Traefik) |
| `HSTS_ENABLED` | ya | - | bawaan `false` | `true` sebelum go-live, setelah 1.2 terpenuhi |
| `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET` | ya | **tidak** | >= 32 karakter; bukan placeholder bila `staging`/`production` | acak |
| `JWT_ISSUER` | ya | - | bawaan `https://api.kapdh.or.id` | staging: URL API staging |
| `QR_SIGNING_KEYS` | ya | **tidak** | format `key_id:secret`, secret >= 32; bila `production` `key_id` tidak berawalan `dev` | `k2026a:<secret>` (ADR-017) |
| `TOTP_ENC_KEY` | ya | **tidak** | 64 hex; bukan nol semua bila `staging`/`production` | hilang = semua TOTP admin tidak dapat dibaca |
| `BCRYPT_COST` | ya | - | 4-15; >= 10 bila `production` | bawaan 12 |
| `WORKER_CONCURRENCY` | - | ya | 1-64, bawaan 4 (nilai 1 hanya memberi peringatan log) | >= 2 (lease outbox butuh koneksi cadangan) |
| `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST`, `OUTBOX_POLL_INTERVAL_MS`, `WORKER_SHUTDOWN_TIMEOUT_MS` | - | ya | rentang angka | bawaan 3001, 0.0.0.0, 2000, 25000 |

Build-time (bukan secret): `PUBLIC_API_URL` (situs publik), `VITE_API_BASE_URL` (web admin). Versi aplikasi minimum,
maintenance, tautan toko, dan kontak dukungan **tidak** diatur lewat env, tetapi lewat `app_settings` (langkah 4).

- [ ] Secret dibangkitkan acak, misalnya `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
      (64 hex, cocok untuk `TOTP_ENC_KEY` dan secret lain).
- [ ] Sandi role `kapdh_migrator`, `kapdh_app`, `kapdh_worker` dibangkitkan dan disimpan di password manager.
- [ ] Worker **tidak** diberi `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET`, `TOTP_ENC_KEY`, `QR_SIGNING_KEYS` (PRD 5.1).
- [ ] `TOTP_ENC_KEY`, `QR_SIGNING_KEYS` dan kunci backup juga disimpan di password manager dengan salinan cetak terpisah
      (D9); kehilangan `TOTP_ENC_KEY` memaksa reset MFA semua admin.

### 1.5 Backup di luar VPS dan restore (PRD 5.5; N-06; D2, D9)

> **PEMBLOKIR GO-LIVE sampai drill lulus.** Alat backup (`kapdh-platform/infra/backup/`: dump terenkripsi, restic
> berkas, manifest, restore ke lingkungan bersih, verifikasi; ADR-018, ADR-019) dan runbooknya
> (`docs/runbooks/backup-restore.md`, Compose cadangan `docs/runbooks/compose-cadangan.md`) sudah ada, tetapi baru diuji
> kering dengan alat palsu (`sh infra/backup/test/dry-run.sh`). Go-live ditunda sampai drill di bawah lulus terhadap
> PostgreSQL, restic dan object storage sungguhan (bukti di `docs/qa/restore-drills/`).

Kriteria penerimaan alat backup (PRD 5.5), diperiksa PI pada drill pertama di staging:

- [ ] Tujuan object storage di luar VPS (mis. Cloudflare R2, Backblaze B2, atau penyedia VPS), retensi 30 hari.
- [ ] Backup harian **terenkripsi**: dump PostgreSQL + `/data/files` termasuk seluruh awalan `ledger/` (folder
      `ledger/account-deletions/` dan objek kepala `ledger/account-deletions-head.json`, ADR-014).
- [ ] Manifest menghubungkan dump DB, daftar/checksum berkas, waktu, schema version (migrasi terakhir), image version,
      dan salinan deletion ledger.
- [ ] Konsistensi DB dan berkas: snapshot filesystem atau jeda mutasi selama backup bila konsistensi rujukan tidak
      dapat dijamin.
- [ ] Kunci backup disimpan terpisah dari salinan backup (password manager + salinan cetak, D9).
- [ ] Umur backup terakhir dipantau (1.6).

Restore selalu mengikuti `docs/runbooks/restore-backup.md`: API dan worker diskala 0 (bukan mode maintenance, karena
flag maintenance ada di database yang direstore), salinan ledger terbaru diamankan **sebelum** berkas direstore,
`account:ledger-reapply` keluar 0, baru API dinyalakan dan readiness 200 dengan `"deletion_ledger": "ok"`.

- [ ] **Gerbang langkah 1** **[bukti]**: backup database kosong (setelah langkah 2) direstore ke lingkungan bersih
      mengikuti `restore-backup.md`; `GET /api/v1/health/ready` = 200; jumlah migrasi tercatat sama.
- [ ] **Kriteria lulus N-06** untuk setiap drill (gladi langkah 7, drill bulanan, UAT U-11 11.5): RPO <= 24 jam
      (umur backup yang direstore terhadap waktu "bencana" simulasi) dan RTO <= 4 jam (dari keputusan restore sampai
      layanan dibuka kembali dan pemeriksaan pasca-restore lulus). Melebihi salah satu = drill gagal.
- [ ] **Drill restore bulanan** (PRD 5.5, D9), pemilik PI, dijadwalkan tetap (mis. minggu pertama setiap bulan),
      ke lingkungan bersih yang terpisah dari production. Pemeriksaan wajib setelah restore: login + MFA admin, jumlah
      anggota per status, total uang (`paid` per jenis) sama dengan sumber, tiket, chat, berkas privat sampel dapat
      dibuka, dan penghapusan terdahulu tetap terhapus (kueri `restore-backup.md` langkah 8). Catat RPO/RTO teramati dan
      hasil per butir di laporan drill; drill yang gagal dicatat sebagai insiden.

### 1.6 Monitoring (PRD 5.5; D9)

- [ ] Uptime Kuma (atau setara), alert ke Telegram/WhatsApp/email (D9):
  - `https://api.kapdh.or.id/api/v1/health` (liveness) dan `/api/v1/health/ready` (HTTP 200 **dan** `status = "ok"`;
    pantau `checks.outbox_oldest_pending_seconds`);
  - `https://kapdh.or.id/`, `https://admin.kapdh.or.id/`;
  - worker `GET /healthz` dari jaringan internal: alert bila `status != "ok"` (isu `dispatcher_failing`,
    `scheduler_failing`, `queue_unreachable`, `outbox_lagging`, ...), bukan hanya kode HTTP;
  - disk VPS: warning 60 %, critical 80 % (PRD 5.4); umur backup terakhir (alert bila > 26 jam); umur job/outbox
    tertua (worker `issues` `outbox_lagging`, `outbox_dead_events`; readiness `outbox_oldest_pending_seconds`).
- [ ] **Koneksi WS (PRD 5.5)**: cek sintetis upgrade WebSocket lewat Traefik, tiap 5 menit (cron VPS yang mengirim ke
      monitor push, atau tipe monitor WebSocket bila versi Uptime Kuma yang dipakai menyediakannya). Klien tanpa
      header Origin diterima server (seperti aplikasi), jadi cek ini tidak butuh akun:

  ```sh
  curl -si --max-time 5 --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://api.kapdh.or.id/socket.io/?EIO=4&transport=websocket" | head -1
  # sehat: HTTP/1.1 101 Switching Protocols
  ```

  Diuji 14 Oktober 2026 terhadap API lokal tanpa TLS (`http://127.0.0.1`): keluar `101 Switching Protocols`. Lewat
  Traefik/TLS pada production: `101` pada 21 Oktober 2026 (`docs/qa/transport/2026-10/README.md`). Cek sintetis
  terjadwal belum dipasang.
- [ ] **Kegagalan provider (PRD 5.5)** sebagai alert, bukan hanya tampilan web admin (Notifikasi → Pengiriman). Cron
      VPS tiap 15 menit yang hanya mengirim "sehat" ke monitor push (mis. Uptime Kuma Push; tidak ada kiriman dalam
      interval = alert):

  ```sh
  n=$(docker exec -i <kontainer-postgres> psql -U postgres -d kapdh -X -At -c \
    "select count(*) from app.notification_deliveries where status = 'failed' and updated_at > now() - interval '1 hour'")
  [ "$n" -le <ambang, mis. 10> ] && curl -fsS "<url-monitor-push>" > /dev/null
  ```

  Kueri diuji pada PostgreSQL 17 lokal; skrip cron dan monitor push belum diuji. Event outbox `dead` sudah tercakup
  oleh isu worker `outbox_dead_events`. Lonjakan bounce/complaint email dipantau di dasbor provider D10.
- [ ] Log diagnostik retensi 30 hari tanpa PII (PRD 5.5). Error tracking GlitchTip terpasang di API dan worker
      (`SENTRY_DSN`, ADR-021; `docs/runbooks/monitoring.md` bagian 5) dari baris log yang sudah aman; web admin dan
      aplikasi Flutter belum. Bila ditambahkan ke aplikasi, perbarui formulir privasi toko (`app-store-submission.md`).
- [ ] Runbook Compose cadangan (PRD 5.5: panel Coolify mati tidak boleh menghilangkan jalur deploy):
      `docs/runbooks/compose-cadangan.md`; stack-nya diuji di CI (job `compose-stack`), belum di VPS.

---

## Langkah 2. Skema (PRD 8.2 langkah 2; PRD 5.5)

Jalankan dari VPS dengan salinan repo pada **tag rilis yang sama** dengan image (untuk `infra/db/roles.sql`), mis.
`/opt/kapdh/src`. Migrasi dijalankan sekali oleh job, bukan saat startup API/worker.

Siapkan berkas env job (root, mode 600, di luar repo), mis. `/etc/kapdh/production/migrator.env`:

```sh
DATABASE_URL=postgres://kapdh_migrator:<sandi-migrator>@<host-postgres-internal>:5432/kapdh
```

- [ ] **2.1 Role dan hak tingkat database** (superuser, sebelum migrasi pertama) **[bukti]**:

  ```sh
  cd /opt/kapdh/src/kapdh-platform
  docker exec -i <kontainer-postgres> psql -U postgres -d kapdh -X -v ON_ERROR_STOP=1 -f - < infra/db/roles.sql
  ```

  Pada database kosong muncul `NOTICE: Skema app belum ada; jalankan migrasi lalu ulangi berkas ini ...` (normal).

- [ ] **2.2 Sandi role LOGIN** (interaktif, sandi tidak masuk riwayat shell):

  ```sh
  docker exec -it <kontainer-postgres> psql -U postgres -d kapdh -X
  \password kapdh_migrator
  \password kapdh_app
  \password kapdh_worker
  \password kapdh_backup
  \password kapdh_monitor
  \q
  ```

  `kapdh_backup` (backup harian `infra/backup`, `pg_read_all_data`) dan `kapdh_monitor` (pemeriksa
  `infra/monitoring/check-app.sh`) juga role LOGIN dari `roles.sql`; sandinya disimpan di password manager dan di
  `/etc/kapdh/backup.secrets.env` / `/etc/kapdh/monitoring.env` (`docs/runbooks/backup-restore.md` bagian 3,
  `docs/runbooks/monitoring.md`).

- [ ] **2.3 Migrasi** sebagai `kapdh_migrator` dari image API rilis, pada jaringan Docker yang sama dengan PostgreSQL
      **[bukti]**:

  ```sh
  docker run --rm --network <jaringan-docker> --env-file /etc/kapdh/production/migrator.env \
    <registry>/kapdh-api:<tag> node node_modules/@kapdh/database/dist/bin/migrate.js
  ```

  Keluaran yang diharapkan pada database kosong (uji coba 14 Oktober 2026 pada PostgreSQL 17 lokal, 8 migrasi
  `0000`-`0007`):

  ```
  [migrate] Menunggu lock migrasi...
  [migrate] Lock diperoleh. Migrasi tercatat sebelum: 0.
  [migrate] Migrasi selesai. Diterapkan: 8. Total tercatat: 8.
  ```

  Menjalankan ulang aman (advisory lock `4711000517`; "Diterapkan: 0"). Kode keluar bukan 0 = berhenti, jangan
  lanjut.

- [ ] **2.4 Terapkan ulang grant objek** (wajib setelah SETIAP migrasi) **[bukti]**:

  ```sh
  docker exec -i <kontainer-postgres> psql -U postgres -d kapdh -X -v ON_ERROR_STOP=1 -f - < infra/db/roles.sql
  ```

- [ ] **2.5 Seed referensi** (aman untuk production, idempoten, tanpa fixture) **[bukti]**:

  ```sh
  docker run --rm --network <jaringan-docker> --env-file /etc/kapdh/production/migrator.env \
    <registry>/kapdh-api:<tag> node node_modules/@kapdh/database/dist/bin/seed-reference.js
  ```

  Eksekusi pertama: `[seed:reference] selesai: {"settings_inserted":10,"professions_inserted":24,"skills_inserted":22,"pages_inserted":5}`.
  Eksekusi berikutnya menyisipkan 0 dan tidak menimpa nilai yang diubah pengurus. **Jangan pernah** menjalankan
  `seed-dev.js` di production (CLI menolak `NODE_ENV=production`, PRD 8.2).

- [ ] **2.6 Deploy API dan worker** (Coolify) dengan image yang sama; periksa **[bukti]**:
  - `curl -s https://api.kapdh.or.id/api/v1/health/ready` → `{"status":"ok",...,"checks":{"database":"ok","redis":"ok","storage":"ok","deletion_ledger":"ok",...}}`
    (pada storage kosong belum ada kepala ledger, jadi `deletion_ledger` = `ok`);
  - worker `GET /healthz` → `"status":"ok"`, `"queue":{"ok":true,"driver":"bullmq"}`, scheduler `role: leader` pada
    satu instance;
  - `curl -s https://api.kapdh.or.id/api/v1/public/config` → `legal` masih `null` (halaman belum terbit).

  Catatan: readiness sengaja tetap lulus pada database tanpa admin dan tanpa konfigurasi tersahkan; gerbang konfigurasi
  adalah `golive:check` (ADR-023, temuan audit D2-02) yang dijalankan job rilis, ditambah pemeriksaan silang SQL di
  `go-live.md` bagian 2.3.

- [ ] **2.7 Pastikan tanpa fixture dev** **[bukti]** (harus `0`):

  ```sh
  docker exec -i <kontainer-postgres> psql -U postgres -d kapdh -X -At <<'SQL'
  select count(*) from (
    select 1 from app.users where email like '%.test'
    union all select 1 from app.alumni where full_name like '[Contoh]%'
    union all select 1 from app.payment_methods where provider like '%Contoh%'
    union all select 1 from app.posts where title like '[Contoh]%'
    union all select 1 from app.events where title like '[Contoh]%'
  ) f;
  SQL
  ```

---

## Langkah 3. Bootstrap Super Admin (PRD 8.2 langkah 3; D1; ADR-008, ADR-013)

Super Admin pertama: **Bayu Musthafa** (D1). Super Admin kedua ditunjuk PP sebelum go-live.

- [ ] **3.1 Jalankan CLI sekali** di kontainer API yang sedang berjalan (env API lengkap; bukan endpoint HTTP)
      **[bukti: hanya baris "Email" dan "Berlaku sampai", tautan TIDAK disimpan]**:

  ```sh
  docker exec -it <kontainer-api> node dist/cli/bootstrap-admin.js --email <email-super-admin-1> --name "Bayu Musthafa"
  ```

  Keluaran (uji coba lokal 14 Oktober 2026):

  ```
  Super Admin pertama dibuat dengan status menunggu aktivasi (invited).
    Email           : <email>
    Tautan undangan : https://admin.kapdh.or.id/invite#t=<token>
    Berlaku sampai  : <72 jam>
  ```

  - Kode keluar: 0 berhasil, 1 ditolak (mis. "Super Admin aktif sudah ada. Tambahkan admin lain dari web admin"),
    2 argumen salah.
  - Tautan hanya tampil sekali, berlaku 72 jam, sekali pakai. Serahkan langsung ke pemiliknya; jangan lewat chat.
  - Menjalankan ulang dengan **email yang sama** sebelum aktivasi menerbitkan tautan baru dan membatalkan yang lama.
  - Menjalankan dengan **email lain** sebelum ada Super Admin aktif membuat undangan Super Admin **tambahan**
    (perilaku diamati pada uji coba). Bila terjadi karena salah ketik, setelah Super Admin pertama aktif hapus
    undangan yang salah di web admin (Manajemen Admin → Daftar Admin) dan catat di laporan.

- [ ] **3.2 Aktivasi oleh pemilik akun** di peramban: buka tautan → ganti sandi awal (aturan sandi PRD 2.5) → pindai
      QR TOTP di aplikasi autentikator → konfirmasi kode pertama → simpan **10 backup code** (tampil sekali) di
      password manager pribadi. Akun menjadi `active`. **[bukti]** tangkapan layar dasbor setelah login (tanpa kode).
- [ ] **3.3 Verifikasi penolakan bootstrap kedua** **[bukti]**: menjalankan ulang CLI kini keluar 1 dengan
      "Super Admin aktif sudah ada".
- [ ] **3.4 Prasyarat email sebelum undangan pertama**: langkah **5.1 dan 5.2** (provider email D10 dan
      SPF/DKIM/DMARC `noreply@kapdh.or.id`) sudah selesai dengan bukti `spf=pass`, `dkim=pass`, `dmarc=pass`; worker
      berjalan (`GET /healthz` `status` = `ok`) dan `SMTP_URL` terisi. Undangan 3.5 dan seterusnya dikirim email
      lewat outbox; tanpa autentikasi domain email itu dapat ditolak atau masuk spam. Bootstrap 3.1 tidak terdampak
      karena tautannya dicetak CLI.
- [ ] **3.5 Super Admin kedua**: Super Admin pertama login → Manajemen Admin → Daftar Admin → undang dengan peran
      Super Admin (tanpa reautentikasi sejak ADR-025; sesi sudah ber-TOTP dan undangan tercatat di audit
      `admin.invited`). Penerima membuka tautan dari email `noreply@kapdh.or.id` dan menjalankan 3.2. Bila email tidak
      datang: web admin Notifikasi → Pengiriman → tab Outbox (event `failed`/`dead`, izin `notifications.manage`),
      worker `GET /healthz` dan log worker, lalu "Kirim ulang undangan" di halaman detail admin (tindakan kredensial:
      meminta sandi + kode TOTP).
- [ ] **3.6 Pengurus pembayaran**: undang minimal dua admin yang memegang `payments.decide` (PRD 10.2), atau pastikan
      Super Admin yang berperan sebagai pemutus. Admin yang juga alumni ditautkan ke akun alumninya
      (konflik kepentingan PRD 2.3).
- [ ] **3.7 Pemeriksaan** **[bukti]** (harus >= 2):

  ```sh
  docker exec -i <kontainer-postgres> psql -U postgres -d kapdh -X -At <<'SQL'
  select count(*) from app.admins a
    join app.users u on u.id = a.user_id
    join app.mfa_totp m on m.user_id = u.id and m.verified_at is not null
   where a.role = 'super_admin' and a.status = 'active' and u.status = 'active';
  SQL
  ```

---

## Langkah 4. Data referensi (PRD 8.2 langkah 4; D4, D13)

Semua perubahan lewat web admin `https://admin.kapdh.or.id` (diaudit, F-17). Nilai yang belum disahkan **memblokir
go-live** (PRD 8.2, 10.2).

- [ ] **4.1 Master profesi dan keahlian** (Manajemen Users → Skill & Profesi, izin `master.manage`): seed menyisipkan
      24 profesi dan 22 keahlian berstatus **USULAN dan NONAKTIF**. Tinjau, ubah label/urutan bila perlu, lalu
      aktifkan yang disetujui. Tanpa master aktif, profil anggota tidak dapat memilih profesi/keahlian.
- [ ] **4.2 Halaman legal dan informasi** (Manajemen Konten → Berita, Banner & Halaman → tab Halaman,
      `content.manage`): ganti seluruh isi DRAF `kebijakan-privasi`, `ketentuan`, `ketentuan-komunitas`, `bantuan`,
      `tentang` dengan naskah yang disahkan PP, lalu **Terbitkan**. Terbit menaikkan `published_version` dan mengisi
      `app_settings.legal`; registrasi anggota ditolak (409) sampai kebijakan privasi dan ketentuan terbit.
      Kebijakan privasi wajib memuat isi yang dipakai formulir privasi toko (`app-store-submission.md` bagian 4) dan
      retensi D2 (data keuangan/tiket/laporan/audit tersisa anonim; backup berotasi 30 hari).
- [ ] **4.3 Nominal iuran D4** (Verifikasi Pembayaran → tab "Biaya Pembayaran"; `settings.manage`, tanpa
      reautentikasi sejak ADR-025, tercatat di audit `settings.updated`): seed = registrasi Rp50.000, pembuatan KTA
      Rp10.000, perpanjangan Rp10.000. **BD** memeriksa dan menandatangani nilai yang tampil; bila berubah, ubah lewat
      web admin (versi `fees` naik, payment lama tetap memakai snapshot; ADR-006).
- [ ] **4.4 Metode bayar** (Verifikasi Pembayaran → tab "Kelola Metode", `settings.manage`, tanpa reautentikasi
      sejak ADR-025, tercatat di audit `payment_method.*`): **BD** membuat rekening organisasi yang sah (bank, nomor,
      atas nama, instruksi). Tidak ada metode bayar di seed. Karena simpan tidak lagi meminta sandi + TOTP, **BD**
      mencocokkan rekening aktif dengan daftar yang ditandatangani saat sign-off go-live dan setelah setiap perubahan
      metode (risiko yang diterima ADR-025). QRIS dibuat sebagai jenis **QRIS** dengan NMID, nama merchant, dan gambar
      QRIS statis resmi (PNG/JPG, minimal 512 piksel), bukan sebagai bank/e-wallet tanpa gambar, karena gerbang
      menolak bentuk itu. **BD** memindai uji gambar sebelum metode diaktifkan, lalu menandatangani sidik jari gambar
      di laporan gerbang (ADR-026, `rilis-dan-gerbang-go-live.md` bagian 5.4).
- [ ] **4.5 Kontak dukungan** (Pengaturan): email `bantuan@kapdh.or.id` (seed) dan **satu nomor WhatsApp admin**
      (PRD 8.3; seed `null`).
- [ ] **4.6 Versi aplikasi minimum** (Pengaturan): `android`/`ios` = versi build rilis pertama (bawaan `1.0.0`).
      Naikkan hanya setelah versi baru dapat diunduh di toko (PRD 8.4).
- [ ] **4.7 Tautan toko** (Pengaturan): diisi setelah listing disetujui (`go-live.md` langkah 5); halaman
      `https://kapdh.or.id/unduh` membaca nilai ini.
- [ ] **4.8 Instruksi iuran per platform** (Pengaturan → "Sembunyikan instruksi iuran di"): biarkan kosong saat
      go-live. Rencana cadangan iOS D13 hanya diaktifkan sesuai `app-store-submission.md` bagian 6.
- [ ] **4.9 Kategori** berita (Manajemen Konten, tab Kategori) dan event (Manajemen Event & Tiket) sesuai kebutuhan
      pengurus; konten awal (berita sambutan, banner) bila diinginkan.
- [ ] **4.10 Pemeriksaan konfigurasi** **[bukti]**: jalankan blok SQL "Gerbang konfigurasi" di `go-live.md`
      bagian 2; semua baris sesuai target.

---

## Langkah 5. Layanan eksternal (PRD 8.2 langkah 5; D10)

Urutan: 5.1 dan 5.2 dikerjakan **sebelum** langkah 3.4-3.6 (undangan admin dikirim email); butir lain boleh
setelah langkah 4.

- [ ] **5.1 Provider email transaksional** dipilih DEV dari Amazon SES, Brevo, Mailgun, Resend atau Postmark (D10);
      kredensial SMTP di `SMTP_URL` (`smtp://user:pass@host:port` atau `smtps://...`).
- [ ] **5.2 Domain pengirim `noreply@kapdh.or.id`**: SPF (`include` provider), DKIM (record CNAME/TXT dari provider),
      DMARC (mulai `p=none; rua=mailto:<kotak-laporan>`, naikkan ke `quarantine` setelah laporan bersih).
      **[bukti]** header email uji menunjukkan `spf=pass`, `dkim=pass`, `dmarc=pass`.
- [ ] **5.3 FCM production**: proyek Firebase khusus production (staging terpisah, PRD 5.3); aplikasi Android
      `id.or.kapdh.app` dan iOS `id.or.kapdh.app` terdaftar; akun layanan dengan izin kirim FCM → `FCM_PROJECT_ID` dan
      `FCM_SERVICE_ACCOUNT_JSON` (API dan worker). Firebase hanya untuk FCM (ARCHITECTURE §2 butir 4). Langkah rinci
      (Console Firebase, Coolify Normal view, verifikasi VPS tanpa mencetak secret, salin ke berkas env, rotasi kunci,
      rollback): `docs/runbooks/push-fcm.md`.
- [ ] **5.4 APNs**: kunci APNs (.p8) dari akun Apple Developer organisasi diunggah ke proyek Firebase production;
      capability Push Notifications di App ID (`push-fcm.md` bagian 8).
- [ ] **5.5 Nilai klien Firebase** (`FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_API_KEY`,
      `FIREBASE_ANDROID_APP_ID`, `FIREBASE_IOS_APP_ID`, `PUSH_ENABLED=true`) disimpan sebagai secret CI untuk build
      Flutter production (ADR-016); `kapdh-mobile/config/production.json` di repo tetap kosong. Build di PC tepercaya
      memakai berkas di luar repo `C:\kapdh-secure\firebase-production.json` (`push-fcm.md` bagian 6). Proyeknya wajib
      sama dengan `FCM_PROJECT_ID`, karena token dari proyek lain ditolak `SENDER_ID_MISMATCH` lalu dinonaktifkan.
- [ ] **5.6 Uji kirim** **[bukti]**: registrasi akun uji menerima OTP; akun uji di perangkat nyata menerima push
      (mis. notifikasi keputusan pembayaran). Kegagalan terlihat di web admin Notifikasi → Pengiriman. Kredensial
      server dibuktikan lebih dulu dengan `node dist/cli/push-selftest.js` di kontainer API (validate_only, tanpa
      notifikasi terkirim; `push-fcm.md` bagian 5).

## Langkah 6. Toko aplikasi (PRD 8.2 langkah 6; D10, D13, D16)

Ikuti `docs/runbooks/app-store-submission.md` bagian 1-5 dan 9; keputusan PP untuk formulir toko ada di bagian 10.
Ringkas:

- [ ] Apple Developer Program dan Google Play Console atas nama organisasi (nomor D-U-N-S).
- [ ] Signing key Android (`android/key.properties`, tidak di-commit; Play App Signing) dan sertifikat/profil iOS.
- [ ] Listing, URL kebijakan privasi `https://kapdh.or.id/kebijakan-privasi`, URL hapus akun
      `https://kapdh.or.id/delete-account`, kontak moderasi `bantuan@kapdh.or.id`.
- [ ] Aset listing Google Play: ikon 512 x 512 PNG, feature graphic 1024 x 500 (JPEG atau PNG tanpa alfa), deskripsi
      singkat paling banyak 80 karakter, deskripsi lengkap (draf `app-store-submission.md` bagian 2), dan minimal dua
      tangkapan layar ponsel dengan sisi panjang paling banyak dua kali sisi pendek. Tangkapan di `docs/panduan`
      (720 x 1602, rasio di atas 2:1) tidak dapat dipakai langsung. Aset mengikuti aturan teks D13 (bagian 2).
- [ ] Data safety (bagian 4) dan deklarasi App content Google Play (bagian 9) diisi setelah keputusan PP K1-K8
      (bagian 10) diambil.
- [ ] Akun demo reviewer (D16): aktif terverifikasi (Demo A dan C) **dan** belum bayar (Demo B), dibuat lewat alur
      resmi. Akun belum bayar saja tidak cukup karena tidak dapat membuka berita, event, direktori, dan chat
      (bagian 9.1).
- [ ] Pemblokir submit yang diketahui per 25 Oktober 2026: kebijakan privasi dan Ketentuan Komunitas yang hanya
      terbaca dengan JavaScript (bagian 7). Teks aplikasi D13 mitigasi 1 sudah lulus sejak 21 Oktober 2026 (`grep`
      bagian 2 kosong); ulangi pemeriksaan itu pada commit build yang diajukan.

## Langkah 7. Gladi di staging (PRD 8.2 langkah 7; U-12)

Penyiapan staging pertama (VPS, Coolify, Tailscale, secrets GitHub): `docs/runbooks/staging-setup.md`.

- [ ] Hapus lingkungan staging (database, volume berkas, Redis) secara terkendali; catat waktu mulai. Database dibuat
      ulang kosong (role tingkat cluster tetap ada; grant diterapkan ulang oleh `roles.sql` di langkah 2):

  ```sh
  # API dan worker staging sudah diskala 0 di Coolify
  docker exec -i <kontainer-postgres-staging> psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 \
    -c 'drop database if exists kapdh with (force)' -c 'create database kapdh'
  ```

- [ ] Jalankan langkah 1.3-5 dari nol dengan nilai staging (D12: `staging`, `staging-admin`, `staging-api`; proyek
      FCM staging). Seed dev **boleh** di staging hanya bila gladi ini tidak sedang membuktikan "tanpa fixture"; untuk
      U-12 jalankan tanpa seed dev.
- [ ] Build Flutter yang dipakai gladi/UAT ber-versi >= `min_app_version` lingkungan itu. Seed referensi mengisi
      `min_app_version` `1.0.0` untuk Android dan iOS dan `kapdh-mobile/pubspec.yaml` saat ini `1.0.0+1`; aplikasi
      mengirim versi pubspec sebagai `X-App-Version`, dan setiap mutasi dari build di bawah `1.0.0` ditolak 426
      `UPGRADE_REQUIRED`. Bila `min_app_version` lingkungan lebih tinggi dari versi build, naikkan versi build, atau
      (staging saja) turunkan `min_app_version` ke versi build lewat Pengaturan dan catat di laporan gladi.
- [ ] Smoke test semua peran memakai `docs/qa/uat-checklist.md`: U-01, U-02, U-03, U-05, U-07, U-08, U-09 (set yang
      sama dengan smoke test production `go-live.md` 3.1) ditambah U-12.
- [ ] Backup pertama staging → restore ke lingkungan bersih mengikuti `docs/runbooks/restore-backup.md` (API/worker
      skala 0, ledger terbaru diamankan, `account:ledger-reapply` keluar 0, readiness 200 dengan
      `"deletion_ledger": "ok"`) → login admin + MFA dan akun uji berhasil. **Lulus hanya bila RPO <= 24 jam dan RTO
      <= 4 jam** (N-06, 1.5); catat keduanya dengan `infra/backup/restore.sh` + `verify-restore.sh`
      (`docs/runbooks/backup-restore.md` bagian 8, templat `docs/qa/restore-drills/TEMPLATE.md`).
- [ ] **[bukti]** Laporan gladi: durasi tiap langkah, masalah dan perbaikannya, versi image/SDK/build Flutter.
- [ ] Sign-off gladi oleh PI (operasional, restore) dan QA (smoke test) di tabel `go-live.md` bagian 4.

## Lampiran A. Uji coba runbook (14 Oktober 2026)

Pada mesin build (Windows, tanpa Docker) perintah langkah 2 dan 3 diuji terhadap PostgreSQL 17.6 sementara dari paket
`embedded-postgres` (jalur uji), memakai `roles.sql`, role `kapdh_migrator`/`kapdh_app`/`kapdh_worker`, CLI dari
`pnpm build`: migrasi (8 diterapkan, ulang 0), `roles.sql` ulang, seed referensi (10/24/22/5, ulang 0), penolakan
`seed-dev.js` pada `NODE_ENV=production` (keluar 1), API `GET /api/v1/health`, `/health/ready` (200 tanpa Redis),
`/public/config`, worker `/healthz` (driver inline), CLI bootstrap (buat, terbit ulang, email lain, tanpa argumen →
keluar 2), CLI `ledger-reapply` pada folder kosong, dan blok SQL gerbang konfigurasi. Setelah `main` memuat hardening
API Fase D, diuji ulang: migrasi (tetap 8), seed referensi, readiness dengan `deletion_ledger` `ok`, flag maintenance
yang diaktifkan lewat SQL menolak login 503 `MAINTENANCE`, cek WebSocket 1.6 (`101`), kueri kegagalan pengiriman
1.6, penolakan CORS untuk Origin `www`, mutasi ber-`X-App-Version: 0.1.0` ditolak 426 `UPGRADE_REQUIRED` (versi
`1.0.0` lolos gerbang versi), reset database (`drop database ... with (force)` saat API masih tersambung,
`create database`, `roles.sql`, migrasi 8, `roles.sql`), dan keluaran `pnpm --filter @kapdh/api deploy --prod --legacy`
(semua CLI ada). SQL dijalankan lewat klien Node pengganti `psql`, bukan `psql` di kontainer. **Belum diuji**: image Docker (`Dockerfile.api` di `main` gagal dibangun, 1.3), `psql` di kontainer, Coolify,
Traefik/TLS/WSS, header admin dan HSTS, Redis/BullMQ nyata, SMTP/FCM nyata, backup/restore, cron monitor. Semuanya
wajib dibuktikan pada gladi staging (langkah 7). Catatan kemudian: Traefik/TLS/WSS, header dan HSTS sudah terbukti
pada production 21 Oktober 2026 (`docs/qa/transport/2026-10/README.md`); gladi staging tetap wajib.
