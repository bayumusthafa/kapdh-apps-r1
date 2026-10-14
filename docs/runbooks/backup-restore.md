# Runbook: backup, restore dan restore drill KAPDH

Pemilik: pengelola infra (PRD 5.5, D9). Saksi drill: QA. Persetujuan operasional: pengelola infra (PRD 9.3).
Rujukan: PRD 2.4 N-06, 3.14 AC F14-6 dan D2, 5.5, 8.2, 8.3, 8.4, 9.1 U-11/U-12, 9.2 #8, 10.1 D9; ARCHITECTURE §10.
Perkakas: `kapdh-platform/infra/backup/` (skrip), `kapdh-platform/infra/db/roles.sql` (role), CLI
`ledger-reapply` di image API. Urutan sisi aplikasi (kepala ledger, gerbang readiness `deletion_ledger`, floor
nomor anggota) dijelaskan juga di `docs/runbooks/restore-backup.md`; keputusan desain: ADR-014, ADR-018, ADR-019.
Urutan deployment Compose cadangan (bila Coolify tidak tersedia) dan daftar secret yang wajib sama:
`docs/runbooks/compose-cadangan.md`. Sandi role `kapdh_backup`/`kapdh_monitor` dapat diterapkan job rilis
(`KAPDH_BACKUP_DB_PASSWORD`/`KAPDH_MONITOR_DB_PASSWORD`, `infra/db/role-passwords.sql`) atau manual (bagian 3).

> **Status bukti.** Skrip, SQL dan alurnya sudah diuji di repositori: uji kering dengan alat tiruan
> (`infra/backup/test/dry-run.sh`, 60 pemeriksaan: retensi berpasangan, pemilik salinan ledger, mode `--post-start`
> dan `--baseline-empty`, versi image wajib), SQL pada PGlite dan PostgreSQL 17 (`apps/api/test/ops`,
> `apps/api/test/pg/backup-roles.pg.test.ts`), dan CLI ledger-reapply pada PostgreSQL 17 (termasuk saat Redis
> tidak terjangkau). Skrip ini **belum pernah dijalankan terhadap PostgreSQL production, restic, rclone, Docker dan
> object storage sungguhan.** N-06 baru terbukti setelah restore drill pertama di staging tercatat sesuai bagian 8
> (PRD 8.2 langkah 1 dan 7, U-11, U-12).

## 1. Sasaran

| Sasaran                              | Nilai                     | Cara membuktikan                                                                                                                                                                               |
| ------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPO (data hilang maksimal)           | ≤ 24 jam (N-06)           | Backup harian 02:15 WIB + alert umur backup > 26 jam; drill mencatat umur backup saat restore dimulai                                                                                          |
| RTO (waktu pulih maksimal)           | ≤ 4 jam (N-06)            | Drill mencatat waktu dari keputusan restore sampai layanan siap dibuka (bagian 8.4)                                                                                                            |
| Retensi                              | 30 hari, tidak lebih (D2) | Setiap run: dump di luar 30 hari dilupakan, snapshot berkas dilupakan berpasangan, `restic prune --max-unused 0`; backup.sh menolak `RETENTION_DAYS + BUCKET_NONCURRENT_DAYS` > 30 (bagian 10) |
| Penghapusan akun tidak hidup kembali | AC F14-6, PRD 9.2 #8      | Deletion ledger di luar VPS diterapkan ulang sebelum layanan dibuka; verify-restore.sh                                                                                                         |
| Total uang tetap cocok               | PRD 9.2 #8                | Statistik invariant di manifest = database pulihan (verify-restore.sh)                                                                                                                         |

## 2. Arsitektur backup

```
VPS production (Coolify)                               Object storage DI LUAR VPS (R2 / B2 / penyedia lain, D9)
-------------------------------------                  ---------------------------------------------------------
PostgreSQL 17 --(pg_dump, role kapdh_backup)--+        bucket kapdh-prod-backup  (repositori restic, terenkripsi)
/data/files   --(restic backup)---------------+------>   snapshot kapdh-files : isi /data/files
                                              |          snapshot kapdh-db    : db.dump + manifest.json
worker (job penghapusan akun) --(PutObject)---+--->    bucket kapdh-prod-deletion-ledger (versioning + object lock)
                                                         account-deletions/<yyyy>/<mm>/<nomor>/<state>-<uuid>.json
backup.sh --(rclone copy, kunci hanya-baca)--> salinan ledger ikut snapshot kapdh-db
```

Pemisahan kunci (PRD 5.5 "kunci backup disimpan terpisah dari salinan backup"):

