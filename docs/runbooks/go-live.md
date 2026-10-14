# Runbook: Gerbang rilis, go-live, dan rollback (PRD 8.3, 8.4, 9.3)

Rujukan: PRD 5.5, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 10.2; D1, D4, D8, D9, D13, D16; U-11, U-12.
Prasyarat: `docs/runbooks/production-init.md` selesai dan gladi staging (langkah 7) disetujui.
Bukti uji otomatis: `docs/qa/traceability.md`. UAT manual: `docs/qa/uat-checklist.md`. Toko aplikasi:
`docs/runbooks/app-store-submission.md`.

> D16: target go-live setelah Idulfitri 2027 (akhir Maret sampai April 2027), uji terbatas 2-3 minggu dengan pengurus
> dan 10-20 alumni (TestFlight dan closed testing), rilis bertahap. Dokumen ini tidak memuat persetujuan apa pun; setiap
> sign-off diisi pemegang peran pada tabel bagian 4 (PRD 9.3).

## 1. Membekukan kandidat rilis (PRD 8.3 langkah 1)

Isi tabel ini sebelum gerbang. Satu baris per artefak; nilai yang sama dipakai di staging dan production (image
API/worker identik; web/admin dibangun per lingkungan dari commit yang sama karena URL API ditanam saat build).

| Artefak | Nilai | Dicatat oleh |
| ------- | ----- | ------------ |
| Tag git rilis (`KAPDHAPPS`) | `vX.Y.Z` @ `<commit>` | DEV |
| Image API (digest) | `<registry>/kapdh-api@sha256:...` | DEV |
| Image worker (digest) | `<registry>/kapdh-worker@sha256:...` | DEV |
| Image situs publik (digest, production) | `<registry>/kapdh-web@sha256:...` | DEV |
| Build web admin (digest/artefak, production) | `...` | DEV |
| Versi skema (migrasi terakhir di journal) | `0007_auth_otp_decoys` atau yang lebih baru | DEV |
| Kontrak OpenAPI + SDK Dart | `contracts-vX.Y.Z` (`pnpm contracts:release-sdk`) | DEV |
| Repo Flutter (`git subtree split -P kapdh-mobile`) | `<commit repo Flutter>` | DEV |
| Build Android (AAB) | `versionName+versionCode` (pubspec `version: x.y.z+n`) | DEV |
| Build iOS (IPA) | `CFBundleShortVersionString (build)` | DEV |

- [ ] Verifikasi otomatis pada tag rilis, dari `kapdh-platform/` **[bukti: keluaran lengkap]**:
      `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:pg`,
      `pnpm contracts:lint`, `pnpm contracts:test-dart`, `pnpm format:check`; dari `kapdh-mobile/`: `flutter analyze`,
      `flutter test`. Semua lulus; perbedaan dari `docs/qa/traceability.md` dijelaskan.
- [ ] Build Flutter rilis memakai `--dart-define-from-file` dengan nilai production dari secret CI (ADR-016) dan
      `KAPDH_ENV=production`.

## 2. Gerbang go-live (PRD 9.3)

R1.0 diterima bila **semua** butir di bawah terpenuhi. Kekurangan minor boleh tersisa hanya dengan owner dan jadwal
yang disetujui, dan tidak boleh dipakai untuk mengecualikan keamanan atau integritas data.

### 2.1 Kualitas

- [ ] Seluruh AC wajib lulus pada staging yang menyerupai target: bukti otomatis (`traceability.md`: AC 86 covered,
      1 partial per audit Fase D) + UAT U-01..U-13 di `uat-checklist.md` berstatus Lulus dengan bukti.
- [ ] Tidak ada bug kritis/tinggi terbuka yang mengganggu identitas, uang, kuota, data privat, atau akses admin.
- [ ] Target N yang disahkan terbukti (D8). Alatnya sudah ada (uji beban/realtime `infra/loadtest/` +
      `docs/runbooks/load-test.md`, monitor `infra/monitoring/` + `docs/runbooks/monitoring.md`, backup/restore
      `infra/backup/` + `docs/runbooks/backup-restore.md`), tetapi belum ada laporan uji beban (N-01, N-04), latensi
      realtime (N-02), ketersediaan bulanan (N-05) maupun drill backup/restore RPO/RTO (N-06) dari staging/VPS nyata
      (temuan audit D2-03..D2-06, D2-08; templat bukti di `docs/qa/{load,availability,restore-drills}/`). Ini
      **memblokir** gerbang sampai laporan U-11 tersedia. N-06 lulus hanya bila drill restore membuktikan RPO <= 24 jam
      dan RTO <= 4 jam.
