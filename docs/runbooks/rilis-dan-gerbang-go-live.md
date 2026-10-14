# Runbook: rilis, inisialisasi production, dan gerbang go-live

Rujukan: PRD 5.3, 5.5, 7.1, 8.2, 8.3, 8.4, 9.2, 9.3, 10.2; D1, D4, D7, D9, D10, D12, D13, D16; U-12.
Artefak: `kapdh-platform/infra/` (lihat `infra/README.md`). Keputusan desain: `docs/adr/0002-job-rilis-dan-gerbang-go-live.md`.
Jalur saat panel Coolify mati: `docs/runbooks/compose-cadangan.md`.

> Tidak ada tanda tangan yang dianggap sudah diberikan oleh dokumen ini (PRD 9.3). Setiap langkah bertanda **[bukti]**
> menghasilkan keluaran yang disimpan pada paket bukti gerbang rilis.

## 1. Alur ringkas

```
push main ──CI (ci.yml + images.yml)──► ghcr.io/<org>/kapdh-*:sha-<commit12>
                                            │
              staging: run-release.sh staging → redeploy Coolify (tag sha) → staging-smoke.sh
                                            │  QA/UAT lulus, gerbang rilis disetujui
tag vX.Y.Z ──promote (digest sama)──► kapdh-*:vX.Y.Z
                                            │
           production: run-release.sh production (RELEASE_GATE=enforce) → redeploy Coolify (tag versi) → smoke
```

- Image **api, worker, release** sama persis untuk staging dan production. **web/admin** dibangun per lingkungan dari
  commit yang sama (URL API dibakukan saat build): `...:<tag>` untuk production, `...:<tag>-staging` untuk staging.
- Migrasi hanya oleh job rilis (`kapdh-release`), satu kali per rilis, sebelum API/worker baru berjalan (PRD 5.5).
- Perubahan skema harus kompatibel dengan image sebelumnya bila memungkinkan; rollback image tidak membalik skema
  (PRD 8.4). Gerbang menolak image yang lebih lama dari skema (`schema`).

## 2. Persiapan sekali per lingkungan (PRD 8.2 langkah 1)

Lakukan untuk **staging dulu**, lalu production. Keduanya terpisah penuh (D12, PRD 5.3): project Coolify, database,
user DB, Redis, direktori berkas, secret, domain dan proyek FCM.

1. **VPS dan firewall** (D7, D9): hanya 80/443 publik; SSH 22 dari IP tepercaya/VPN dengan key; panel Coolify di
   subdomain sendiri dengan 2FA; port 8000/6001/6002 tidak dibuka langsung.
2. **Direktori berkas** (PRD 5.4): `sudo install -d -o 1000 -g 1000 -m 750 /srv/kapdh/<lingkungan>/files`.
   Dipasang di `/data/files` pada resource API **dan** worker (mount direktori host yang sama). Dicadangkan restic harian.
3. **Resource Coolify per lingkungan** (label menu dapat berbeda per versi Coolify; verifikasi saat gladi staging):
   - PostgreSQL 17 (`postgres:17.11-alpine3.24`), database `kapdh`, superuser `postgres` dengan sandi acak. Tanpa
     port publik.
   - Redis 7 (`redis:7.4.11-alpine3.21`) dengan sandi, `appendonly yes`, `maxmemory-policy noeviction`. Tanpa port
     publik.
   - Aplikasi dari image registry: `kapdh-api` (domain `api.` / `staging-api.`, port 3000, healthcheck
     `/api/v1/health`), `kapdh-worker` (tanpa domain, healthcheck `/healthz` port 3001), `kapdh-web` (domain
     `kapdh.or.id` + `www` / `staging.`, port 8080), `kapdh-admin` (domain `admin.` / `staging-admin.`, port 8080).
   - Environment variable dari `infra/.env.<lingkungan>.example` bagian A (API) dan worker; `DATABASE_URL`/`REDIS_URL`
     ditulis lengkap per resource (bagian B): API memakai login `kapdh_app`, worker `kapdh_worker`. Worker TIDAK diberi
     `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET`, `TOTP_ENC_KEY`, `QR_SIGNING_KEYS` (PRD 5.1).
   - Stop grace period: API >= 30 detik, worker >= 40 detik. Batas memori mengikuti `infra/compose.production.yml`.
