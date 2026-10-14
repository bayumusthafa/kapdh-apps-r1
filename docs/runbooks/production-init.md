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
- Bila paket infra Fase E menyediakan job rilis yang menjalankan urutan langkah 2 secara otomatis, pakai job itu;
  urutan, keluaran yang diharapkan, dan pemeriksaan di bawah tetap menjadi acuan.

## Ringkasan urutan

| Langkah PRD 8.2 | Isi | Pelaksana | Gerbang keluar |
| --------------- | --- | --------- | -------------- |
| 1 Infrastruktur | VPS, Coolify, DNS, TLS, secrets, firewall, backup luar VPS, monitoring | PI | Backup + restore database kosong terbukti |
| 2 Skema | `roles.sql` → migrasi → `roles.sql` → seed referensi | PI | Migrasi tercatat sama dengan journal image; tanpa fixture dev |
| 3 Bootstrap Super Admin | CLI sekali pakai, undangan + TOTP; Super Admin kedua lewat web admin | PI, SA | >= 2 Super Admin aktif ber-TOTP |
| 4 Data referensi | Master, legal, nominal D4, metode bayar, kontak, versi minimum | SA, BD, PP | Semua nilai disahkan; tidak ada DRAF |
| 5 Layanan eksternal | FCM/APNs, SPF/DKIM/DMARC `noreply@kapdh.or.id`, provider email (D10) | PI, DEV | Email dan push terkirim di smoke test |
| 6 Toko aplikasi | Akun Apple/Google organisasi, signing, listing, formulir privasi, akun demo | PP, DEV | Lihat `app-store-submission.md` |
| 7 Gladi | Seluruh langkah dari nol di staging + smoke test semua peran + restore bersih | PI, QA | Laporan gladi disetujui |

---

## Langkah 1. Infrastruktur (PRD 8.2 langkah 1; PRD 5.3; D7, D9, D12)

### 1.1 VPS, akses, firewall

- [ ] VPS 4 vCPU, RAM 8 GB, disk 100 GB, region Jakarta atau Singapura (D7). Catat penyedia, region, ukuran.
- [ ] Akses root/Coolify hanya pemilik produk dan satu cadangan, SSH key, 2FA (D9). Login SSH dengan sandi dimatikan.
- [ ] Firewall: hanya 80/443 publik; SSH 22 dari IP tepercaya/VPN. PostgreSQL dan Redis **tidak** punya port publik
      (PRD 5.3). **[bukti]** keluaran pemindaian port dari luar VPS (mis. `nmap -Pn -p 22,80,443,5432,6379 <ip>`).
- [ ] Panel Coolify di subdomain tersendiri dengan 2FA dan daftar pengelola yang tercatat.

### 1.2 DNS dan TLS (D12)

| Nama | Isi | Staging |
| ---- | --- | ------- |
| `kapdh.or.id`, `www.kapdh.or.id` | situs publik (`apps/web`) | `staging.kapdh.or.id` |
| `admin.kapdh.or.id` | web admin (`apps/admin`) | `staging-admin.kapdh.or.id` |
| `api.kapdh.or.id` | API + Socket.IO (`apps/api`) | `staging-api.kapdh.or.id` |

- [ ] Record A/AAAA ke VPS; sertifikat TLS diterbitkan Traefik (Coolify). **[bukti]** `curl -sI https://api.kapdh.or.id/api/v1/health`.
- [ ] Admin dan API berada pada site yang sama (`*.kapdh.or.id`); cookie refresh admin SameSite=Strict bergantung pada
      ini (ADR-013).
- [ ] `HSTS_ENABLED=true` baru diaktifkan setelah **semua** subdomain yang dicakup sudah HTTPS (N-07).
- [ ] Traefik meneruskan upgrade WebSocket ke API (`/socket.io/`, namespace `/realtime`; ADR-009).

### 1.3 Resource per lingkungan (staging dan production terpisah penuh, PRD 5.3)

- [ ] PostgreSQL 17 (database `kapdh`, superuser hanya untuk langkah 2), tanpa port publik.
- [ ] Redis 7 dengan sandi dan persistensi; tanpa port publik. Wajib di production (`REDIS_URL`, `packages/config`).
- [ ] Direktori berkas host dipasang di `/data/files` pada **API dan worker** (volume yang sama; `STORAGE_LOCAL_ROOT`
      bawaan `/data/files`, PRD 5.4). Pemilik uid 1000 (`node` di image).