- [ ] Image API, release, worker, web dan admin dibangun CI dari tag rilis dan lulus uji asap image serta job
      `compose-stack` (`production-init.md` 1.3; `docs/runbooks/ci-cd.md`). Belum pernah dijalankan di GitHub.
- [ ] Teks aplikasi memenuhi D13 mitigasi 1 (`app-store-submission.md` bagian 2; per 14 Oktober 2026 belum).
- [ ] Skenario kritis PRD 9.2 nomor 1-10 lulus (`traceability.md` bagian 5.2); nomor 8 (restore + ledger) dibuktikan
      pada drill restore gladi, nomor 9 (konfigurasi belum disahkan) oleh gerbang `golive:check` mode enforce di job
      rilis (bagian 2.3).
- [ ] Penghapusan akun [R1]/[R2], moderasi UGC [R6], dan klasifikasi kanal iuran [R6]/[R7] diperiksa
      (`app-store-submission.md` bagian 7).

### 2.2 Paket penerimaan (PRD 9.3)

- [ ] Build Flutter Android/iOS; image API/worker/web (+ admin); OpenAPI (`dist/openapi.yaml` dari tag) dan SDK
      (`contracts-vX.Y.Z`); skema/migrasi (journal).
- [ ] Runbook: deploy/rilis, backup, restore, Compose cadangan (PRD 5.5), inisialisasi (`production-init.md`),
      rollback (bagian 5 di bawah), status akun `disabled` (`alumni-account-disabled.md`): `ci-cd.md`,
      `rilis-dan-gerbang-go-live.md`, `backup-restore.md`, `restore-backup.md` (sisi aplikasi, `account:ledger-reapply`
      sebagai langkah pemblokir), `compose-cadangan.md`, `monitoring.md`, `incident-response.md`. Semua tersedia;
      yang memblokir gerbang ini adalah gladinya (run CI/deploy pertama, drill restore, `production-init.md` 1.5).
- [ ] Laporan: UAT, uji beban/realtime, security (audit Fase D), restore (gladi).
- [ ] Halaman legal terbit dan `https://kapdh.or.id/delete-account` berfungsi.
- [ ] Akun pengurus dengan MFA: >= 2 Super Admin, >= 2 pemutus pembayaran.
- [ ] Daftar dependensi (lockfile, digest image) dan daftar pemegang akses (VPS/Coolify, registry, toko aplikasi,
      Firebase, provider email, DNS, password manager, backup) dengan cadangannya (D9).

### 2.3 Gerbang konfigurasi production (PRD 8.2 langkah 4, 9.2 skenario 9; U-12)

Gerbang otomatis `golive:check` (ADR-023; temuan audit D2-02 ditutup) dijalankan job rilis di setiap deploy
production dengan mode `enforce` dan menolak bila salah satu pemeriksaannya gagal (daftar dan perbaikannya:
`rilis-dan-gerbang-go-live.md` bagian 4). Lampirkan laporan JSON-nya (`node dist/cli/golive-check.js --json`) sebagai
**[bukti]**. Blok SQL berikut tetap dipakai sebagai pemeriksaan silang manual setelah langkah 4 inisialisasi; blok ini
diuji terhadap PostgreSQL 17 pada 14 Oktober 2026 (database dengan fixture dev, sehingga butir A terdeteksi).