4. **Berkas env job rilis** di VPS (root, mode 600, tidak pernah di repo):
   `/etc/kapdh/<lingkungan>/release.env`

   ```
   ADMIN_DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD>@<host-postgres-coolify>:5432/kapdh
   MIGRATOR_DATABASE_URL=postgres://kapdh_migrator:<KAPDH_MIGRATOR_DB_PASSWORD>@<host-postgres-coolify>:5432/kapdh
   KAPDH_MIGRATOR_DB_PASSWORD=<hex>
   KAPDH_APP_DB_PASSWORD=<hex, sama dengan di DATABASE_URL API>
   KAPDH_WORKER_DB_PASSWORD=<hex, sama dengan di DATABASE_URL worker>
   ```

   `<host-postgres-coolify>` = nama host internal resource PostgreSQL pada jaringan Docker Coolify. `run-release.sh`
   memakai jaringan `coolify` (ubah dengan `KAPDH_DOCKER_NETWORK` bila resource berada di jaringan project lain).
5. **DNS** (D12): A/AAAA untuk `kapdh.or.id`, `www`, `admin`, `api` (dan `staging`, `staging-admin`,
   `staging-api`) ke VPS. SPF/DKIM/DMARC untuk `noreply@kapdh.or.id` (D10).
6. **Backup** sebelum data pengguna pertama: backup dan restore dari database kosong dibuktikan (PRD 8.2 langkah 1;
   runbook backup/restore).

## 3. Rilis ke staging (setiap push main yang lolos CI)

1. Catat tag `sha-<commit12>` dari workflow Images.
2. Job rilis **[bukti]**:

   ```bash
   sudo sh kapdh-platform/infra/scripts/run-release.sh staging ghcr.io/<org>/kapdh-release:sha-<commit12>
   ```

   Staging memakai mode gerbang `report`: laporan gerbang tercetak, job tetap lulus (data sintetis/fixture boleh).
   Job gagal bila migrasi, `roles.sql` atau seed gagal: jangan redeploy aplikasi; periksa log, perbaiki, ulangi.
3. Di Coolify: ubah tag image API dan worker ke `sha-<commit12>`, web dan admin ke `sha-<commit12>-staging`; redeploy
   (API dan worker dahulu, lalu web/admin).
4. Uji asap dari luar VPS **[bukti]**:

   ```bash
   KAPDH_WEB=staging.kapdh.or.id KAPDH_ADMIN=staging-admin.kapdh.or.id KAPDH_API=staging-api.kapdh.or.id \
     KAPDH_VPS_HOST=<ip-vps> sh kapdh-platform/infra/scripts/staging-smoke.sh
   ```

   Ditambah SSL Labs untuk ketiga domain, dan `docker exec <worker> wget -qO- http://127.0.0.1:3001/healthz` → `ok`.

## 4. Inisialisasi production pertama (PRD 8.2) dan go-live (PRD 8.3)

Gladi seluruh bagian ini dijalankan lebih dahulu dari **database staging kosong** dengan `RELEASE_GATE=enforce` sampai
gerbang lulus (PRD 8.2 langkah 7), lalu staging boleh kembali ke data sintetis.

1. **Bekukan versi** (PRD 8.3 langkah 1): tag `vX.Y.Z` → workflow Images mempromosikan digest yang sama.
2. **Skema + seed referensi** (PRD 8.2 langkah 2 dan 4). Database production masih kosong dan belum dikonfigurasi,
   sehingga hanya inisialisasi pertama ini memakai mode laporan **[bukti]**:

   ```bash
   sudo RELEASE_GATE=report sh kapdh-platform/infra/scripts/run-release.sh production ghcr.io/<org>/kapdh-release:vX.Y.Z
   ```

   Job mencetak peringatan mode laporan di production. Seed dev TIDAK pernah dijalankan di production (`seed:dev`
   menolak `NODE_ENV=production`; gerbang menolak jejaknya).
