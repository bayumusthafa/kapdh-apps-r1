# Restore drill 2026-10

Prosedur: `docs/runbooks/backup-restore.md` bagian 8. Tanpa data pribadi: hanya angka, id snapshot, dan id acak yang
diperiksa. Bukti asli disimpan di VPS production `/root/bukti-drill-202610/` (root 700): `summary.txt`,
`timeline.txt`, `restore.log`, `outbox.txt`, `manifest.json`, `ledger-reapply.log`, `verify-report.txt`,
`verify-report-post-start-20261015T152523Z.txt`, `f-T0.txt`, `f-T1.txt`, `f-versi-alat.txt`, `f-rto-rpo.txt`,
`pemusnahan.txt`. Folder `ledger/` tidak disalin dan ikut dimusnahkan.

| Butir                                                              | Nilai                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tanggal drill                                                      | 15 Oktober 2026 (UTC)                                                                                                                                                                                                                                                                                                      |
| Jenis                                                              | drill penuh (U-12), login/MFA admin drill belum diuji (akun `drill-admin@kapdh.or.id` belum ada)                                                                                                                                                                                                                           |
| Pelaksana (pengelola infra) / saksi (QA)                           | Bayu Musthafa (pemilik produk, pelaksana) / ……                                                                                                                                                                                                                                                                             |
| Lingkungan drill                                                   | VPS production yang sama (IDCloudHost, 4 vCPU, 3,8 GiB RAM + 4 GiB swap), jaringan Docker `--internal` `kapdh-restore` tanpa jalan keluar, PostgreSQL drill terpisah (`postgres:17.11-alpine3.24`), API drill satu replika, tanpa worker drill dan tanpa Redis                                                             |
| Backup dipakai                                                     | `backup_id` `kapdh-production-20261015T151146Z`; snapshot `kapdh-db` `834f1dc055b4f38585813fc2870a528ca5b585ac7060765c0e537a3e11062ae4`; snapshot `kapdh-files` `4c88f5d24b27cb728f2506d002f38960cdadfa0524153e5508a7f733e6c736ce` (repositori restic `s3:https://is3.cloudhost.id/kapdh-prod-backup`)                     |
| `db_snapshot_captured_at` (manifest)                               | 2026-10-15T15:11:46Z                                                                                                                                                                                                                                                                                                       |
| Image dari manifest                                                | api `ghcr.io/bayumusthafa/kapdh-api:sha-82cc667a4d4677556e9556f39fec89bd39cbe647@sha256:0b4482284bf50abb827b0cc6981784b377f70c149b008f44b5d130b32b244ff9`; worker `ghcr.io/bayumusthafa/kapdh-worker:sha-82cc667a4d4677556e9556f39fec89bd39cbe647@sha256:0a99e5622ee47c81ed2e40ba8f9c164589debd1717fd8d5adc54aee09f1668cc` |
| Versi alat                                                         | restic 0.19.1 (go1.26.4, linux/amd64); rclone v1.75.2; pg_restore (PostgreSQL) 17.11                                                                                                                                                                                                                                       |
| T0 (mulai drill)                                                   | 2026-10-15T15:18:03Z                                                                                                                                                                                                                                                                                                       |
| Selesai `restore.sh` (`restore_seconds`)                           | 2026-10-15T15:22:32Z (41 detik; umur backup saat mulai 605 detik)                                                                                                                                                                                                                                                          |
| T1 (semua pemeriksaan lulus)                                       | 2026-10-15T15:25:52Z                                                                                                                                                                                                                                                                                                       |
| **RTO aktual = T1 − T0** (sasaran ≤ 4 jam)                         | **7 menit**                                                                                                                                                                                                                                                                                                                |
| **RPO aktual = T0 − `db_snapshot_captured_at`** (sasaran ≤ 24 jam) | **6 menit**                                                                                                                                                                                                                                                                                                                |
| Lulus N-06?                                                        | ya (dengan temuan 1 di bawah)                                                                                                                                                                                                                                                                                              |