- [ ] Aplikasi dari image yang dibangun CI (bukan di VPS, PRD 5.3):
  - API: `infra/Dockerfile.api`, port 3000, liveness `GET /api/v1/health`, readiness `GET /api/v1/health/ready`.
  - Worker: `infra/Dockerfile.worker`, tanpa domain, health internal `GET /healthz` port 3001 (tidak dirutekan publik).
  - Situs publik: `infra/Dockerfile.web` (nginx port 80), `--build-arg PUBLIC_API_URL=https://api.kapdh.or.id/api/v1`.
  - Web admin: berkas statis `apps/admin/dist` hasil
    `VITE_API_BASE_URL=https://api.kapdh.or.id/api/v1 pnpm --filter @kapdh/admin build`; `main` belum memuat
    Dockerfile admin, jadi hosting mengikuti paket infra Fase E.
- [ ] Stop grace period: API >= 30 detik; worker > `WORKER_SHUTDOWN_TIMEOUT_MS` + 10 detik (bawaan 25 s → >= 35 s).

### 1.4 Secrets dan environment

Nilai disimpan di Coolify/GitHub Secrets, tidak pernah di repo, image, log, atau frontend (PRD 5.3). Setiap
lingkungan punya nilai **berbeda**. Skema dan aturan: `kapdh-platform/packages/config/src/index.ts`; contoh berkomentar:
`kapdh-platform/.env.example`. API dan worker menolak start bila aturan production dilanggar.

| Variabel | API | Worker | Nilai production / aturan |
| -------- | --- | ------ | ------------------------- |
| `NODE_ENV` | ya | ya | `production` (staging: `staging`) |
| `DATABASE_URL` | ya | ya | API: login `kapdh_app`; worker: login `kapdh_worker` |
| `REDIS_URL` | ya | ya | wajib di production |
| `SMTP_URL`, `MAIL_FROM` | ya | ya | wajib di staging/production; `MAIL_FROM="KAPDH <noreply@kapdh.or.id>"` (D10) |
| `PUBLIC_WEB_URL` | ya | ya | `https://kapdh.or.id` |
| `API_PUBLIC_URL` | ya | ya | `https://api.kapdh.or.id` (wajib https) |
| `ADMIN_ORIGIN` | ya | ya | `https://admin.kapdh.or.id` (Origin cookie admin dan tautan undangan) |
| `STORAGE_DRIVER`, `STORAGE_LOCAL_ROOT` | ya | ya | `local`, `/data/files` (S3 setelah migrasi storage, PRD 5.4) |
| `FILE_URL_SECRET` | ya | ya | >= 32 karakter acak, bukan placeholder |
| `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON` | ya | ya | wajib di production, diisi berpasangan (JSON satu baris) |
| `LOG_LEVEL` | ya | ya | `info` |
| `PORT`, `TRUST_PROXY_HOPS`, `HSTS_ENABLED` | ya | - | `3000`, `1` (bawaan production), `false` sampai 1.2 terpenuhi |
| `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET` | ya | **tidak** | >= 32 karakter acak |
| `JWT_ISSUER` | ya | - | `https://api.kapdh.or.id` (staging: URL API staging) |
| `QR_SIGNING_KEYS` | ya | **tidak** | `k2026a:<secret>`; `key_id` tidak boleh berawalan `dev` (ADR-017) |
| `TOTP_ENC_KEY` | ya | **tidak** | 64 hex, bukan nol semua; hilang = semua TOTP admin tidak dapat dibaca |
| `BCRYPT_COST` | ya | - | >= 10 (bawaan 12) |
| `WORKER_CONCURRENCY` | - | ya | >= 2 (bawaan 4) |
| `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST`, `OUTBOX_POLL_INTERVAL_MS`, `WORKER_SHUTDOWN_TIMEOUT_MS` | - | ya | bawaan 3001, 0.0.0.0, 2000, 25000 |

Build-time (bukan secret): `PUBLIC_API_URL` (situs publik), `VITE_API_BASE_URL` (web admin). Versi aplikasi minimum,
maintenance, tautan toko, dan kontak dukungan **tidak** diatur lewat env, tetapi lewat `app_settings` (langkah 4).

