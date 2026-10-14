# ADR-019: Deletion ledger juga ditulis sinkron ke bucket append-only di luar VPS

- Status: Diterima (Fase E, menutup audit D5-07); melengkapi ADR-014
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: AC F14-6; F-14; D2; D9; PRD 5.5 (manifest + deletion ledger, RPO ≤ 24 jam), 8.4; audit D5-07
- Bukti di kode: `kapdh-platform/apps/api/src/modules/account/offsite-deletion-ledger.ts`
  (`OffsiteDeletionLedger`, `OffsiteLedgerWriteError`), `deletion-ledger.ts` (`appendLedgerEntry`,
  `offsiteLedgerObjectKey`, `mergeLedgerEntries`), `deletion-steps.ts` (`ledgerOpen`, `ledgerFinal`),
  `ledger-reapply.cli.ts` (`--dir` berulang); `packages/config` (`DELETION_LEDGER_S3_*`, wajib untuk worker
  production); `packages/storage` (`S3Driver` opsi `contentMd5`); `infra/backup/{backup.sh,restore.sh}`; uji
  `apps/api/test/account/offsite-ledger.test.ts`, `apps/api/test/account/deletion-job.e2e.test.ts`,
  `apps/api/test/pg/account-deletion.pg.test.ts`

## Konteks

ADR-014 menulis ledger ke StorageDriver. Dengan `STORAGE_DRIVER=local` itu adalah volume `/data/files` di VPS yang
sama, yang hanya disalin keluar VPS sekali sehari (ADR-018). Bila VPS hilang, database dan ledger dipulihkan dari titik
backup yang sama; akun yang dihapus sesudah titik itu tidak punya entri ledger di mana pun dan hidup kembali lengkap
(profil, email, hash sandi, berkas). Gerbang readiness ADR-014 juga tidak membantu karena kepala ledger ikut tua.

## Keputusan

1. Langkah `ledger_open` dan `ledger_final` job penghapusan menulis entri (skema yang sama, termasuk
   `member_seq_floor`) LEBIH DAHULU ke bucket S3-compatible khusus di luar VPS (`DELETION_LEDGER_S3_*`), baru ke
   StorageDriver. Galat penulisan menggagalkan langkah (`OffsiteLedgerWriteError`, diulang dengan backoff), sehingga
   data pribadi tidak pernah dihapus tanpa jejak di luar VPS. Production menolak langkah bila bucket tidak
   dikonfigurasi; validasi env worker production juga mewajibkannya.
2. **Append-only:** setiap penulisan memakai key baru `account-deletions/<yyyy>/<mm>/<nomor>/<state>-<uuidv7>.json`
   dan tidak pernah membaca, menimpa atau menghapus, sehingga kunci worker cukup hak tulis objek dan bucket memakai
   versioning + object lock (Content-MD5 dikirim untuk bucket berkunci). Bucket wajib berbeda dari bucket berkas.
3. Pembaca (`mergeLedgerEntries`) menggabungkan semua versi per permintaan: `completed` mengalahkan `requested`, object
   key digabung, floor N tidak turun; entri dengan `deletion_id` sama tetapi akun/nomor berbeda ditolak.
4. Backup menyalin bucket (rclone, kunci hanya-baca) ke snapshot `kapdh-db` sebagai bukti; restore SELALU menyalin
   bucket TERBARU dan memberikannya ke `ledger-reapply` bersama salinan backup dan ledger di berkas pulihan
   (`--dir` berulang). Restore tanpa bucket hanya dengan `--allow-missing-offsite-ledger` yang tercatat di bukti.

## Alternatif yang dipertimbangkan

- **Backup berkas lebih sering (per jam):** memperkecil jendela tetapi tidak menutupnya, dan menambah biaya.
- **Replikasi database ke luar VPS:** menyalin juga data pribadi yang justru ingin dihapus; lebih berat dioperasikan.
- **Menulis ke bucket berkas S3 yang sama:** bucket berkas dapat dihapus/dipulihkan bersama data; kunci aplikasi
  memegang hak hapus. Bucket khusus dengan object lock memisahkan failure domain dan hak.

## Konsekuensi

- RPO penghapusan akun ≈ 0 walau RPO data umum 24 jam; dibuktikan pada restore drill (backup-restore.md bagian 8).
- Ketersediaan bucket ledger menjadi dependensi job penghapusan (bukan API): kegagalan terlihat sebagai permintaan
  `failed` dengan `ledger_*:OffsiteLedgerWriteError` dan monitor "Penghapusan akun" (monitoring.md). Batas 7 hari
  F-14 memberi waktu perbaikan.
- Kepala ledger dan gerbang readiness ADR-014 tetap berlaku; penerapan ulang dari bucket menulis ulang entri dan
  kepala di StorageDriver sehingga readiness kembali 200.