Data production saat drill masih minim (2 akun admin, 1 berkas, tanpa anggota, pembayaran, tiket, atau room chat),
sehingga drill ini membuktikan jalur pemulihan lengkap, belum kinerja pada volume data nyata.

## Hasil

- [x] `verify-report.txt` (restore.sh, sebelum layanan): 0 FAIL, 1 WARN (`http`: belum ada API, diuji sesudahnya).
      Jumlah yang cocok dengan manifest: users 2, admins_active 2, super_admins_active 2, payments 0, tickets 0,
      rooms 0, events 0, `paid_total` 0.00, `skema.applied` 9.
- [x] `verify-report-post-start-20261015T152523Z.txt` (sesudah API drill menyala): 0 FAIL, 1 WARN
      (`http.admin.login`, lihat temuan 1).
- [x] `http.health` 200 ok; `http.ready` 200 `database=ok redis=skipped storage=ok deletion_ledger=ok`;
      `http.berkas.publik` PASS (1.975.490 byte). `http.admin.login`/`http.admin.mfa` belum diuji (temuan 1).
- [x] `ledger-reapply.log`: folder ledger 2, entri 0, diterapkan ulang 0, gagal 0 (belum ada permintaan penghapusan
      akun di production).
- [x] `outbox.txt`: `outbox_dispatched=3`, lease lama 0, dead 0.
- [x] Pemeriksaan manual: `app.users` per jenis/status di drill = production (`admin|active|2`). Anggota, pembayaran
      paid, tiket, room chat, dan bukti bayar: tidak ada data (dicatat, bukan gagal).
- [x] Penghapusan terdahulu: tidak ada (0 permintaan).
- [x] Isolasi: API drill tidak dapat menjangkau `https://is3.cloudhost.id` ("terisolasi"); kontainer drill hanya di
      jaringan `kapdh-restore`; API dan worker production tetap `healthy` selama drill.
- [x] Integritas ledger sebelum drill (F1): Object Lock `Enabled COMPLIANCE 35`, 1 versi terkini (`selftest/`), 0 versi
      lama, 0 penanda hapus.
- [x] Lingkungan drill dimusnahkan 2026-10-15T15:26:53Z: kontainer `kapdh-drill-api`/`kapdh-drill-pg`, volume
      `kapdh-drill-pgdata`, jaringan `kapdh-restore`, `/srv/kapdh/drill`, `/var/restore/kapdh` (termasuk `ledger/`),
      dan `/etc/kapdh/drill` (shred). Pemeriksaan sesudahnya: 0 kontainer, 0 volume, 0 jaringan drill.

## Deviasi dari runbook bagian 8

- Drill berjalan di VPS production yang sama dengan pagar isolasi (jaringan internal, database dan secret drill
  terpisah, `NODE_ENV=staging`, SMTP buntu, tanpa ledger S3/FCM/Sentry/Redis), bukan VPS sementara.
- Worker drill tidak dijalankan (RAM terbatas; replay outbox tidak diperlukan pada data ini).
- Pemeriksaan lewat web admin diganti pemeriksaan SQL dan HTTP dari jaringan drill (jaringan sengaja tanpa port).

## Temuan dan tindak lanjut

| Temuan                                                                                                                                                                                           | Pemilik         | Tenggat                               | Tiket |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------- | ----- |
| 1. Akun admin drill (`drill-admin@kapdh.or.id`, TOTP) belum ada, sehingga `http.admin.login`/`http.admin.mfa` tidak diuji. Buat akun drill berizin minimum dan uji pada drill bulanan berikutnya | pengelola infra | drill November 2026                   |       |
| 2. Ulangi drill setelah ada data anggota nyata (pembayaran, tiket, chat) agar pemeriksaan manual dan RTO bermakna                                                                                | pengelola infra | drill bulanan pertama setelah go-live |       |
| 3. Pemantauan backup (Uptime Kuma, `KUMA_PUSH_*`) belum terpasang; kegagalan backup belum membunyikan alarm                                                                                      | pengelola infra | sebelum go-live                       |       |

Tanda tangan: pengelola infra …… Super Admin …… saksi QA ……