- [ ] Secret dibangkitkan acak, misalnya `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
      (64 hex, cocok untuk `TOTP_ENC_KEY` dan secret lain).
- [ ] Sandi role `kapdh_migrator`, `kapdh_app`, `kapdh_worker` dibangkitkan dan disimpan di password manager.
- [ ] Worker **tidak** diberi `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET`, `TOTP_ENC_KEY`, `QR_SIGNING_KEYS` (PRD 5.1).
- [ ] `TOTP_ENC_KEY`, `QR_SIGNING_KEYS` dan kunci backup juga disimpan di password manager dengan salinan cetak terpisah
      (D9); kehilangan `TOTP_ENC_KEY` memaksa reset MFA semua admin.

### 1.5 Backup di luar VPS (PRD 5.5; D2, D9)

- [ ] Tujuan backup object storage di luar VPS (mis. Cloudflare R2, Backblaze B2, atau penyedia VPS), retensi 30 hari.
- [ ] Backup harian terenkripsi: dump PostgreSQL + `/data/files` **termasuk** `ledger/account-deletions/` (ADR-014),
      dengan manifest (waktu, schema version, image version, checksum berkas, deletion ledger).
- [ ] Kunci backup disimpan terpisah dari salinan backup (password manager + salinan cetak, D9).
- [ ] **Gerbang langkah 1** **[bukti]**: backup database kosong (setelah langkah 2) direstore ke lingkungan bersih;
      `GET /api/v1/health/ready` = 200 pada hasil restore; jumlah migrasi tercatat sama. Prosedur restore lengkap
      (termasuk `account:ledger-reapply` sebelum layanan dibuka) mengikuti runbook backup/restore paket infra.

### 1.6 Monitoring (PRD 5.5; D9)

- [ ] Uptime Kuma (atau setara), alert ke Telegram/WhatsApp/email (D9):
  - `https://api.kapdh.or.id/api/v1/health` (liveness) dan `/api/v1/health/ready` (HTTP 200 **dan** `status = "ok"`;
    pantau `checks.outbox_oldest_pending_seconds`);
  - `https://kapdh.or.id/`, `https://admin.kapdh.or.id/`;
  - worker `GET /healthz` dari jaringan internal: alert bila `status != "ok"` (isu `dispatcher_failing`,
    `scheduler_failing`, `queue_unreachable`, `outbox_lagging`, ...), bukan hanya kode HTTP;
  - disk VPS: warning 60 %, critical 80 % (PRD 5.4); umur backup terakhir; umur job/outbox tertua; kegagalan provider
    (web admin, menu Notifikasi → Pengiriman).
- [ ] Log diagnostik retensi 30 hari tanpa PII (PRD 5.5). Error tracking (GlitchTip) belum terpasang di kode; bila
      ditambahkan, perbarui formulir privasi toko (`app-store-submission.md`).

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
  \q
  ```

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
  - `curl -s https://api.kapdh.or.id/api/v1/health/ready` → `{"status":"ok",...,"checks":{"database":"ok","redis":"ok","storage":"ok",...}}`;
  - worker `GET /healthz` → `"status":"ok"`, `"queue":{"ok":true,"driver":"bullmq"}`, scheduler `role: leader` pada
    satu instance;
  - `curl -s https://api.kapdh.or.id/api/v1/public/config` → `legal` masih `null` (halaman belum terbit).

  Catatan: readiness juga lulus pada database tanpa admin dan tanpa konfigurasi tersahkan (temuan audit D2-02); gerbang
  konfigurasi adalah pemeriksaan SQL di `go-live.md` bagian 2.

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
- [ ] **3.4 Pastikan worker dan SMTP berjalan** (undangan berikutnya dikirim email lewat outbox).
- [ ] **3.5 Super Admin kedua**: Super Admin pertama login → Manajemen Admin → Daftar Admin → undang dengan peran
      Super Admin (reautentikasi TOTP diminta). Penerima membuka tautan dari email `noreply@kapdh.or.id` dan
      menjalankan 3.2. Bila email tidak datang: web admin Notifikasi → Pengiriman → tab Outbox (event `failed`/`dead`,
      izin `notifications.manage`), worker `GET /healthz` dan log worker, lalu "Kirim ulang undangan" di halaman
      detail admin.
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
- [ ] **4.3 Nominal iuran D4** (Verifikasi Pembayaran → tab Biaya; `settings.manage` +
      reautentikasi): seed = registrasi Rp50.000, pembuatan KTA Rp10.000, perpanjangan Rp10.000. **BD** memeriksa dan
      menandatangani nilai yang tampil; bila berubah, ubah lewat web admin (versi `fees` naik, payment lama tetap
      memakai snapshot; ADR-006).
- [ ] **4.4 Metode bayar** (Verifikasi Pembayaran → tab Metode, `settings.manage` + reautentikasi): **BD** membuat
      rekening organisasi yang sah (bank, nomor, atas nama, instruksi). Tidak ada metode bayar di seed.
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

- [ ] **5.1 Provider email transaksional** dipilih DEV dari Amazon SES, Brevo, Mailgun, Resend atau Postmark (D10);
      kredensial SMTP di `SMTP_URL` (`smtp://user:pass@host:port` atau `smtps://...`).
- [ ] **5.2 Domain pengirim `noreply@kapdh.or.id`**: SPF (`include` provider), DKIM (record CNAME/TXT dari provider),
      DMARC (mulai `p=none; rua=mailto:<kotak-laporan>`, naikkan ke `quarantine` setelah laporan bersih).
      **[bukti]** header email uji menunjukkan `spf=pass`, `dkim=pass`, `dmarc=pass`.
