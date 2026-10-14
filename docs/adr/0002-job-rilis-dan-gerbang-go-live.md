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
   `infra/scripts/release-job.sh`. Urutan tetap: tunggu DB → cek versi skema → `roles.sql` → sandi role dari env
   (`\getenv`) → gerbang pra-migrasi (mode `enforce`) → migrasi sebagai `kapdh_migrator` → `roles.sql` → seed referensi
   → gerbang go-live penuh. Image API sendiri tidak memuat psql dan tidak pernah memegang kredensial superuser atau
   migrator.
2. Di jalur Coolify, job dijalankan operator di VPS lewat `infra/scripts/run-release.sh` (berkas env 600) sebelum
   redeploy API/worker; di Compose cadangan lewat service `release` ber-profile. CI tidak memerlukan akses SSH ke VPS
   (PRD 5.3: SSH hanya dari IP tepercaya/VPN).
3. **Gerbang go-live = CLI baca-saja** `golive:check` (`apps/api/src/cli/golive-gate.ts`), bukan aturan
   `/health/ready`. Konfigurasi yang belum disahkan adalah alasan menunda go-live atau promosi image (PRD 8.4), bukan
   alasan mengeluarkan API yang sedang melayani anggota dari load balancer; pemeriksaan kesehatan tetap murni
   dependensi. Job rilis menjalankan gerbang setiap rilis: `enforce` di production (job gagal, image tidak
   dipromosikan) dan `report` di staging.
   - Pada `enforce`, pemeriksaan konfigurasi pengurus (semua kecuali `schema` dan `settings`, yang bergantung pada
     migrasi dan seed rilis itu) dijalankan juga **sebelum migrasi** (`--preflight`), sehingga konfigurasi yang belum
     disahkan menghentikan rilis tanpa mengubah skema production. Penolakan gerbang penuh setelah migrasi berarti
     perbaikan maju (PRD 8.4).
   - `report` di production adalah **pengecualian** (inisialisasi pertama, atau hotfix mendesak saat pemeriksaan yang
     tidak terkait sedang merah) dan wajib `RELEASE_GATE_REASON` + `RELEASE_GATE_APPROVER`, yang dicetak di log job untuk
     paket bukti dan log insiden.
4. **Image lebih lama dari skema**: job rilis menolaknya di semua mode SEBELUM `roles.sql`, karena `roles.sql` image lama
   dapat memberi ulang hak yang dicabut rilis baru. Rollback image (PRD 5.5, 8.4) karenanya tidak memakai job rilis:
   redeploy tag lama setelah memastikan migrasi kompatibel mundur, dengan bukti gerbang baca-saja
   `golive:check --allow-schema-ahead` (skema lebih baru dicatat sebagai peringatan).
5. Kriteria "tersahkan" yang dapat diperiksa mesin: nominal D4 (disahkan PRD v3.3) atau nominal yang ditetapkan pengurus
   lewat web admin (`updated_by_admin_id` + audit), tidak ada Rp0; metode bayar aktif dibuat lewat web admin (audit
   `payment_method.created`) dan bukan contoh; >= 2 Super Admin aktif ber-TOTP dan >= 2 pemutus pembayaran (PRD 8.2
   langkah 3, 2.3); halaman legal/bantuan terbit tanpa kerangka DRAF dan sinkron dengan `app_settings.legal`; master
   aktif; WhatsApp dukungan; tanpa fixture dev; skema sama dengan journal image. Penanda fixture hanya yang tidak dapat
   dipalsukan anggota (audit `seed.dev`, `DEV_IDS`, akun aktif ber-domain email cadangan, konten pengurus `[Contoh]`):
   nama yang diisi pendaftar anonim saat registrasi hanya dicatat dan tidak pernah menahan rilis. Saran perbaikan
   fixture membedakan "belum ada akun anggota nyata" (reset terkendali diizinkan PRD 8.4) dari "sudah ada" (jangan reset).
   Tanda tangan manusia (bendahara, QA, pengurus, infra; PRD 9.3) tetap di paket bukti: laporan gerbang mencetak nominal
   dan rekening tersamar untuk itu.
