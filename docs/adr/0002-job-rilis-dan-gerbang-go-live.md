# ADR-0002: Job rilis dalam image tersendiri dan gerbang go-live sebagai CLI

- Status: diusulkan (Fase E, menunggu pembuktian di staging)
- Tanggal: 14 Oktober 2026
- Rujukan: PRD 5.3, 5.5, 7.1, 8.2, 8.3, 8.4, 9.2, 9.3, 10.2; D1, D4, D7, D9, D12, D13; U-12; temuan audit D2-02, D4-01,
  D2-07, D3-07.

## Konteks

PRD 5.5 mewajibkan migrasi skema oleh **satu job deployment dengan lock**, bukan oleh setiap replica API/worker.
Paket `@kapdh/database` sudah menyediakan CLI migrasi dengan `pg_advisory_lock`, tetapi `infra/db/roles.sql` (role dan
grant, termasuk tabel append-only dan `mfa_totp`) harus dijalankan superuser sebelum dan sesudah setiap migrasi, dan
seed referensi harus diulang untuk kunci `app_settings` baru. PRD 9.2 juga mewajibkan skenario "production dideploy
dengan konfigurasi yang belum disahkan (nominal kosong, fixture dev, atau tanpa Super Admin ber-TOTP); gerbang
menolak go-live", sedangkan audit Fase D (D2-02, D4-01) menemukan bahwa gerbang itu belum ada: `/health/ready` lulus
pada database tanpa pengurus dan tanpa biaya.

## Keputusan

1. **Image `kapdh-release`** (target `release` di `infra/Dockerfile.api`) = runtime API yang sama + psql 17 + SQL role +
   `infra/scripts/release-job.sh`. Urutan tetap: tunggu DB → `roles.sql` → sandi role dari env (`\getenv`) → migrasi
   sebagai `kapdh_migrator` → `roles.sql` → seed referensi → gerbang go-live. Image API sendiri tidak memuat psql dan
   tidak pernah memegang kredensial superuser atau migrator.
2. Di jalur Coolify, job dijalankan operator di VPS lewat `infra/scripts/run-release.sh` (berkas env 600) sebelum
   redeploy API/worker; di Compose cadangan lewat service `release` ber-profile. CI tidak memerlukan akses SSH ke VPS
   (PRD 5.3: SSH hanya dari IP tepercaya/VPN).
3. **Gerbang go-live = CLI baca-saja** `golive:check` (`apps/api/src/cli/golive-gate.ts`), bukan aturan
   `/health/ready`. Konfigurasi yang belum disahkan adalah alasan menunda go-live atau promosi image (PRD 8.4), bukan
   alasan mengeluarkan API yang sedang melayani anggota dari load balancer; pemeriksaan kesehatan tetap murni
   dependensi. Job rilis menjalankan gerbang setiap rilis: `enforce` di production (job gagal, image tidak
   dipromosikan), `report` di staging, dan `report` di production hanya untuk inisialisasi pertama sebelum bootstrap
   Super Admin.
4. Kriteria "tersahkan" yang dapat diperiksa mesin: nominal D4 (disahkan PRD v3.3) atau nominal yang ditetapkan pengurus
   lewat web admin (`updated_by_admin_id` + audit), tidak ada Rp0; metode bayar aktif dibuat lewat web admin (audit
   `payment_method.created`) dan bukan contoh; >= 2 Super Admin aktif ber-TOTP dan >= 2 pemutus pembayaran (PRD 8.2
   langkah 3, 2.3); halaman legal/bantuan terbit tanpa kerangka DRAF dan sinkron dengan `app_settings.legal`; master
   aktif; WhatsApp dukungan; tanpa fixture dev; skema sama dengan journal image. Tanda tangan manusia (bendahara, QA,
   pengurus, infra; PRD 9.3) tetap di paket bukti: laporan gerbang mencetak nominal dan rekening tersamar untuk itu.
5. Web admin dilayani nginx dengan CSP ketat (`script-src`/`style-src 'self'`, `frame-ancestors 'none'`); karenanya
   TipTap dijalankan dengan `injectCSS: false` dan aturan dasar ProseMirror dipindah ke `apps/admin/src/styles.css`.
   Origin API CSP dirender saat build dari `VITE_API_BASE_URL`, sehingga image web/admin dibangun per lingkungan dari
   commit yang sama (varian `-staging`), sedangkan image api/worker/release identik untuk kedua lingkungan.

## Konsekuensi

- Satu langkah manual (atau otomatisasi di VPS) per rilis sebelum redeploy Coolify; dicatat di runbook rilis.
- Superuser PostgreSQL hanya ada di berkas env job rilis. Dua job rilis bersamaan aman untuk migrasi (advisory lock)
  tetapi GRANT bersamaan dapat gagal dan harus diulang; operator menjalankan satu job pada satu waktu.
- Gerbang memeriksa keadaan data, bukan niat: misalnya metode bayar yang dibuat lewat web admin tetap memerlukan
  tanda tangan bendahara pada laporan. Aturan baru (mis. bila nominal Rp0 kelak disahkan) memerlukan perubahan PRD dan
  kode gerbang.
- Belum terbukti tanpa Docker: build image, psql di image rilis, perilaku Coolify (nama jaringan/host DB, mount
  direktori bersama), CSP admin di peramban nyata. Daftar lengkap: runbook rilis bagian 7.
