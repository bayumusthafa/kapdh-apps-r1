# Runbook: restore backup tanpa menghidupkan kembali akun yang sudah dihapus

Pemilik: pengelola infra (PRD 5.5). Persetujuan bisnis dan komunikasi ke pengguna: Super Admin.
Rujukan: AC F14-6, PRD 9.2 skenario 8, PRD 3.5/6.4 (nomor anggota N tidak pernah dipakai ulang), N-06, U-09; ADR-014,
ADR-019.

Runbook ini menjelaskan sisi aplikasi dari sebuah restore: urutan langkah yang menjaga akun yang dihapus sesudah titik
backup tetap terhapus. Prosedur operator lengkap ada di `docs/runbooks/backup-restore.md`: di sana
`infra/backup/restore.sh` menjalankan langkah 2 sampai 5 secara otomatis pada lingkungan bersih (menolak database atau
volume berkas yang tidak kosong), lalu `verify-restore.sh` memeriksa total uang, jumlah data, ledger yang diterapkan,
berkas dan readiness. Runbook itu juga memuat restore drill bulanan beserta pengukuran RPO/RTO (N-06, D2-03).
Ikuti setiap langkah berurutan. **Langkah 5 memblokir: layanan tidak dibuka sampai CLI keluar 0 dan readiness 200.**

## Latar belakang

- Setiap penghapusan akun menulis entri ke **deletion ledger** eksternal di object storage:
  `ledger/account-deletions/<yyyy>/<mm>/<nomor-permintaan>.json` (state `requested`, lalu `completed`). Entri hanya
  berisi id, object key dan `member_seq_floor` (nomor N tertinggi yang sudah diterbitkan). Tanpa data pribadi.
- Setiap entri JUGA ditulis sinkron, sebelum data apa pun dihapus, ke **bucket khusus di luar VPS**
  (`DELETION_LEDGER_S3_*`, key append-only `account-deletions/<yyyy>/<mm>/<permintaan>/<state>-<uuid>.json`,
  versioning + object lock; ADR-019, audit D5-07). Setelah VPS hilang, bucket inilah ledger terbaru, karena prefix
  `ledger/` di `/data/files` hanya sebaru backup harian terakhir.
- Ledger juga menyimpan objek **kepala** `ledger/account-deletions-head.json` yang menunjuk permintaan terbaru.
- `GET /api/v1/health/ready` menjawab **503** dengan `checks.deletion_ledger: "fail"` selama database belum mengenal
  permintaan terbaru di kepala ledger (database pulihan yang ledger-nya belum diterapkan ulang), atau selama kepala
  tidak terbaca. Jawabannya 200 dengan `deletion_ledger: "ok"` setelah `ledger-reapply` dijalankan.
- Penerapan ulang ledger juga mencatat floor N setiap entri di database. Alokasi nomor anggota melompati floor itu,
  sehingga N yang terbit sesudah titik backup tidak pernah diterbitkan lagi, walaupun sequence pulihan
  `app.membership_no_seq` lebih tua.

Batasan: pemeriksaan readiness hanya dapat mendeteksi database basi selama storage masih menyimpan kepala ledger yang
lebih baru. Bila database DAN object storage sama-sama berasal dari backup yang sama, kepala ledger sama tuanya dengan
database dan pemeriksaan lulus. Karena itu langkah 2 dan 5 wajib di setiap restore, apa pun kata readiness, dan
langkah 2 selalu berawal dari bucket luar VPS.

## Langkah

1. **Hentikan lalu lintas dan job.** Skala API dan worker ke 0 di Coolify (atau `docker compose stop api worker` dengan
   berkas Compose cadangan). PostgreSQL boleh tetap berjalan. Redis tidak dibutuhkan langkah 2-5: CLI ledger-reapply
   sengaja tidak membuat klien Redis. Pastikan health check Coolify untuk API memakai `/api/v1/health/ready` (bukan
   `/api/v1/health`), sehingga 503 menahan kontainer di luar rotasi.

