# ADR-018: Backup harian pg_dump + restic ke object storage di luar VPS, diikat manifest

- Status: Diterima (Fase E, E3 operasi); belum dibuktikan restore drill staging
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 2.4 N-06, 5.5, 8.2, 8.4, 9.1 U-11/U-12, 9.2 #8; D2 (retensi 30 hari), D9 (tujuan backup, pemegang
  kunci); AC F14-6; audit D2-03
- Bukti di kode: `kapdh-platform/infra/backup/{backup.sh,restore.sh,verify-restore.sh,verify-http.mjs,lib.sh}`,
  `infra/backup/sql/*.sql`, `infra/backup/manifest.schema.json`, `infra/backup/systemd/`, `infra/backup/cron/`,
  `infra/db/roles.sql` (`kapdh_backup`, `kapdh_monitor`); uji `infra/backup/test/dry-run.sh` (alat tiruan),
  `apps/api/test/ops/backup-ops.e2e.test.ts`, `apps/api/test/pg/backup-roles.pg.test.ts`; runbook
  `docs/runbooks/backup-restore.md`

## Konteks

N-06 meminta backup DB dan berkas harian dengan RPO ≤ 24 jam dan RTO ≤ 4 jam yang dibuktikan lewat restore, bukan
hanya keberhasilan backup. Satu VPS (D7) menjalankan PostgreSQL 17 dan volume berkas `/data/files`; kehilangan VPS
tidak boleh menghilangkan backup. PRD 5.5 meminta manifest (DB, berkas, versi skema, image, deletion ledger) dan
konsistensi rujukan DB-berkas atau jeda mutasi. D2: backup berotasi 30 hari dan akun terhapus tidak boleh hidup kembali.

## Keputusan

1. **Database:** `pg_dump --format=custom` dengan role `kapdh_backup` (`pg_read_all_data`, tanpa hak tulis). Sesi
   `REPEATABLE READ READ ONLY` mengekspor snapshot; `pg_dump --snapshot` dan statistik manifest (jumlah, total uang per
   jenis, versi skema dari journal migrasi) dihitung pada snapshot yang sama, sehingga verifikasi restore dapat
   membandingkan angka secara persis.
2. **Berkas:** `restic backup /data/files` SESUDAH dump (tanpa jeda layanan). Alasan konsistensi: baris `ready` hanya
   ada setelah objeknya tersimpan; objek yang dihapus di antara dump dan snapshot berkas diselesaikan ulang deletion
   ledger dan job cleanup; objek baru sesudah dump menjadi yatim yang tidak pernah dilayani dan dilaporkan verifikasi.
   Untuk perubahan berisiko (migrasi besar, perpindahan storage) runbook memakai backup "dingin" dengan maintenance.
3. **Tujuan:** satu repositori restic (AES-256, kata sandi terpisah dari salinan backup: password manager + salinan
   cetak, D9) di bucket S3-compatible di luar VPS (R2/B2). Dump, manifest dan salinan bucket deletion ledger diunggah
   sebagai snapshot `kapdh-db`; berkas sebagai snapshot `kapdh-files`.
4. **Manifest JSON** (`manifest.schema.json`): id backup, sha256 dan ukuran dump, id snapshot berkas, statistik DB,
   versi skema, referensi image, versi alat, dan daftar objek deletion ledger luar VPS dengan sha256. Dibaca balik dari
   repositori dan dicocokkan sha256 sebelum backup dinyatakan berhasil.
5. **Retensi (D2: backup berotasi 30 hari):** setiap run `restic forget --tag kapdh-db --keep-within 30d`, lalu snapshot
   berkas dilupakan BERPASANGAN dengan dump-nya (tag `backup_id` yang sama; keep-within restic dihitung per grup dari
   snapshot terbaru grup itu, sehingga tanpa pasangan manifest tertua dapat merujuk snapshot berkas yang sudah
   dibuang), lalu `restic prune --max-unused 0` (bawaan restic menoleransi 5 % data tak terpakai, sehingga blob akun
   terhapus dapat tertahan di pack campuran). Skrip menolak `RETENTION_DAYS + BUCKET_NONCURRENT_DAYS` > 30 (versi lama
   objek yang ditahan penyedia sesudah prune ikut dihitung) dan production tanpa prune. Bucket backup tanpa masa versi
   lama secara bawaan; perlindungan ransomware dengan versi lama/object lock hanya dalam batas 30 hari itu dan dengan
   persetujuan pemilik D2. (Diperbarui oleh perbaikan audit E3; sebelumnya `forget --keep-within 30d --prune` per grup
   dan versi noncurrent 7 hari.)
6. **Restore** hanya ke lingkungan bersih (database tanpa skema `app`, volume kosong); urutan: roles.sql → pg_restore
   satu transaksi → roles.sql → (opsional) migrasi → snapshot berkas yang dirujuk manifest → deletion ledger TERBARU
   dari bucket luar VPS + salinan backup lewat CLI `ledger-reapply` (wajib keluar 0) → pelepasan lease outbox →
   `verify-restore.sh` (invariant uang dan jumlah persis, ledger diterapkan, berkas dan sha256 sampel, Super Admin,
   HTTP login/MFA admin drill). Keluar bukan nol = layanan tidak dibuka. restore.sh berjalan sebagai root (atau uid
   `FILES_OWNER`) dan menyimpan salinan ledger di `<bukti>/ledger` milik `FILES_OWNER`, karena CLI berjalan di image
   sebagai `node` (uid 1000); CLI tidak membutuhkan Redis. Sesudah restore: API sendiri sampai readiness
   `deletion_ledger: ok`, lalu worker, lalu `verify-restore.sh --post-start`.
7. Skrip POSIX sh (`set -eu`) dengan alat standar (psql/pg_dump 17, restic, rclone, curl), tanpa jq, tanpa mencetak
   secret atau data pribadi; heartbeat Uptime Kuma Push untuk setiap run.

## Alternatif yang dipertimbangkan

- **WAL archiving / PITR (pgBackRest, wal-g):** RPO jauh lebih kecil, tetapi menambah komponen yang harus dioperasikan
  satu pengelola infra dan restore yang lebih rumit; N-06 cukup dengan harian. Dapat ditambahkan bila D8 menurunkan RPO.
- **Snapshot volume penyedia VPS:** tidak berada di luar failure domain penyedia dan tidak membawa manifest/ledger.
- **Jeda layanan setiap backup:** menambah downtime harian yang dihitung N-05; urutan DB-lalu-berkas cukup konsisten.

## Konsekuensi

- RPO aktual ≤ 24 jam + durasi backup; RTO dan RPO wajib diukur pada restore drill bulanan (runbook bagian 8).
- Skrip baru teruji dengan alat tiruan dan SQL sungguhan; perilaku pg_dump/restic/rclone/R2 sungguhan baru terbukti
  setelah drill staging pertama (U-11, U-12).
- Berkas di S3 (setelah perpindahan PRD 5.4) belum didukung skrip; prasyarat perpindahan (`storage-migration.md`).