3. **Deploy aplikasi** dengan tag `vX.Y.Z` di Coolify (API, worker, web, admin). Pendaftaran anggota masih tertutup
   (registrasi 409 sampai halaman legal terbit).
4. **Bootstrap Super Admin pertama** (PRD 8.2 langkah 3, D1) di kontainer API production (CLI, bukan endpoint):

   ```bash
   docker exec -it <kontainer-api-production> node dist/cli/bootstrap-admin.js --email <email> --name "Bayu Musthafa"
   ```

   Tautan `https://admin.kapdh.or.id/invite#t=...` hanya tampil sekali (72 jam). Pemilik membuka tautan, mengganti sandi
   awal, mendaftarkan TOTP dan menyimpan backup code. **Super Admin kedua** diundang dari web admin (menu Admin) dan
   menyelesaikan TOTP. Minimal dua pengurus dapat memutus pembayaran (PRD 2.3; Super Admin terhitung).
5. **Konfigurasi oleh pengurus** di web admin (PRD 8.2 langkah 4):
   - Biaya (tab Biaya): bendahara meninjau nilai D4 (Rp50.000 + Rp10.000; perpanjangan Rp10.000). Perubahan nominal
     hanya lewat web admin (tercatat `updated_by` + audit).
   - Metode bayar: rekening organisasi dibuat lewat web admin (tercatat audit `payment_method.created`).
   - Halaman kebijakan privasi, ketentuan, ketentuan komunitas, bantuan: naskah resmi diterbitkan.
   - Master profesi/keahlian: daftar usulan ditinjau dan diaktifkan.
   - Pengaturan dukungan: email bantuan dan satu nomor WhatsApp admin (PRD 8.3).
6. **Layanan eksternal** (PRD 8.2 langkah 5): FCM/APNs production, provider email (D10) dengan SPF/DKIM/DMARC lulus.
7. **Gerbang go-live** (PRD 9.2, 9.3) — wajib lulus, tidak ada mode lain **[bukti]**:

   ```bash
   sudo RELEASE_GATE=enforce sh kapdh-platform/infra/scripts/run-release.sh production ghcr.io/<org>/kapdh-release:vX.Y.Z
   # laporan JSON untuk arsip bukti:
   sudo docker run --rm --network coolify --env-file /etc/kapdh/production/release.env --entrypoint sh \
     ghcr.io/<org>/kapdh-release:vX.Y.Z -c 'DATABASE_URL="$MIGRATOR_DATABASE_URL" node dist/cli/golive-check.js --json' \
     > golive-vX.Y.Z.json
   ```

   Job ulang ini idempoten (tidak ada migrasi baru, seed tidak menimpa nilai pengurus). Kode keluar 1 = ditolak:
   perbaiki penyebab yang tercetak (tabel di bawah), lalu ulangi. Laporan memuat nominal dan rekening tersamar yang
   **ditandatangani bendahara**; Super Admin, QA dan pengelola infra menandatangani paket bukti (PRD 9.3).
8. **Backup pertama** dibuat dan direstore ke lingkungan bersih (PRD 8.3 langkah 2).
9. **Smoke production** (PRD 8.3 langkah 3) dengan akun uji, `staging-smoke.sh` terhadap domain production, lalu
   lanjutkan review toko dan rilis bertahap (PRD 8.3 langkah 4-6, D16).

### Penyebab penolakan gerbang dan perbaikannya