```sh
docker exec -i <kontainer-postgres> psql -U postgres -d kapdh -X <<'SQL'
-- A. Fixture dev (target 0)
select count(*) as fixture_dev from (
  select 1 from app.users where email like '%.test'
  union all select 1 from app.alumni where full_name like '[Contoh]%'
  union all select 1 from app.payment_methods where provider like '%Contoh%'
  union all select 1 from app.posts where title like '[Contoh]%'
  union all select 1 from app.events where title like '[Contoh]%'
) f;
-- B. Super Admin dapat login + TOTP terverifikasi (target >= 2)
select count(*) as super_admin_totp
from app.admins a
join app.users u on u.id = a.user_id
join app.mfa_totp m on m.user_id = u.id and m.verified_at is not null
where a.role = 'super_admin' and a.status = 'active' and u.status = 'active';
-- C. Pemutus pembayaran aktif, termasuk Super Admin (target >= 2)
select count(distinct a.id) as pemutus_pembayaran
from app.admins a
join app.users u on u.id = a.user_id and u.status = 'active'
left join app.admin_permissions p on p.admin_id = a.id and p.permission = 'payments.decide'
where a.status = 'active' and (a.role = 'super_admin' or p.admin_id is not null);
-- D. Halaman belum terbit atau masih DRAF (target 0 baris) dan versi legal (target tidak null)
select slug from app.pages
where slug in ('kebijakan-privasi','ketentuan','ketentuan-komunitas','bantuan','tentang')
  and (published_body_html is null or published_body_html like '%<strong>DRAF</strong>%');
select value from app.app_settings where key = 'legal';
-- E. Master aktif (target > 0 masing-masing)
select (select count(*) from app.master_professions where active) as profesi_aktif,
       (select count(*) from app.master_skills where active) as keahlian_aktif;
-- F. Nominal, kontak, instruksi iuran, versi minimum, maintenance; metode bayar aktif (target >= 1)
select key, value, version from app.app_settings
where key in ('fees','support','payment_instructions','min_app_version','store_links','maintenance') order by key;
select count(*) as metode_aktif from app.payment_methods where active;
SQL
```

| Butir | Target | Hasil | Diperiksa |
| ----- | ------ | ----- | --------- |
| A fixture dev | 0 | | DEV |
| B Super Admin ber-TOTP | >= 2 | | SA |
| C pemutus pembayaran | >= 2 | | SA |
| D halaman DRAF/belum terbit | 0 baris; `legal` tiga versi terisi | | PP |
| E master aktif | > 0 dan sesuai daftar yang disahkan | | SA |
| F `fees` | sama dengan nilai yang ditandatangani BD; tidak ada Rp0 kecuali disahkan | | BD |
| F metode bayar | >= 1, rekening organisasi yang ditandatangani BD | | BD |
| F `support.whatsapp` | terisi nomor admin (PRD 8.3) | | SA |
| F `payment_instructions` | `[]` (fallback iOS belum aktif) | | PP |
| F `maintenance.active` | `false` saat dibuka | | SA |

Satu butir tidak memenuhi target = go-live ditunda (PRD 8.4).

### 2.4 Gerbang transport dan header (N-07; `production-init.md` 1.2)

Dijalankan PI dari luar VPS setelah langkah 1-5 inisialisasi; lampirkan keluaran lengkap **[bukti]**:

```sh
for u in https://kapdh.or.id/ https://www.kapdh.or.id/kebijakan-privasi https://admin.kapdh.or.id/ \
         https://api.kapdh.or.id/api/v1/health; do
  echo "== $u"; curl -sI "$u" | tr -d '\r' | grep -iE '^(HTTP/|location:|strict-transport-security:|content-security-policy:|x-frame-options:|x-content-type-options:|referrer-policy:|permissions-policy:)'
done
curl -si --max-time 5 --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://api.kapdh.or.id/socket.io/?EIO=4&transport=websocket" | head -1
```

Perintah ini diuji 14 Oktober 2026 hanya terhadap API lokal tanpa TLS (penyaring header dan cek WebSocket `101`);
hasil pada host production/staging belum pernah diamati.

| Host | Target | Hasil | Diperiksa |
| ---- | ------ | ----- | --------- |
| `kapdh.or.id` | 200; `strict-transport-security` (max-age >= 31536000); CSP dengan `frame-ancestors 'none'`; `x-content-type-options: nosniff`; `referrer-policy: no-referrer` | | PI |
| `www.kapdh.or.id` | 301, `location: https://kapdh.or.id/kebijakan-privasi` | | PI |
| `admin.kapdh.or.id` | 200; `strict-transport-security`; CSP dengan `frame-ancestors 'none'` dan `connect-src` ke API; `x-frame-options: DENY`; `nosniff`; `referrer-policy: no-referrer` | | PI |
| `api.kapdh.or.id` | 200; `strict-transport-security` (`HSTS_ENABLED=true`); `nosniff`; `referrer-policy: no-referrer` | | PI |
| WSS `api.kapdh.or.id/socket.io/` | `HTTP/1.1 101 Switching Protocols` | | PI |
| Port 5432/6379 dari luar | tertutup (`production-init.md` 1.1) | | PI |