2. **Simpan deletion ledger terbaru sebelum menyentuh storage.** Salin bucket luar VPS lebih dahulu dengan kunci
   hanya-baca: `rclone copy kapdhledger:<DELETION_LEDGER_S3_BUCKET> /restore/ledger/offsite --include
   "/account-deletions/**"`. Lalu, bila storage live masih ada, salin seluruh prefix `ledger/`-nya juga:
   - `STORAGE_DRIVER=local`: `cp -a "$STORAGE_LOCAL_ROOT/ledger" /restore/ledger/latest/`
   - `STORAGE_DRIVER=s3`: `rclone copy <remote>:<S3_BUCKET>/ledger /restore/ledger/latest/ledger`

   Bila storage live hilang, pakai salinan bucket ditambah salinan ledger dari manifest backup terbaru (snapshot
   `kapdh-db`, folder `ledger-offsite/`). Hanya bila bucket itu sendiri hilang permanen restore boleh lanjut tanpanya
   (`restore.sh --allow-missing-offsite-ledger`), dan hal itu wajib dicatat dan dilaporkan (AC F14-6).
   Jadikan folder dapat dibaca pengguna image (`node`, uid 1000): `chown -R 1000:1000 /restore/ledger`.

3. **Pulihkan database.** Pulihkan dump terpilih dengan role pemilik/migrasi, jalankan job migrasi sekali bila image
   rilis lebih baru dari skema backup (job rilis PRD 5.5; contoh `MIGRATE_CMD` di `infra/backup/backup.env.example`),
   lalu terapkan ulang `infra/db/roles.sql` agar `kapdh_app`, `kapdh_worker` dan `kapdh_audit_purge` mendapat grant-nya.
   Redis boleh dikosongkan; isinya dibangun ulang dari state durable dan outbox.

4. **Pulihkan berkas, lalu kembalikan ledger terbaru.** Bila berkas juga harus dipulihkan (restic dari `/data/files`,
   atau restore bucket), pulihkan sekarang dan pastikan pemiliknya 1000:1000. Lalu salin ledger dari langkah 2 ke atas
   prefix `ledger/` pulihan (`cp -a /restore/ledger/latest/ledger "$STORAGE_LOCAL_ROOT/"`, atau `rclone copy` balik
   ke bucket). Entri ledger hanya bertambah (entri `completed` tidak pernah diganti `requested`), sehingga salinan
   terbaru selalu menang.

5. **Terapkan ulang deletion ledger (memblokir).** Dengan env worker (koneksi sebagai `kapdh_worker`, anggota
   `kapdh_audit_purge`) dan image API yang sama dengan rilis (manifest `images.api`):

   ```sh
   docker run --rm --network <jaringan-db> --env-file /etc/kapdh/worker.env \
     -v /data/files:/data/files -v /restore/ledger:/ledger:ro <image-api@sha256:...> \
     node dist/modules/account/ledger-reapply.cli.js \
     --dir /ledger/offsite/account-deletions --dir /ledger/latest/ledger/account-deletions
   ```

   Di kontainer image worker path-nya `node node_modules/@kapdh/api/dist/modules/account/ledger-reapply.cli.js`
   (`docs/runbooks/compose-cadangan.md` bagian 2a). Jangan menambahkan `--user 0`: CLI menulis ulang entri dan kepala
   ledger di `/data/files`, dan API (pengguna `node`) harus tetap dapat menimpanya. Di repo pengembangan saja:
   `pnpm --filter @kapdh/api account:ledger-reapply -- --dir ...` (pnpm tidak ada di image production).

   `--dir` boleh diulang: entri dari semua salinan digabung per permintaan (`completed` menang, object key digabung,
   floor N tidak pernah turun, salinan yang bertentangan ditolak). Tanpa `--dir` dan dengan `STORAGE_DRIVER=local`, CLI
   membaca `$STORAGE_LOCAL_ROOT/ledger/account-deletions`. Penerapan ulang juga menulis ulang entri dan kepala di
   StorageDriver, sehingga readiness mengenali permintaan terbaru. Keluaran hanya nomor permintaan dan jumlah:

   | Baris | Arti |
   | --- | --- |
   | `Diterapkan ulang` | Akun yang ada di backup dan dihapus lagi (berkas, profil, kredensial). Permintaan yang masih `requested` diselesaikan sekarang, termasuk email selesai. |
   | `Sudah terhapus` | Sudah terhapus di backup. Hanya floor N yang dicatat. |
   | `Tidak ada di backup` | Terdaftar sesudah titik backup. Baris permintaan `completed` dengan floor N dicatat, sehingga readiness mengenali permintaan itu dan N tidak dipakai ulang. |
   | `Gagal` | Wajib 0. Kode keluar 1 berarti layanan tetap tertutup: perbaiki penyebabnya (biasanya akses storage, izin baca folder ledger, atau role `kapdh_audit_purge`) dan jalankan ulang langkah ini. CLI idempoten. |