| Pemeriksaan | Ditolak bila | Perbaikan |
| ----------- | ------------ | --------- |
| `schema` | migrasi tercatat < journal image (skema tertinggal) atau > (image lebih lama dari skema) | jalankan job rilis image yang benar; jangan promosikan image lama ke skema baru |
| `settings` | kunci `app_settings` belum tersimpan (API memakai bawaan versi 0) atau tidak valid | job rilis (seed referensi) |
| `fees` | baris `fees` tidak ada, ada nominal Rp0, atau nominal di luar D4 tanpa `updated_by` pengurus | tetapkan lewat web admin (tab Biaya) |
| `payment_methods` | tidak ada metode aktif, metode contoh/rekening nol, atau metode tanpa audit pembuatan web admin | buat metode lewat web admin; nonaktifkan yang lain |
| `super_admins` | < 2 Super Admin aktif (admin dan akun `active`) dengan TOTP terverifikasi | bootstrap/undang, selesaikan TOTP |
| `payment_deciders` | < 2 pengurus ber-TOTP dengan `payments.read` + `payments.decide` (Super Admin terhitung) | beri izin di menu Admin |
| `legal_pages` | halaman wajib belum terbit, masih kerangka DRAF, atau `app_settings.legal` tidak sama dengan versi tayang | terbitkan naskah resmi lewat web admin |
| `masters` | tidak ada profesi atau keahlian aktif | aktifkan master yang disahkan |
| `support_contact` | WhatsApp dukungan kosong | isi di Pengaturan |
| `dev_fixtures` | jejak `seed:dev`, id `DEV_IDS`, akun aktif ber-email `.test/.example/.invalid/.localhost`, judul/nama `[Contoh]` | production dimulai dari database kosong: reset terkendali lalu inisialisasi ulang (PRD 8.4) |

## 5. Rilis production berikutnya

1. Tag `vX.Y.Z` (sudah lulus di staging) → promosi.
2. `sudo sh kapdh-platform/infra/scripts/run-release.sh production ghcr.io/<org>/kapdh-release:vX.Y.Z` (bawaan
   `enforce`). Bila gerbang menolak, **hentikan**: API/worker lama tetap berjalan; perbaiki konfigurasi lebih dulu.
3. Redeploy API dan worker (tag `vX.Y.Z`), lalu web dan admin (tag `vX.Y.Z`). Uji asap production.

## 6. Rollback dan pemulihan (PRD 8.4)

- Image dapat dikembalikan ke tag sebelumnya hanya bila skema masih kompatibel. Gerbang (`schema`) menolak image yang
  lebih lama dari skema; gunakan runbook kompatibilitas/restore dan pertimbangkan RPO nyata.
- Bug kritis setelah ada data: forward-fix; mode maintenance read-only (`app_settings.maintenance`) bila integritas data
  terancam.
- Restore DB + berkas memakai manifest yang sama, lalu `node dist/modules/account/ledger-reapply.cli.js --dir ...`
  sebelum layanan dibuka (deletion ledger, AC F14-6), kemudian job rilis dan gerbang.

## 7. Wajib dibuktikan pada staging nyata (belum dapat diuji di mesin build tanpa Docker)

- Build semua image dan workflow `images.yml` hijau (termasuk stack Compose di CI).
- `psql` di image rilis menjalankan `roles.sql` dan `role-passwords.sql` (`\getenv`, `\if`) terhadap PostgreSQL 17.
- `run-release.sh` dengan nama host/jaringan PostgreSQL resource Coolify yang sebenarnya.
- TLS grade (SSL Labs), pengalihan HTTP→HTTPS, upgrade WSS `/socket.io/`, port 5432/6379/3000/3001/8000 tertutup dari
  internet (`staging-smoke.sh`).
- Batas memori/CPU di bawah beban (N-01..N-04) dan heap Node (`--max-old-space-size`).
- Web admin di peramban nyata dengan CSP production: login, TOTP, editor berita (TipTap tanpa `<style>` sisipan),
  pratinjau unggahan (`blob:`), QR TOTP (`data:`), pemindai check-in (kamera).