6. Web admin dilayani nginx dengan CSP ketat (`script-src`/`style-src 'self'`, `frame-ancestors 'none'`); karenanya
   TipTap dijalankan dengan `injectCSS: false` dan aturan dasar ProseMirror dipindah ke `apps/admin/src/styles.css`.
   Origin API CSP dirender saat build dari `VITE_API_BASE_URL`, sehingga image web/admin dibangun per lingkungan dari
   commit yang sama (varian `-staging`), sedangkan image api/worker/release identik untuk kedua lingkungan. Nilai cache
   per path (aset hash `immutable`) hanya untuk respons 200/206/304; respons galat selalu `no-store` agar 404 aset
   selama rolling deploy tidak tersimpan setahun di peramban.
7. Compose cadangan memakai jaringan edge terpisah per lingkungan (`kapdh-edge`, `kapdh-edge-staging`, dipatok, bukan
   dari env); hanya Traefik cadangan yang tersambung ke keduanya (D12).

## Pembaruan (integrasi akhir R1.0)

Pipeline CI/CD (ADR pipeline CI/CD, `.github/workflows/`) dibangun paralel dan memakai job migrasi lewat SSH forced
command (`infra/ci/remote-migrate.sh`) yang diikat ke satu lingkungan di sisi server. Saat integrasi:

- Keputusan 2 diperbarui: jalur Coolify **utama** adalah `_deploy.yml` → `remote-migrate.sh` dengan image `kapdh-api`
  (digest), yang kini menjalankan urutan dan gerbang yang sama (dump pra-migrasi → `roles.sql` → gerbang pra-migrasi →
  migrasi → `roles.sql` → seed referensi → gerbang penuh `--allow-schema-ahead`), dengan mode `KAPDH_RELEASE_GATE*`
  dari berkas konfigurasi server. `run-release.sh` + image `kapdh-release` tetap jalur manual dan Compose cadangan.
  Perbedaan yang disengaja: jalur otomatis tidak menolak image yang lebih lama dari skema (aksi `deploy-tag` = rollback
  image lewat pipeline), sehingga `roles.sql` terbaru wajib diterapkan ulang manual sesudah rollback; dan sandi role
  LOGIN diatur pengelola secrets, bukan dari env job.
- Image `kapdh-release` masuk katalog image CI (`infra/ci/images.json`) dan dipromosikan dengan digest yang sama.
- Keputusan 6: aturan dasar ProseMirror kini satu salinan di `apps/admin/src/components/ui/tiptap-base.css`
  (bukan `styles.css`).

## Konsekuensi

- Satu langkah manual (atau otomatisasi di VPS) per rilis sebelum redeploy Coolify; dicatat di runbook rilis. Pada
  jalur otomatis langkah ini dijalankan pipeline (lihat Pembaruan).
- Superuser PostgreSQL hanya ada di berkas env job rilis. Dua job rilis bersamaan aman untuk migrasi (advisory lock)
  tetapi GRANT bersamaan dapat gagal dan harus diulang; operator menjalankan satu job pada satu waktu.
- Gerbang pra-migrasi memakai kode image baru terhadap skema lama; bila kueri gerbang membutuhkan kolom dari migrasi
  tertunda, pra-migrasi gagal teknis (kode 3), job mencetak peringatan dan gerbang penuh setelah migrasi yang menentukan.
- Pengecualian gerbang bergantung pada disiplin manusia (alasan dan penyetuju tercetak di log job, bukan audit
  database); dicatat di log insiden dan paket bukti.
- Gerbang memeriksa keadaan data, bukan niat: misalnya metode bayar yang dibuat lewat web admin tetap memerlukan
  tanda tangan bendahara pada laporan. Aturan baru (mis. bila nominal Rp0 kelak disahkan) memerlukan perubahan PRD dan
  kode gerbang.
- Belum terbukti tanpa Docker: build image, psql di image rilis, perilaku Coolify (nama jaringan/host DB, mount
  direktori bersama, label HSTS, login registry), CSP admin di peramban nyata. Daftar lengkap: runbook rilis bagian 8.