6. **Nyalakan API dan periksa readiness.** Nyalakan SATU replika API saja, belum dibuka untuk publik.
   `GET /api/v1/health/ready` wajib 200 dengan `"deletion_ledger": "ok"`. Bila 503 dengan `"deletion_ledger": "fail"`,
   ledger yang diterapkan lebih tua dari kepala di storage, atau kepala rusak: kembali ke langkah 5 dengan salinan
   ledger terbaru. Menjalankan ulang langkah 5 menulis ulang kepala.

7. **Nyalakan worker dan replika API lainnya.** Worker baru dinyalakan sesudah readiness terbukti, agar replay outbox
   (email/push) tidak berjalan di atas ledger yang belum diterapkan. Urutan ini sama dengan
   `docs/runbooks/backup-restore.md` bagian 7 langkah 7.

8. **Pemeriksaan sesudah restore** (PRD 5.5): login admin dengan MFA, daftar anggota, total uang, tiket, chat, berkas
   privat, dan penghapusan terdahulu (`verify-restore.sh --post-start --ledger-dir <salinan ledger>` mengotomatiskan
   sebagian). Untuk nomor permintaan yang dicetak di langkah 5, kueri ini hanya boleh mengembalikan `deleted` (akun
   yang tidak ada di backup tidak punya baris `users` dan tidak mengembalikan apa pun):
   `select u.status, count(*) from app.account_deletions d join app.users u on u.id = d.user_id where d.request_number in (...) group by 1`.
   Opsional, hanya informasi: bandingkan `select last_value from app.membership_no_seq` dengan
   `select max((ledger->>'member_seq_floor')::bigint) from app.account_deletions`. Alokasi melompati floor dengan
   sendirinya. Untuk tetap menyelaraskan sequence, jalankan
   `select setval('app.membership_no_seq', greatest(last_value, <floor>))` sebagai role pemilik (`kapdh_worker` tidak
   punya hak atas sequence).

9. **Komunikasi.** Data yang ditulis sesudah titik backup (pembayaran, pendaftaran, chat) hilang. Super Admin memberi
   tahu pengguna terdampak (PRD 8.4, "Data/berkas hilang atau rusak").

## Bukti

- `kapdh-platform/apps/api/test/account/deletion-job.e2e.test.ts`: "AC F14-6, PRD 9.2 #8: database dipulihkan
  (storage tetap terkini) -> GET /health/ready 503 deletion_ledger fail sampai ledger-reapply; sesudahnya 200", dan uji
  restore yang memeriksa floor N untuk akun yang tidak ada di backup (D5-05).
- `kapdh-platform/apps/api/test/pg/account-deletion.pg.test.ts`: CLI `ledger-reapply` di PostgreSQL 17, termasuk saat
  `REDIS_URL` menunjuk Redis yang belum menyala.
- `kapdh-platform/apps/api/test/pg/deletion-e2e.pg.test.ts`: D5-05 di PostgreSQL 17.
- `kapdh-platform/apps/api/test/account/deletion-job.e2e.test.ts`: "AC F14-6, D5-07: VPS hilang ..." (database dan
  berkas dari backup yang lebih tua dari penghapusan, ledger diterapkan ulang dari salinan bucket luar VPS, readiness
  200) dan "D5-07: penulisan ke ledger luar VPS gagal ..." (tidak ada data yang dihapus sebelum entri luar VPS ada).
- `kapdh-platform/infra/backup/test/dry-run.sh`: `restore.sh` meneruskan salinan bucket, salinan backup dan ledger
  berkas pulihan ke CLI dari `<bukti>/ledger`, menolak pengguna selain root/`FILES_OWNER`, dan berhenti bila CLI keluar
  bukan nol (alat tiruan; drill staging masih wajib).
