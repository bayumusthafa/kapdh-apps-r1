# ADR-014: Deletion ledger eksternal di storage dan penerapan ulang setelah restore

- Status: Diterima (Fase C, api-account); urutan "sebelum layanan dibuka" belum dijaga kode (lihat Konsekuensi)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 3.14, 5.5, 8.4, 9.2 (skenario akun dihapus lalu backup direstore); F-14; AC F14-6; D2; N-09
- Bukti di kode (di `kapdh-platform/apps/api/src/modules/account/`): `deletion-ledger.ts`,
  `deletion-ledger.service.ts`, `ledger-reapply.cli.ts`, `deletion-steps.ts`; skrip `pnpm --filter @kapdh/api account:ledger-reapply`, uji
  `apps/api/test/account/deletion-job.e2e.test.ts`, `apps/api/test/pg/account-deletion.pg.test.ts`

## Konteks

D2: saat akun dihapus, data pribadi dan bukti transfer dihapus; catatan keuangan, tiket, laporan dan audit tetap dalam
bentuk anonim. Backup berotasi 30 hari. Bila backup yang dibuat sebelum penghapusan direstore, akun yang sudah dihapus
akan "hidup" kembali kecuali ada catatan penghapusan di luar backup tersebut. Tabel `account_deletions` ikut direstore
sehingga tidak dapat menjadi sumber.

## Keputusan

1. Setiap penghapusan yang selesai ditulis job `account.deletion` sebagai satu objek JSON di StorageDriver:
   `ledger/account-deletions/<yyyy>/<mm>/<nomor-permintaan>.json`, berisi `deletion_id`, `request_number`, `user_id`,
   sumber (`app`/`web`), waktu permintaan/selesai, keadaan (`requested`/`completed`) dan `object_keys` berkas, tanpa
   nama, email, telepon, atau isi apa pun. Penulisan monoton (keadaan tidak dimundurkan).
   `account_deletions.ledger` hanya salinan kerja job.
2. Ledger ikut dicadangkan bersama manifest backup, tetapi pemulihan memakai salinan **terbaru** (folder ledger di
   `STORAGE_LOCAL_ROOT`, sinkron bucket S3, atau salinan pada manifest backup terbaru), bukan ledger dari backup yang
   direstore.
3. Setelah database dan berkas direstore dan **sebelum** API/worker dibuka, pengelola infra menjalankan
   `node dist/modules/account/ledger-reapply.cli.js --dir <salinan ledger terbaru>` (env worker, role
   `kapdh_worker`). CLI menerapkan ulang setiap entri (hapus/anonimkan lagi, hapus objek berkas), idempoten, dan keluar
   1 bila ada entri gagal; layanan tidak boleh dibuka sampai keluaran `Gagal : 0`.

## Alternatif yang dipertimbangkan

- **Hanya mengandalkan rotasi backup 30 hari**: ditolak; restore di dalam 30 hari menghidupkan kembali data.
- **Ledger di tabel database terpisah**: ditolak; ikut direstore ke titik yang sama.

## Konsekuensi

- Runbook restore wajib menempatkan `account:ledger-reapply` sebagai langkah pemblokir sebelum trafik dibuka.
- Pada `main` saat dokumen ini ditulis, tidak ada pemeriksaan otomatis yang menahan `/api/v1/health/ready` sampai
  ledger diterapkan (temuan audit D2-01). Cabang hardening Fase D menambahkan pemeriksaan readiness dan
  `docs/runbooks/restore-backup.md`; sampai digabung, urutan dijaga runbook dan sign-off pengelola infra.
- Backup berkas (`/data/files`) harus mencakup folder `ledger/` dan disimpan terpisah dari kunci backup (PRD 5.5).
