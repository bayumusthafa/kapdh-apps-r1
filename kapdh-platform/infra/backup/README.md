# infra/backup — backup, restore dan verifikasi

Backup harian PostgreSQL + `/data/files` ke repositori restic terenkripsi di luar VPS, restore ke lingkungan bersih,
dan verifikasi sebelum layanan dibuka (PRD 5.5, N-06, AC F14-6; D2, D9; ADR-018, ADR-019). Prosedur lengkap, restore
drill bulanan, RPO/RTO dan daftar bukti: `docs/runbooks/backup-restore.md`. Urutan sisi aplikasi (kepala ledger,
gerbang readiness): `docs/runbooks/restore-backup.md`.

| Berkas                 | Fungsi                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backup.sh`            | pg_dump (format custom) pada snapshot yang diekspor + statistik manifest di snapshot yang sama → restic `/data/files` → salinan bucket deletion ledger luar VPS (rclone) → `manifest.json` (termasuk image tag@digest) → unggah + baca-balik → retensi berpasangan + `prune --max-unused 0` → heartbeat Kuma |
| `restore.sh`           | Restore (sebagai root atau uid `FILES_OWNER`) ke database dan volume KOSONG: roles.sql → pg_restore satu transaksi → roles.sql → (opsional) migrasi → snapshot berkas dari manifest → salinan ledger di `<bukti>/ledger` → `ledger-reapply` → lepas lease outbox → `verify-restore.sh` → ringkasan RTO/RPO   |
| `verify-restore.sh`    | Invariant jumlah dan total uang = manifest, ledger diterapkan, berkas ada dan sha256 sampel cocok, Super Admin, outbox; opsional HTTP (`verify-http.mjs`). Mode `--post-start` (sesudah layanan menyala) dan `--baseline-empty` (PRD 8.2 langkah 1)                                                          |
| `lib.sh`               | Fungsi bersama (log tanpa secret, konfigurasi, lock, heartbeat Kuma, nilai manifest aman, pasangan snapshot/backup_id)                                                                                                                                                                                       |
| `sql/*.sql`            | SQL yang dijalankan skrip lewat psql (statistik, perbandingan, pemeriksaan, pelepasan lease outbox)                                                                                                                                                                                                          |
| `manifest.schema.json` | Skema JSON manifest backup                                                                                                                                                                                                                                                                                   |
| `backup.env.example`   | Contoh konfigurasi `/etc/kapdh/backup.env` dan `restore.env` (tanpa secret)                                                                                                                                                                                                                                  |
| `systemd/`, `cron/`    | Jadwal backup 19:15 UTC = 02:15 WIB: pilih systemd timer ATAU cron, bukan keduanya. Pemeriksa monitoring: `infra/monitoring/cron/kapdh-monitoring`                                                                                                                                                           |
| `test/dry-run.sh`      | Uji kering dengan alat tiruan (`test/stubs`, `test/fake-tools.mjs`): 60 pemeriksaan alur, retensi, penolakan dan kegagalan                                                                                                                                                                                   |

Persyaratan host: POSIX sh, `psql`/`pg_dump`/`pg_restore` 17 (atau `PG_EXEC` ke kontainer PostgreSQL), restic ≥ 0.16,
rclone ≥ 1.60, curl, GNU coreutils, zona waktu UTC; Node ≥ 20 hanya untuk `verify-http.mjs` (atau `NODE_CMD` image API).

```sh
sh infra/backup/test/dry-run.sh            # uji kering (Linux/macOS/Git Bash), keluar 0 bila lulus
KAPDH_BACKUP_ENV=/etc/kapdh/backup.env infra/backup/backup.sh
sudo KAPDH_BACKUP_ENV=/etc/kapdh/restore.env infra/backup/restore.sh --target-kind drill
sudo VERIFY_API_URL=http://127.0.0.1:3000 infra/backup/verify-restore.sh --post-start \
  --manifest <bukti>/manifest.json --ledger-dir <bukti>/ledger
```

Status: skrip, SQL dan HTTP diuji di repo (alat tiruan, PGlite, PostgreSQL 17); belum dijalankan terhadap restic,
rclone, Docker dan object storage sungguhan. Restore drill staging pertama wajib sebelum go-live (U-11, U-12).