- [ ] **5.3 FCM production**: proyek Firebase khusus production (staging terpisah, PRD 5.3); aplikasi Android
      `id.or.kapdh.app` dan iOS `id.or.kapdh.app` terdaftar; akun layanan dengan izin kirim FCM → `FCM_PROJECT_ID` dan
      `FCM_SERVICE_ACCOUNT_JSON` (API dan worker). Firebase hanya untuk FCM (ARCHITECTURE §2 butir 4).
- [ ] **5.4 APNs**: kunci APNs (.p8) dari akun Apple Developer organisasi diunggah ke proyek Firebase production;
      capability Push Notifications di App ID.
- [ ] **5.5 Nilai klien Firebase** (`FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_API_KEY`,
      `FIREBASE_ANDROID_APP_ID`, `FIREBASE_IOS_APP_ID`, `PUSH_ENABLED=true`) disimpan sebagai secret CI untuk build
      Flutter production (ADR-016); `kapdh-mobile/config/production.json` di repo tetap kosong.
- [ ] **5.6 Uji kirim** **[bukti]**: registrasi akun uji menerima OTP; akun uji di perangkat nyata menerima push
      (mis. notifikasi keputusan pembayaran). Kegagalan terlihat di web admin Notifikasi → Pengiriman.

## Langkah 6. Toko aplikasi (PRD 8.2 langkah 6; D10, D13, D16)

Ikuti `docs/runbooks/app-store-submission.md` bagian 1-5. Ringkas:

- [ ] Apple Developer Program dan Google Play Console atas nama organisasi (nomor D-U-N-S).
- [ ] Signing key Android (`android/key.properties`, tidak di-commit; Play App Signing) dan sertifikat/profil iOS.
- [ ] Listing, URL kebijakan privasi `https://kapdh.or.id/kebijakan-privasi`, formulir privasi/keamanan data,
      URL hapus akun `https://kapdh.or.id/delete-account`, kontak moderasi `bantuan@kapdh.or.id`.
- [ ] Akun demo reviewer (D16): aktif terverifikasi dan belum bayar, dibuat lewat alur resmi.

## Langkah 7. Gladi di staging (PRD 8.2 langkah 7; U-12)

- [ ] Hapus lingkungan staging (database, volume berkas, Redis) secara terkendali; catat waktu mulai.
- [ ] Jalankan langkah 1.3-5 dari nol dengan nilai staging (D12: `staging`, `staging-admin`, `staging-api`; proyek
      FCM staging). Seed dev **boleh** di staging hanya bila gladi ini tidak sedang membuktikan "tanpa fixture"; untuk
      U-12 jalankan tanpa seed dev.
- [ ] Smoke test semua peran memakai `docs/qa/uat-checklist.md` (minimal U-01, U-02, U-03, U-05, U-07, U-09, U-12).
- [ ] Backup pertama staging → restore ke lingkungan bersih → `account:ledger-reapply` → readiness 200 → login
      admin + MFA dan akun uji berhasil. Catat RPO/RTO yang teramati.
- [ ] **[bukti]** Laporan gladi: durasi tiap langkah, masalah dan perbaikannya, versi image/SDK/build Flutter.
- [ ] Sign-off gladi oleh PI (operasional, restore) dan QA (smoke test) di tabel `go-live.md` bagian 4.

## Lampiran A. Uji coba runbook (14 Oktober 2026)

Pada mesin build (Windows, tanpa Docker) perintah langkah 2 dan 3 diuji terhadap PostgreSQL 17.6 sementara dari paket
`embedded-postgres` (jalur uji), memakai `roles.sql`, role `kapdh_migrator`/`kapdh_app`/`kapdh_worker`, CLI dari
`pnpm build`: migrasi (8 diterapkan, ulang 0), `roles.sql` ulang, seed referensi (10/24/22/5, ulang 0), penolakan
`seed-dev.js` pada `NODE_ENV=production` (keluar 1), API `GET /api/v1/health`, `/health/ready` (200 tanpa Redis),
`/public/config`, worker `/healthz` (driver inline), CLI bootstrap (buat, terbit ulang, email lain, tanpa argumen →
keluar 2), CLI `ledger-reapply` pada folder kosong, dan blok SQL gerbang konfigurasi. **Belum diuji**: image Docker,
`psql` di kontainer, Coolify, Traefik/TLS/WSS, Redis/BullMQ nyata, SMTP/FCM nyata, backup/restore. Semuanya wajib
dibuktikan pada gladi staging (langkah 7).