| Kredensial                     | Dipegang                                                                                                                   | Hak                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Kata sandi repositori restic   | password manager pemilik + cadangan, satu salinan cetak di brankas (D9); berkas `/etc/kapdh/restic-password` (0600) di VPS | Membuka seluruh backup                     |
| Kunci S3 bucket backup         | `/etc/kapdh/backup.secrets.env` di VPS                                                                                     | Baca/tulis/hapus bucket backup (prune)     |
| Kunci S3 bucket ledger (tulis) | env worker `DELETION_LEDGER_S3_*` (Coolify)                                                                                | Tulis objek saja (bila penyedia mendukung) |
| Kunci S3 bucket ledger (baca)  | `backup.secrets.env` (rclone) dan host restore                                                                             | Baca/list saja                             |
| Sandi `kapdh_backup`           | `backup.secrets.env` / PGPASSFILE                                                                                          | `pg_read_all_data`, tanpa tulis            |

## 3. Penyiapan awal (sekali per lingkungan; staging lebih dahulu, PRD 8.2)

1. **Bucket.** Buat dua bucket privat di penyedia di luar VPS (bisa penyedia yang sama, akun/bucket berbeda):
   - `kapdh-<env>-backup`: **tanpa** masa simpan versi lama (R2: versioning tidak aktif; B2: lifecycle "Keep only
     the last version", yaitu versi tersembunyi dihapus setelah 1 hari). Isi `BUCKET_NONCURRENT_DAYS` di backup.env
     sesuai aturan itu (R2 = 0, B2 = 1, lalu `RETENTION_DAYS=29`). Alasannya D2: data akun terhapus wajib hilang dari
     backup dalam 30 hari, dan versi lama yang ditahan penyedia sesudah prune ikut dihitung. Perlindungan
     ransomware/penghapusan tidak sengaja dengan versi lama atau salinan kedua (object lock) hanya boleh bila
     `RETENTION_DAYS + masa versi lama ≤ 30` dan disetujui pemilik D2 (pemilik produk); catat keputusannya di log
     operasional.
   - `kapdh-<env>-deletion-ledger`: versioning + object lock/retensi (R2 "bucket lock", B2 "Object Lock" diaktifkan saat
     bucket dibuat) minimal 35 hari. Jangan pasang aturan hapus selama ada backup yang dapat dipulihkan. Isi ledger hanya id
     dan object key (tanpa nama/email/telepon).
2. **Kunci API penyedia.** Satu kunci tulis untuk worker ke bucket ledger (B2: kapabilitas `writeFiles` saja bila S3 API
   penyedia mengizinkan; R2: token "Object Read & Write" terbatas pada bucket itu), satu kunci hanya-baca bucket ledger
   untuk backup/restore, satu kunci baca/tulis bucket backup.
3. **Worker.** Isi `DELETION_LEDGER_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY` (dan
   `DELETION_LEDGER_S3_FORCE_PATH_STYLE` bila penyedia butuh) di env worker Coolify. Worker production menolak start
   tanpa variabel ini (packages/config). Bila sudah ada penghapusan sebelum variabel diisi, salin ledger lokal sekali
   dengan remote **tulis** sementara (kunci tulis worker; remote `kapdhledger:` di backup.secrets.env hanya-baca dan
   akan ditolak AccessDenied):

   ```sh
   # Di shell root sesaat (spasi di depan agar tidak masuk riwayat bila HISTCONTROL=ignorespace); jangan simpan ke berkas.
    export RCLONE_CONFIG_KAPDHLEDGERW_TYPE=s3 RCLONE_CONFIG_KAPDHLEDGERW_PROVIDER=Cloudflare \
      RCLONE_CONFIG_KAPDHLEDGERW_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
      RCLONE_CONFIG_KAPDHLEDGERW_ACCESS_KEY_ID=<kunci tulis worker> RCLONE_CONFIG_KAPDHLEDGERW_SECRET_ACCESS_KEY=<...>
   rclone copy /data/files/ledger/account-deletions kapdhledgerw:<bucket>/account-deletions/backfill --checksum
   rclone lsf kapdhledger:<bucket>/account-deletions/backfill | wc -l   # dibaca ulang dengan kunci hanya-baca
   unset $(env | sed -n 's/^\(RCLONE_CONFIG_KAPDHLEDGERW_[A-Z_]*\)=.*/\1/p')
   ```

   Bila kunci tulis worker tidak memiliki hak list (B2 `writeFiles` saja), unggahan tetap berhasil; pembacaan ulang
   memakai kunci hanya-baca seperti di atas.

4. **Role database.** Jalankan `infra/db/roles.sql` (membuat `kapdh_backup` dan `kapdh_monitor`), lalu beri sandi dari
   password manager: `ALTER ROLE kapdh_backup PASSWORD '...'` (lewat psql interaktif, jangan di riwayat shell).
5. **Alat di host VPS** (Ubuntu): `postgresql-client-17` dari repositori PGDG (atau `PG_EXEC` ke kontainer PostgreSQL),
   `restic` ≥ 0.16, `rclone` ≥ 1.60, `curl`, GNU coreutils/sed/grep/findutils. Catat versi di bukti penyiapan.
   Zona waktu host **UTC** (`timedatectl show -p Timezone` = `Etc/UTC`): jadwal cron/systemd ditulis dalam UTC.
6. **Berkas konfigurasi.** Salin `infra/backup` ke `/opt/kapdh/infra/backup` (dan `infra/db`, `infra/monitoring`).
   Buat `/etc/kapdh/backup.env` dari `backup.env.example` (0640) dan `/etc/kapdh/backup.secrets.env` (0600) berisi
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `PGPASSWORD` atau `PGPASSFILE`, dan
   `RCLONE_CONFIG_KAPDHLEDGER_*`. Tulis kata sandi restic acak (≥ 32 karakter) ke `/etc/kapdh/restic-password` (0600)
   dan simpan juga di password manager + salinan cetak (D9).
   **Topologi** (bawaan contoh): `FILES_ROOT=/srv/kapdh/production/files`, yaitu direktori host yang di-bind ke
   `/data/files` kontainer API/worker oleh resource Coolify maupun Compose cadangan (`KAPDH_FILES_DIR`); di runbook
   ini `/data/files` berarti direktori itu bila perintah dijalankan di host. PostgreSQL tidak diterbitkan ke host
   (jaringan Docker internal), maka `PG_EXEC` menjalankan `pg_dump`/`psql` di kontainer PostgreSQL
   (`kapdh-production-postgres-1` pada Compose; nama kontainer resource PostgreSQL pada Coolify).
   **Versi image** (PRD 5.5, manifest `images.*`): isi `IMAGE_API`/`IMAGE_WORKER` (tag@digest) dan perbarui setiap
   rilis sebagai langkah runbook rilis, ATAU isi `CONTAINER_API`/`CONTAINER_WORKER` dengan filter label
   (`label=<kunci>=<nilai>`; cek `docker ps --filter "<filter>" --format '{{.Image}}'` menampilkan tepat satu
   kontainer). Di production backup tanpa `images.api`/`images.worker` tetap tersimpan, tetapi run berakhir gagal dan
   monitor "backup harian" merah sampai diperbaiki.
7. **Inisialisasi repositori:** `set -a; . /etc/kapdh/backup.env; . /etc/kapdh/backup.secrets.env; restic init`.
8. **Jadwal backup: pilih SATU.** systemd timer `infra/backup/systemd/kapdh-backup.{service,timer}` (disarankan) ATAU
   cron `infra/backup/cron/kapdh-backup` (19:15 UTC = 02:15 WIB; cron Ubuntu tidak mengenal `CRON_TZ`). Memasang
   keduanya = backup dua kali sehari. Lalu `systemctl start kapdh-backup.service` sekali dan periksa
   `journalctl -u kapdh-backup`. Pemeriksa monitoring dipasang terpisah memakai `infra/monitoring/cron/kapdh-monitoring`
   (docs/runbooks/monitoring.md bagian 2.1).
9. **Monitor Push** Uptime Kuma: `KUMA_PUSH_BACKUP` (interval heartbeat 26 jam), `KUMA_PUSH_BACKUP_AGE` (1 jam),
   `KUMA_PUSH_BACKUP_CHECK` (8 hari), `KUMA_PUSH_RESTORE` (opsional). Lihat docs/runbooks/monitoring.md.
10. **Bukti awal (PRD 8.2 langkah 1, 8.3 langkah 2), dua tahap:**
    - _Baseline kosong_ (PRD 8.2 langkah 1, "dari database kosong"): sesudah migrasi skema (PRD 8.2 langkah 2;
      `stats.sql` butuh skema `app`) dan SEBELUM bootstrap Super Admin (PRD 8.2 langkah 3). Jalankan backup, lalu restore ke lingkungan
      bersih dengan `restore.sh --target-kind drill --baseline-empty`: nol Super Admin menjadi WARN, `DRILL_ADMIN_*`
      dikosongkan (login/MFA admin WARN). Lulus = 0 FAIL, `http.health` dan `http.ready` PASS.
    - _Drill penuh pertama_ (U-12, PRD 8.3 langkah 2): sesudah bootstrap Super Admin dan akun admin drill (bagian 8.2),
      SEBELUM data pengguna pertama masuk: drill bagian 8 tanpa `--baseline-empty`, termasuk login/MFA admin drill.

## 4. Isi backup dan manifest

Setiap run `backup.sh` (urutan dan alasannya ada di kepala skrip):

| Langkah     | Hasil                                                                                                                          | Catatan                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1. Database | `db.dump` (pg_dump format custom), `db.toc`                                                                                    | Snapshot diekspor transaksi REPEATABLE READ READ ONLY; pg_dump `--snapshot` dan statistik manifest memakai snapshot yang sama       |
| 2. Berkas   | snapshot restic tag `kapdh-files` dari `/data/files`                                                                           | `.tmp/` dikecualikan (unggahan setengah jadi)                                                                                       |
| 3. Ledger   | `ledger-offsite/account-deletions/**` + `ledger-offsite.sha256`                                                                | Salinan bucket ledger saat backup (bukti), restore tetap membaca bucket terbaru                                                     |
| 4. Manifest | `manifest.json` (skema `infra/backup/manifest.schema.json`)                                                                    | backup_id, sha256 dan ukuran dump, id snapshot berkas, statistik DB, versi skema (journal Drizzle), image, versi alat, objek ledger |
| 5. Unggah   | snapshot restic tag `kapdh-db` (dump + manifest + ledger)                                                                      | Baca-balik `restic dump` manifest dicocokkan sha256                                                                                 |
| 6. Retensi  | `restic forget --tag kapdh-db --keep-within 30d`, snapshot berkas tanpa pasangan dump dilupakan, `restic prune --max-unused 0` | Berpasangan per `backup_id` agar manifest tertua selalu punya snapshot berkasnya; run gagal (berkas tanpa dump) ikut dibuang        |

Statistik manifest (`infra/backup/sql/stats.sql`) dibagi `invariant` (jumlah akun, payment, payment paid, total uang per
jenis, penyesuaian, tiket, event, room, admin aktif: tidak berubah oleh penerapan ulang ledger), `info` (boleh berubah:
profil, tiket paid, pesan, berkas, audit, outbox) dan `latest` (waktu data terbaru). Tidak ada data pribadi di manifest.

Validasi manual manifest terhadap skema (dari `kapdh-platform/apps/api`, ajv sudah ada di devDependencies):

```sh
node --input-type=module -e "import Ajv from 'ajv/dist/2020.js'; import {readFileSync} from 'node:fs';
const a=new Ajv.default({strictRequired:false}); const ok=a.validate(JSON.parse(readFileSync('../../infra/backup/manifest.schema.json','utf8')), JSON.parse(readFileSync(process.argv[1],'utf8')));
console.log(ok?'valid':a.errors)" /path/manifest.json
```

## 5. Konsistensi database dan berkas

Urutannya **dump database lebih dahulu, lalu snapshot berkas** (PRD 5.5 meminta backup konsisten terhadap rujukan
DB/berkas atau jeda mutasi). Alasan cukup konsisten tanpa menjeda layanan:

1. **Baris `ready` selalu punya objek sebelum baris itu terlihat.** FilesService menulis baris `pending`, menyimpan objek,
   baru mengubah baris menjadi `ready`; berkas buatan sistem (ekspor) menulis objek dahulu lalu baris. Jadi setiap baris
   `ready` di dump sudah punya objek sebelum dump dimulai, dan objek itu ikut snapshot berkas yang diambil sesudahnya.
2. **Objek yang dihapus di antara dump dan snapshot berkas** hanya berasal dari: penghapusan akun (diulang oleh
   deletion ledger saat restore), `discard` (pesan/avatar diganti; baris di dump masih `ready` tetapi objek hilang: API
   menjawab 404 untuk berkas itu, data yang memang sudah dibuang pemiliknya), dan cleanup berkas sementara/ekspor
   kedaluwarsa (job cleanup mengulangnya). verify-restore.sh menghitung baris `ready` tanpa objek (WARN ≤ 10, FAIL bila
   lebih) dan menulis daftarnya ke `missing-objects.txt`.
3. **Objek baru sesudah dump** (unggahan di jendela beberapa menit itu) menjadi objek yatim tanpa baris: tidak pernah
   dilayani (akses berkas selalu lewat baris `files`) dan dilaporkan sebagai `berkas.yatim`. Pembersihan yatim dilakukan
   manual setelah restore bila jumlahnya bermakna (bandingkan daftar disk dengan `files-local.sql`).
4. **Ledger lokal** di `/data/files/ledger/` pada snapshot berkas lebih baru dari dump: aman (lebih banyak entri).

Tindak lanjut baris `ready` tanpa objek setelah restore (opsional, dicatat di bukti): tandai `deleted` lewat psql
sebagai pemilik database dengan daftar id dari laporan, setelah dikonfirmasi pengurus.

**Kapan menjeda mutasi:** sebelum migrasi skema yang berisiko, rotasi besar, atau perpindahan storage, jalankan backup
"dingin": aktifkan mode maintenance (docs/runbooks/incident-response.md bagian 4), hentikan worker, jalankan
`systemctl start kapdh-backup.service`, tunggu selesai, lanjutkan pekerjaan. Bila VPS mendukung snapshot filesystem
(LVM/ZFS), snapshot volume berkas sesaat setelah snapshot database diekspor adalah alternatif yang setara.

## 6. Operasi harian

- Monitor Push "backup harian" hijau setiap hari; "umur backup" hijau setiap jam (`check-backup.sh`); "restic check"
  mingguan (Minggu 04.00 WIB = `CHECK_WEEKDAY=6`, `CHECK_HOUR_UTC=21`, sampel 5 % data).
- Log: `journalctl -u kapdh-backup --since today` (atau syslog tag `kapdh-backup`). Status terakhir:
  `/var/backups/kapdh/status/last-success`.
- Daftar snapshot: `restic snapshots --host kapdh-production --tag kapdh-db`.

| Gejala                                   | Penyebab umum                              | Tindakan                                                 |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `snapshot database gagal diekspor`       | sandi/role `kapdh_backup`, PostgreSQL mati | Periksa `psql` sebagai kapdh_backup; roles.sql           |
| `pg_dump gagal`                          | versi klien < server, disk WORK_DIR penuh  | Pakai klien 17 atau `PG_EXEC`; kosongkan disk            |
| `restic backup ... gagal`                | kunci S3, kuota bucket, jaringan           | Uji `restic snapshots`; periksa token penyedia           |
| `salinan deletion ledger luar VPS gagal` | kunci baca rclone, bucket salah            | `rclone lsf kapdhledger:<bucket>/account-deletions`      |
| `manifest di repositori tidak cocok`     | unggahan rusak                             | Jalankan ulang; bila berulang `restic check --read-data` |
| Heartbeat tidak datang                   | timer mati, VPS mati                       | `systemctl list-timers kapdh-backup.timer`               |

Backup yang gagal TIDAK meninggalkan dump di VPS (stage dihapus oleh trap) dan tidak membuat snapshot `kapdh-db`.

## 7. Restore karena bencana (production)

Kapan: data/berkas hilang atau rusak, VPS hilang (PRD 8.4 baris 4). Keputusan restore diambil Super Admin bersama
pengelola infra (docs/runbooks/incident-response.md); restore menghilangkan transaksi sesudah titik backup sehingga
pengguna terdampak harus dihubungi (PRD 8.4).

1. **Catat T0** (waktu keputusan restore) di log insiden. Aktifkan mode maintenance bila layanan lama masih hidup.
2. **Lingkungan bersih**: VPS/volume baru (D7: 4 vCPU/8 GB/100 GB, zona waktu UTC), PostgreSQL 17 kosong (kontainer
   image versi sama) di jaringan Docker `kapdh-restore`, volume `/data/files` kosong. Jangan restore ke database yang
   masih berisi data. Redis KOSONG boleh dinyalakan kapan saja sebelum API/worker; restore.sh dan CLI ledger-reapply
   tidak membutuhkannya (CLI sengaja tidak membuat klien Redis walau `REDIS_URL` ada di env worker).
3. **Secret aplikasi dari password manager (D9)**: VPS hilang berarti env Coolify ikut hilang. Pulihkan SEMUA secret
   API/worker dengan nilai yang SAMA seperti production: `TOTP_ENC_KEY` (tanpanya secret TOTP admin di database tidak
   dapat didekripsi dan seluruh login MFA admin gagal), `OTP_HMAC_SECRET` (backup code dan decoy penghapusan),
   `QR_SIGNING_KEYS` (QR KTA dan tiket yang sudah dicetak), juga `JWT_ACCESS_SECRET`, `FILE_URL_SECRET`, sandi role
   database, SMTP, FCM dan `DELETION_LEDGER_S3_*`. Daftar dan alasannya sama dengan
   `docs/runbooks/compose-cadangan.md` bagian 1. Tulis ke `/etc/kapdh/worker.env` dan env API (0600).
4. **Alat dan konfigurasi**: salin `infra/` ke `/opt/kapdh/infra`, buat `/etc/kapdh/restore.env` (bagian "KHUSUS
   RESTORE" di `backup.env.example`): koneksi superuser cluster baru (atau `PG_EXEC` ke kontainernya), `RESTIC_*`,
   kunci baca bucket ledger (`LEDGER_RCLONE_REMOTE`), `FILES_OWNER=1000:1000`, `LEDGER_REAPPLY_CMD` dengan **image API
   dari manifest** (bidang `images.api`, dibaca sebelum restore: `restic dump --host kapdh-production --tag kapdh-db
latest /var/backups/kapdh/stage/manifest.json | grep -A 5 '"images"'`) dan env worker
   (`/etc/kapdh/worker.env`, `DATABASE_URL` kapdh_worker ke database baru).
5. **Sandi role**: tulis `/etc/kapdh/role-passwords.sql` (0600, dihapus setelah selesai) berisi
   `ALTER ROLE kapdh_app PASSWORD '...';` dan seterusnya untuk `kapdh_worker`, `kapdh_migrator`, `kapdh_backup`,
   `kapdh_monitor` dari password manager, lalu isi `ROLE_PASSWORDS_SQL=/etc/kapdh/role-passwords.sql` di restore.env.
   restore.sh menjalankannya tepat setelah roles.sql pertama (role sudah ada) tanpa mencatat keluarannya. Tanpa sandi
   kapdh_worker, CLI ledger-reapply gagal dan restore berhenti (benar: layanan tidak boleh dibuka).
6. **Jalankan sebagai root** (berkas pulihan dan salinan ledger di-chown ke `FILES_OWNER` agar terbaca CLI di image,
   pengguna `node` uid 1000; pengguna lain ditolak sebelum mengunduh):
   `sudo KAPDH_BACKUP_ENV=/etc/kapdh/restore.env /opt/kapdh/infra/backup/restore.sh --target-kind production`.
   Pilih `--snapshot <id>` bila backup terbaru diduga rusak/terdampak insiden. Keluar ≠ 0 = jangan buka layanan; baca
   `restore.log`, `verify-report.txt` dan `ledger-reapply.log` di folder bukti. Salinan ledger yang diterapkan
   tersimpan di `<bukti>/ledger` (hanya id dan object key).
7. **Nyalakan berurutan** (sama dengan `docs/runbooks/restore-backup.md` langkah 6-7):
   1. Redis kosong (bila belum).
   2. API **satu replika**, belum dibuka untuk publik (proxy/web/admin mati, atau mode maintenance). Readiness wajib
      200 dengan `checks.deletion_ledger: "ok"`. 503 `fail` berarti ledger yang diterapkan lebih tua dari kepala ledger
      di storage: ulangi restore.sh/CLI dengan salinan bucket terbaru. Worker belum dinyalakan, agar replay outbox
      (email/push) tidak berjalan sebelum gerbang ledger terbukti.
   3. Worker (memproses outbox `pending/failed`, sapuan penghapusan), lalu replika API lainnya.
   4. Verifikasi ulang sesudah layanan menyala (lease outbox milik worker baru dicatat INFO, bukan FAIL):
      `sudo VERIFY_API_URL=http://127.0.0.1:3000 KAPDH_BACKUP_ENV=/etc/kapdh/restore.env
/opt/kapdh/infra/backup/verify-restore.sh --post-start --manifest <bukti>/manifest.json --ledger-dir <bukti>/ledger`
      (plus `DRILL_ADMIN_*` bila akun admin drill dipakai). Laporan bawaan: `<bukti>/verify-report-post-start-<waktu>.txt`.
   5. Web/admin.
8. **Smoke test** PRD 8.3 langkah 3 (login/MFA, payment/period, kartu/public verify, tiket/scan, chat, file, push,
   deletion) lalu nonaktifkan mode maintenance.
9. **Komunikasi**: umumkan titik data (`db_snapshot_captured_at`) kepada pengurus; transaksi sesudah titik itu (bukti
   bayar, tiket, chat) harus diulang pengguna. Templat di incident-response.md.
10. **Sesudahnya**: backup baru segera (`systemctl start kapdh-backup.service`), periksa monitor, tulis post-mortem.

## 8. Restore drill bulanan (PRD 5.5, N-06, U-11)

Jadwal: minggu pertama setiap bulan, hari kerja, di luar jam sibuk. Pelaksana: pengelola infra. Saksi: QA. Penanda
tangan bukti: pengelola infra dan Super Admin. Drill pertama: sebelum go-live dari backup pertama (U-12, PRD 8.3).

### 8.1 Lingkungan drill

- VPS/kontainer sementara **terisolasi** dengan akses setara production (data pribadi nyata). Bukan staging (PRD 5.3:
  data production tidak disalin ke staging). Tidak ada DNS publik; API pulihan hanya didengar di `127.0.0.1`.
- Image yang sama dengan `images.*` di manifest. Redis kosong. Drill **tidak boleh menyentuh layanan production**:
  env API/worker drill memakai `NODE_ENV=staging`, SMTP tiruan (mis. Mailpit lokal, karena penerapan ulang ledger dapat
  mengirim email "penghapusan selesai"), tanpa `FCM_*` (push nonaktif), dan TANPA `DELETION_LEDGER_S3_*` (worker drill
  tidak menulis ke bucket ledger production; bucket hanya dibaca restore.sh dengan kunci hanya-baca). Secret JWT, QR dan
  FILE_URL_SECRET drill dibuat baru; **TOTP_ENC_KEY wajib sama dengan production** (secret TOTP admin di database
  terenkripsi dengannya; tanpa itu login MFA drill gagal) dan diambil dari password manager, begitu pula
  OTP_HMAC_SECRET bila backup code ikut diuji.
- Lingkungan dimusnahkan setelah drill (hapus VPS/volume), dicatat di bukti.

### 8.2 Akun admin drill

Satu akun admin khusus `drill-admin@kapdh.or.id` (peran `admin`, tanpa izin atau izin baca minimum) dibuat lewat
undangan biasa di production, dengan TOTP terdaftar. Sandi dan secret TOTP hanya di password manager; saat drill
ditulis ke berkas 0600 di host drill (`DRILL_ADMIN_PASSWORD_FILE`, `DRILL_ADMIN_TOTP_SECRET_FILE`) dan dihapus sesudahnya.

### 8.3 Langkah

| #   | Langkah                                                                                                                                                                                                                                                                                  | Catat                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | Mulai stopwatch: **T0** = mulai drill (dianggap waktu bencana)                                                                                                                                                                                                                           | waktu                                          |
| 2   | Siapkan host bersih (bagian 7 langkah 2-5; secret drill sesuai 8.1)                                                                                                                                                                                                                      | waktu selesai                                  |
| 3   | `sudo ... restore.sh --target-kind drill` (root; baseline PRD 8.2 langkah 1: tambah `--baseline-empty`)                                                                                                                                                                                  | `restore_seconds`, folder bukti                |
| 4   | Nyalakan sesuai bagian 7 langkah 7: Redis, API drill satu replika di 127.0.0.1 (readiness `deletion_ledger: ok`), worker, lalu `VERIFY_API_URL=http://127.0.0.1:3000 verify-restore.sh --post-start --manifest <bukti>/manifest.json --ledger-dir <bukti>/ledger` dengan `DRILL_ADMIN_*` | `verify-report-post-start-*.txt` (http.* PASS) |
| 5   | Pemeriksaan manual PRD 5.5: buka web admin drill lewat tunnel SSH, lihat 3 anggota acak, 1 payment paid, 1 tiket, 1 room chat (riwayat dari bergabung), 1 berkas bukti                                                                                                                   | daftar id yang diperiksa (tanpa nama)          |
| 6   | Penghapusan terdahulu: ambil 1-3 nomor permintaan dari `ledger-reapply.log`; akun berstatus deleted, tidak dapat login                                                                                                                                                                   | nomor permintaan                               |
| 7   | **T1** = semua pemeriksaan lulus (layanan siap dibuka)                                                                                                                                                                                                                                   | waktu                                          |
| 8   | Musnahkan lingkungan drill                                                                                                                                                                                                                                                               | waktu                                          |

### 8.4 Mengukur RPO dan RTO

- **RTO aktual = T1 − T0** (termasuk penyiapan host, bukan hanya durasi skrip). Lulus bila ≤ 4 jam. Bila waktu
  penyiapan host mendominasi, simpan image/skrip penyiapan siap pakai (template VPS) sebagai perbaikan.
- **RPO aktual = T0 − `db_snapshot_captured_at`** (di `summary.txt`: `backup_age_at_start_seconds`). Lulus bila ≤ 24 jam.
  Ini batas atas data yang hilang bila bencana terjadi pada T0. Untuk berkas, titiknya `files_snapshot_started_at`.
  Penghapusan akun memiliki RPO ≈ 0 karena ledger luar VPS ditulis sinkron (D5-07).
- Bila salah satu gagal: buka tiket perbaikan, ulangi drill paling lambat dua minggu kemudian.

### 8.5 Daftar bukti drill (paket penerimaan PRD 9.3, U-11)

Simpan di folder `docs/qa/restore-drills/<yyyy-mm>/` (templat `docs/qa/restore-drills/TEMPLATE.md`; tanpa data
pribadi) atau arsip terkendali yang dirujuk dari sana. Subfolder `ledger/` di folder bukti (id akun terhapus dan object
key) TIDAK disalin ke repo; ia ikut dimusnahkan bersama lingkungan drill:

- [ ] `summary.txt`, `timeline.txt`, `restore.log` dari folder bukti
- [ ] `manifest.json` (salinan; tanpa data pribadi) dan id snapshot `kapdh-db`/`kapdh-files`
- [ ] `verify-report.txt` (sebelum layanan, dari restore.sh) dengan **0 FAIL**
- [ ] `verify-report-post-start-*.txt` dengan **0 FAIL**, termasuk `http.ready` (deletion_ledger=ok), `http.admin.login`,
      `http.admin.mfa`, `http.berkas.publik` PASS (baseline kosong: `http.admin.*` dan `super_admin.aktif` WARN)
- [ ] `ledger-reapply.log` (hanya nomor permintaan dan jumlah) dengan `Gagal : 0`
- [ ] `outbox.txt` (jumlah event per status setelah lease dilepas)
- [ ] Catatan langkah 5-6 (id/nomor yang diperiksa, hasil)
- [ ] T0, T1, RTO aktual, RPO aktual, lulus/gagal terhadap N-06
- [ ] Versi image (manifest), versi alat (`restic version`, `rclone version`, `pg_restore --version`)
- [ ] Bukti pemusnahan lingkungan drill
- [ ] Tanda tangan pengelola infra dan Super Admin; saksi QA

## 9. Kunci dan akses

- Kata sandi restic: password manager pemilik produk + cadangan (D9), salinan cetak di brankas terpisah. Rotasi:
  `restic key add` (kunci baru) → perbarui `/etc/kapdh/restic-password` → `restic key remove <id-lama>`; catat di audit
  operasional. Kehilangan kata sandi = seluruh backup tidak dapat dibuka; segera buat repositori baru dan backup penuh.
- Akses root/Coolify dan bucket hanya pemilik produk dan satu cadangan dengan 2FA (D9).
- Setiap akses ke backup di luar jadwal (unduh manual, restore ad hoc) dicatat di log insiden/operasional.

## 10. Retensi dan D2

- Janji D2 kepada pengguna: backup berotasi 30 hari. Data akun yang dihapus hilang dari backup paling lambat
  `RETENTION_DAYS + BUCKET_NONCURRENT_DAYS` ≤ 30 hari sesudah backup terakhir yang memuatnya; backup.sh menolak nilai
  yang melampauinya, dan production wajib `RESTIC_PRUNE=1`.
- Tiga mekanisme per run: (1) `restic forget --tag kapdh-db --keep-within <RETENTION_DAYS>d`; (2) snapshot berkas
  dilupakan bila dump dengan `backup_id` yang sama sudah dilupakan (keep-within restic dihitung per grup dari
  snapshot terbaru grup itu, sehingga tanpa pasangan manifest tertua dapat merujuk snapshot berkas yang sudah
  dibuang); (3) `restic prune --max-unused 0`, karena bawaan restic menoleransi 5 % data tak terpakai dan pack yang
  bercampur blob hidup dan blob akun terhapus tidak akan dikemas ulang.
- Versi lama objek di bucket backup (`BUCKET_NONCURRENT_DAYS`) wajib sama dengan aturan lifecycle penyedia (bagian 3
  langkah 1). Perubahan retensi atau masa versi lama memerlukan persetujuan pemilik D2 (pemilik produk).
- Backup yang memuat akun terhapus hanya boleh dipulihkan dengan penerapan ulang ledger (restore.sh mewajibkannya).
- Log diagnostik backup/restore tidak memuat data pribadi; folder bukti hanya angka, id dan nomor permintaan.

## 11. Batasan yang diketahui

- Belum dijalankan terhadap layanan sungguhan (lihat Status bukti). Drill staging pertama wajib membuktikan: restore
  `pg_restore` dari stdin (jalur `PG_EXEC`) untuk dump yang dibuat `pg_dump` lewat `docker exec`, perilaku `restic
restore <id>:<path>`, filter rclone `--include`, object lock penyedia dengan header Content-MD5, bentuk `snapshot_id`
  pada `restic backup --json` (penuh atau pendek; retensi menerima keduanya) dan urutan kunci `restic snapshots --json`
  yang dibaca retensi berpasangan (bila tidak terbaca, retensi dibatalkan dan run gagal, bukan membuang snapshot),
  `CONTAINER_*` berlabel lewat Docker sungguhan, serta CLI ledger-reapply di kontainer membaca `<bukti>/ledger`
  milik 1000:1000 (bind mount `:ro`).
- Skrip backup/restore/verifikasi berkas hanya mendukung `STORAGE_DRIVER=local`. Sebelum pindah ke S3 (PRD 5.4), ikuti
  docs/runbooks/storage-migration.md bagian 7 (backup berkas S3) dan perbarui skrip.
- Smoke test HTTP otomatis hanya login/MFA admin drill, `/admin/me`, health dan berkas publik; pemeriksaan anggota,
  tiket dan chat di drill masih manual (bagian 8.3 langkah 5).