## 3. Urutan go-live (PRD 8.3)

| No | Langkah PRD 8.3 | Tindakan | Pelaksana | Bukti |
| -- | --------------- | -------- | --------- | ----- |
| 1 | Bekukan tag image, SDK, build Flutter | Tabel bagian 1 lengkap; gerbang bagian 2 lulus | DEV, QA | tabel + keluaran verifikasi |
| 2 | Inisialisasi production + backup pertama dapat direstore | `production-init.md` langkah 1-5; backup pertama direstore ke lingkungan bersih mengikuti `restore-backup.md` (`account:ledger-reapply` pada folder ledger kosong = 0 entri), readiness 200 dengan `"deletion_ledger": "ok"`; gerbang 2.4 lulus | PI | log restore, keluaran 2.4 |
| 3 | Smoke test production dengan akun uji | Lihat 3.1; data uji dihapus lewat alur penghapusan resmi atau ditandai dan dikecualikan dari metrik | QA, SA, BD | daftar periksa 3.1 bertanda tangan |
| 4 | Kirim build ke review toko terhadap backend production aktif | `app-store-submission.md` bagian 5; pendaftaran boleh terbuka, **pengumuman menunggu persetujuan toko** | DEV, PP | ID submission |
| 5 | Rilis bertahap, buka web admin, umumkan | Staged rollout Google Play, phased release App Store; isi Pengaturan → Tautan toko (`store_links`); akun pengurus dibagikan; pengumuman lewat grup WhatsApp alumni, `kapdh.or.id`, media sosial resmi; kanal dukungan `bantuan@kapdh.or.id` + satu WhatsApp admin | PP, SA | tangkapan layar pengumuman |
| 6 | Pantau ketat minggu pertama | Bagian 3.2 | PI, SA, BD | catatan harian |

### 3.1 Smoke test production (PRD 8.3 langkah 3)

Pakai akun uji milik organisasi (email yang dikendalikan organisasi; jangan `.test`). Setiap baris: hasil, waktu,
pelaksana. Langkah rinci per peran ada di `uat-checklist.md` (U-01, U-02, U-03, U-05, U-07, U-08, U-09).

- [ ] **Login/MFA**: admin login sandi + TOTP; idle/logout; anggota uji registrasi → OTP email diterima → login.
- [ ] **Payment/periode**: anggota uji membuat instruksi iuran, unggah bukti; BD menyetujui; KTA aktif dengan periode
      12 bulan dari waktu persetujuan; notifikasi inbox + push + email diterima.
- [ ] **Kartu/verifikasi publik**: KTA tampil; pindai QR → `https://kapdh.or.id/kta/<nomor>#t=...` menampilkan status
      terkini.
- [ ] **Tiket/scan**: event uji (gratis atau berbayar Rp minimal yang disahkan BD) → reservasi → tiket QR → check-in di
      `/events/checkin` → pindai kedua ditolak.
- [ ] **Chat**: dua akun uji, direct chat, pesan diterima realtime (WSS lewat Traefik), gambar chat privat.
- [ ] **Berkas**: URL bukti transfer kedaluwarsa <= 10 menit; tidak dapat dibuka akun lain.
- [ ] **Push**: Android dan iOS menerima push; ketukan membuka rute yang benar.
- [ ] **Penghapusan**: satu akun uji dihapus dari aplikasi, satu lewat `https://kapdh.or.id/delete-account`; job
      `account.deletion` selesai; entri ledger tertulis di `/data/files/ledger/account-deletions/`.
- [ ] **Data uji**: payment uji yang disetujui tercatat di daftar "data uji go-live" (id, nominal) untuk dikecualikan
      dari metrik; refund/penyesuaian bila uang nyata dipakai diproses BD lewat Penyesuaian.

### 3.2 Pemantauan minggu pertama (PRD 8.3 langkah 6)

Harian (pagi dan sore) selama 7 hari, dicatat:

