# ADR-014: Deletion ledger eksternal di storage dan penerapan ulang setelah restore

- Status: Diterima (Fase C, api-account); diperkuat hardening Fase D (kepala ledger, gerbang readiness, floor nomor
  anggota; D2-01, D5-05); diperbarui oleh ADR-019 (ledger juga ditulis ke bucket luar VPS, D5-07)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 3.14, 5.5, 8.4, 9.2 (skenario akun dihapus lalu backup direstore); F-14; AC F14-6; D2; N-09
- Bukti di kode (di `kapdh-platform/apps/api/src/modules/account/`): `deletion-ledger.ts`,
  `deletion-ledger.service.ts`, `deletion-ledger-gate.ts`, `ledger-reapply.cli.ts`, `deletion-steps.ts`; skrip
  `pnpm --filter @kapdh/api account:ledger-reapply`; `apps/api/src/modules/public/health.controller.ts`
  (`checks.deletion_ledger`); uji `apps/api/test/account/deletion-job.e2e.test.ts`,
  `apps/api/test/pg/account-deletion.pg.test.ts`, `apps/api/test/pg/deletion-e2e.pg.test.ts`; runbook
  `docs/runbooks/restore-backup.md`

## Konteks

D2: saat akun dihapus, data pribadi dan bukti transfer dihapus; catatan keuangan, tiket, laporan dan audit tetap dalam
bentuk anonim. Backup berotasi 30 hari. Bila backup yang dibuat sebelum penghapusan direstore, akun yang sudah dihapus
akan "hidup" kembali kecuali ada catatan penghapusan di luar backup tersebut. Tabel `account_deletions` ikut direstore
sehingga tidak dapat menjadi sumber.

## Keputusan

1. Setiap penghapusan ditulis job `account.deletion` sebagai satu objek JSON di StorageDriver:
   `ledger/account-deletions/<yyyy>/<mm>/<nomor-permintaan>.json`, berisi `deletion_id`, `request_number`, `user_id`,
   sumber (`app`/`web`), waktu permintaan/selesai, keadaan (`requested` saat mulai diproses, lalu `completed`),
   `object_keys` berkas dan `member_seq_floor` (N tertinggi yang sudah dialokasikan), tanpa nama, email, telepon, atau
   isi apa pun. Penulisan monoton (keadaan tidak dimundurkan). Objek kepala `ledger/account-deletions-head.json` (di
   luar folder entri) menunjuk permintaan terbaru dan floor tertinggi. `account_deletions.ledger` hanya salinan kerja
   job.
2. Ledger ikut dicadangkan bersama manifest backup, tetapi pemulihan memakai salinan **terbaru** (folder ledger di
   `STORAGE_LOCAL_ROOT`, sinkron bucket S3, atau salinan pada manifest backup terbaru), bukan ledger dari backup yang
   direstore.
3. Setelah database dan berkas direstore dan **sebelum** API/worker dibuka, pengelola infra menjalankan
   `node dist/modules/account/ledger-reapply.cli.js --dir <salinan ledger terbaru>` (env worker, role
   `kapdh_worker`). CLI menerapkan ulang setiap entri (hapus/anonimkan lagi, hapus objek berkas), idempoten, dan keluar
   1 bila ada entri gagal; layanan tidak boleh dibuka sampai keluaran `Gagal : 0`. Penerapan ulang juga mencatat floor
   nomor anggota sehingga N yang terbit sesudah titik backup tidak dipakai ulang, dan menulis ulang kepala ledger.
4. `GET /api/v1/health/ready` menjawab 503 dengan `checks.deletion_ledger: "fail"` selama database belum mengenal
   permintaan terbaru di kepala ledger (atau kepala rusak), sehingga healthcheck orkestrator yang memakai readiness
   menahan replika API dari trafik sampai langkah 3 selesai.

## Alternatif yang dipertimbangkan

- **Hanya mengandalkan rotasi backup 30 hari**: ditolak; restore di dalam 30 hari menghidupkan kembali data.
- **Ledger di tabel database terpisah**: ditolak; ikut direstore ke titik yang sama.

## Konsekuensi

- Runbook restore (`docs/runbooks/restore-backup.md`) menempatkan `account:ledger-reapply` sebagai langkah pemblokir
  sebelum trafik dibuka: API dan worker dihentikan (skala 0), salinan ledger terbaru diamankan sebelum berkas
  direstore, lalu ledger diterapkan ulang sebelum API dinyalakan.
- Batas gerbang readiness: bila database DAN storage dipulihkan dari backup yang sama, kepala ledger ikut tua dan
  readiness tetap 200. Karena itu penerapan ulang dari salinan ledger terbaru tetap wajib di setiap restore, apa pun
  hasil readiness (temuan D2-01 ditutup untuk kasus storage terkini; sisanya dijaga runbook).
- Healthcheck API di Coolify harus memakai `/api/v1/health/ready`, bukan `/api/v1/health`, agar gerbang ini berlaku.
- Backup berkas (`/data/files`) harus mencakup seluruh awalan `ledger/` (folder entri dan objek kepala) dan disimpan
  terpisah dari kunci backup (PRD 5.5).
