# Restore drill <yyyy-mm> (templat)

Salin ke `docs/qa/restore-drills/<yyyy-mm>/README.md`. Prosedur: `docs/runbooks/backup-restore.md` bagian 8. Tanpa data
pribadi: hanya angka, id snapshot, nomor permintaan penghapusan dan id acak yang diperiksa.

| Butir | Nilai |
| ----- | ----- |
| Tanggal drill | |
| Pelaksana (pengelola infra) / saksi (QA) | |
| Lingkungan drill (VPS sementara, region, spesifikasi) | |
| Backup dipakai: `backup_id`, snapshot `kapdh-db`, snapshot `kapdh-files` | |
| `db_snapshot_captured_at` (manifest) | |
| Image dari manifest (`images.api`, `images.worker`) | |
| Versi alat (`restic version`, `rclone version`, `pg_restore --version`) | |
| T0 (mulai drill = waktu "bencana") | |
| Selesai `restore.sh` (`restore_seconds`) | |
| T1 (semua pemeriksaan lulus, layanan siap dibuka) | |
| **RTO aktual = T1 − T0** (sasaran ≤ 4 jam) | |
| **RPO aktual = T0 − `db_snapshot_captured_at`** (sasaran ≤ 24 jam) | |
| Lulus N-06? | ya / tidak |

## Hasil

- [ ] `verify-report.txt`: 0 FAIL (lampirkan; WARN dicatat dan ditindaklanjuti)
- [ ] `http.admin.login`, `http.admin.mfa`, `http.berkas.publik`, `ready` (dengan `deletion_ledger=ok`) PASS
- [ ] `ledger-reapply.log`: `Gagal : 0`; nomor permintaan yang diterapkan ulang: …
- [ ] `outbox.txt` (jumlah per status setelah lease dilepas)
- [ ] Pemeriksaan manual (3 anggota acak, 1 payment paid, 1 tiket, 1 room chat, 1 bukti bayar): id yang diperiksa …
- [ ] Penghapusan terdahulu: 1-3 nomor permintaan, akun berstatus `deleted` dan tidak dapat login
- [ ] Lingkungan drill dimusnahkan (waktu, bukti penghapusan VPS/volume)

## Temuan dan tindak lanjut

| Temuan | Pemilik | Tenggat | Tiket |
| ------ | ------- | ------- | ----- |
| | | | |

Tanda tangan: pengelola infra …… Super Admin …… saksi QA ……