- [ ] Uptime API/web/admin, readiness `status=ok`, worker `/healthz` tanpa isu.
- [ ] Dasbor web admin: antrean verifikasi pembayaran dan yang lewat batas review (`/payments?stage=awaiting_review&overdue=true`),
      laporan moderasi terbuka, kegagalan pengiriman notifikasi (badge Notifikasi), outbox `failed`/`dead`.
- [ ] Disk (< 60 %), umur backup terakhir (< 24 jam), umur event outbox pending tertua.
- [ ] Email bounce/complaint di dasbor provider; laporan DMARC.
- [ ] Ulasan toko dan pertanyaan di kanal dukungan; insiden dicatat dengan ID dan tindak lanjut.

## 4. Sign-off (PRD 9.3)

Tidak ada sign-off yang dianggap telah diberikan oleh dokumen ini. Setiap perubahan kebutuhan setelah persetujuan
mencatat ID, alasan, dampak pada AC/data/jadwal, dan versi PRD baru.

| Peran | Nama | Yang disetujui | Bukti yang ditinjau | Keputusan (setuju/tolak + catatan) | Tanggal | Tanda tangan |
| ----- | ---- | -------------- | ------------------- | ---------------------------------- | ------- | ------------ |
| Pemilik produk | | Cakupan R1.0, kebijakan (legal, privasi, komunitas), sisa teknis D1 (ADR-011), positioning iuran D13, jadwal D16 | Paket penerimaan, `uat-checklist.md`, `app-store-submission.md` | | | |
| Bendahara | | Nominal `fees` (D4), metode bayar dan rekening, prosedur refund D6 | Gerbang 2.3 butir F, layar Biaya/Metode | | | |
| QA | | Hasil UAT U-01..U-13, smoke test production 3.1 | `uat-checklist.md`, `traceability.md` | | | |
| Pengelola infra | | Restore dan operasional: backup harian terenkripsi di luar VPS, restore teruji dengan RPO <= 24 jam dan RTO <= 4 jam (N-06), drill restore bulanan terjadwal, monitor dan alert (HTTP, WS, DB, disk, umur backup, outbox, kegagalan provider), header/HSTS (2.4), Compose cadangan, akses (D9) | Laporan gladi, laporan restore, U-11, keluaran 2.4 | | | |
| Super Admin (D1) | | Akun pengurus ber-MFA, izin, Super Admin kedua | Gerbang 2.3 butir B/C | | | |
| Pengembang | | Verifikasi otomatis tag rilis, artefak bagian 1 | Keluaran bagian 1 | | | |

## 5. Rollback dan pemulihan setelah go-live (PRD 8.4)

Prinsip: rollback image **tidak** membalik skema maupun data (PRD 5.5). Restore dari backup setelah ada transaksi baru
menghilangkan data sesudah titik backup; perlu pemeriksaan dan komunikasi kepada pengguna terdampak.

| Titik kegagalan | Tindakan yang diperbolehkan | Langkah konkret | Keputusan oleh |
| --------------- | --------------------------- | --------------- | -------------- |
| Gagal sebelum ada data pengguna nyata | Hentikan layanan, perbaiki, reset production terkendali, jalankan ulang inisialisasi | Skala API/worker ke 0; hapus lalu buat ulang database kosong `docker exec -i <kontainer-postgres> psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -c 'drop database if exists kapdh with (force)' -c 'create database kapdh'` (role tingkat cluster tetap; grant diterapkan ulang `roles.sql` di langkah 2); kosongkan `/data/files` (termasuk `ledger/`) dan Redis production (catat siapa/kapan); perbaiki; `production-init.md` langkah 2-4 dari nol; bootstrap Super Admin diulang | PP + PI |
| Bug kritis setelah ada data pengguna | Forward-fix dan hotfix; maintenance read-only bila integritas data terancam | (1) Pengaturan → Maintenance: aktif + pesan + perkiraan selesai. Semua mutasi ditolak 503 `MAINTENANCE`, **termasuk login dan registrasi anggota**, kecuali `/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `DELETE /auth/sessions/{id}`, `/admin/**`, `POST /public/kta/verify`, serta `POST /auth/reauth` dan `POST /files` dengan token admin (`apps/api/src/core/http/request-gate.ts`); semua GET tetap jalan. (2) Hotfix dari tag rilis → CI → staging → production (job migrasi bila ada migrasi aditif). (3) Bug Flutter: rilis versi perbaikan; naikkan `min_app_version` **hanya setelah** versi baru dapat diunduh di kedua toko | PP + DEV |
| Perubahan skema tidak kompatibel dengan image sebelumnya | Jangan menganggap rollback image memulihkan skema; gunakan runbook kompatibilitas/restore dan pertimbangkan RPO nyata | Migrasi bersifat aditif dan kompatibel ke belakang bila memungkinkan; bila image baru harus ditarik, perbaiki maju (migrasi baru) atau restore ke backup sebelum migrasi dengan menerima kehilangan data sejak backup itu | PP + PI + DEV |
| Data/berkas hilang atau rusak | Restore DB + berkas dengan manifest yang sama, terapkan deletion ledger dan replay outbox, periksa konsistensi sebelum dibuka | Ikuti `docs/runbooks/restore-backup.md` secara berurutan. Ringkas: (1) Skala API **dan** worker ke 0 di Coolify selama seluruh restore. Jangan mengandalkan mode maintenance: flag-nya ada di `app_settings` dan ikut tertimpa nilai backup (biasanya `active=false`), sehingga API yang tetap hidup akan menerima login dan mutasi pada database pulihan sebelum ledger diterapkan. (2) **Sebelum menyentuh storage**, salin seluruh awalan `ledger/` dari `/data/files` yang berjalan ke folder terpisah hanya-baca, mis. `cp -a /data/files/ledger /restore/ledger-latest/` (bila storage hilang: salinan ledger dari manifest backup terbaru yang tidak lebih tua dari dump). (3) Restore dump, jalankan job migrasi, terapkan ulang `roles.sql`; Redis boleh dikosongkan. (4) Restore `/data/files` dari manifest yang sama, lalu kembalikan salinan ledger langkah 2 ke atasnya. (5) Opsional tetapi dianjurkan: aktifkan maintenance lewat SQL sebelum API dinyalakan agar pemeriksaan pasca-restore dilakukan sebelum anggota dapat mutasi: `update app.app_settings set value = jsonb_set(value, '{active}', 'true'), version = version + 1, updated_at = now() where key = 'maintenance';` (catat di laporan; tidak membuat entri audit). (6) Terapkan ulang deletion ledger dari image API dengan env **worker** (login `kapdh_worker`): `docker run --rm --network <jaringan> --env-file <env-worker> -v <dir-berkas-host>:/data/files -v /restore/ledger-latest/ledger/account-deletions:/restore/ledger:ro <registry>/kapdh-api:<tag> node dist/modules/account/ledger-reapply.cli.js --dir /restore/ledger`; lanjut hanya bila baris `Gagal` bernilai 0 (keluar 0; ADR-014). (7) Nyalakan satu replika API; `GET /api/v1/health/ready` harus 200 dengan `"deletion_ledger": "ok"`. (8) Nyalakan worker dan replika lain; event outbox `pending`/`failed` diproses ulang otomatis; `dead` dicoba lagi dari web admin Notifikasi → tab Outbox. (9) Periksa: login + MFA admin, jumlah anggota per status, total payment `paid`, tiket, chat, berkas sampel, penghapusan terdahulu tetap terhapus (kueri `restore-backup.md` langkah 8). (10) Matikan maintenance dari web admin, buka layanan, komunikasikan ke pengguna terdampak. Diuji di mesin build: flag maintenance yang diaktifkan lewat SQL menolak login 503 `MAINTENANCE`; urutan restore lengkap belum pernah dijalankan pada image/VPS | PI + PP |
| Redis atau worker gagal | Status/notifikasi tertunda, bukan hilang (PRD 5.1) | Pulihkan Redis/worker; worker keluar bila Redis tidak siap 30 detik dan dijalankan ulang orkestrator; antrean dibangun ulang dari outbox | PI |
| Toko menolak (pembayaran/UGC/penghapusan) | Perbaiki listing/catatan reviewer atau aktifkan rencana cadangan iOS D13 | `app-store-submission.md` bagian 6 dan 8 | PP |

Alasan menunda go-live (PRD 8.4): kegagalan login, salah status/nominal, paparan berkas privat, oversell, gagal MFA,
atau konfigurasi production yang belum disahkan.
