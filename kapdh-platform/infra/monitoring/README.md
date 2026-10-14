# infra/monitoring — pemeriksa untuk Uptime Kuma

Pemeriksa yang berjalan di VPS (cron/systemd) dan mengirim heartbeat ke monitor Push Uptime Kuma di luar VPS (PRD 5.4,
5.5, N-05; D9). Daftar monitor, rute alert, GlitchTip dan laporan ketersediaan bulanan: `docs/runbooks/monitoring.md`.

| Berkas                                | Monitor Push                                                                                                                    | Jadwal usulan |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `check-host.sh`                       | `KUMA_PUSH_DISK_WARN` (≥ 60 % atau berkas > 20 GB), `KUMA_PUSH_DISK_CRIT` (≥ 80 %)                                              | 5 menit       |
| `check-app.sh` + `sql/app-health.sql` | outbox (umur/dead), penyedia email/push, penghapusan akun (termasuk ledger luar VPS), antrean bukti bayar; role `kapdh_monitor` | 5 menit       |
| `check-worker.sh`                     | `GET /healthz` worker (lewat port loopback atau `docker exec`)                                                                  | 2 menit       |
| `check-backup.sh`                     | umur snapshot restic terbaru (> 26 jam = down, RPO N-06) dan `restic check` mingguan                                            | setiap jam    |
| `realtime-probe.mjs`                  | WebSocket Socket.IO `/realtime` (Node ≥ 22)                                                                                     | 2 menit       |
| `monitoring.env.example`              | contoh `/etc/kapdh/monitoring.env` (URL Push berisi token: 0600)                                                                |               |
| `test/dry-run.sh`                     | uji kering keputusan up/down dengan curl/restic/psql/docker tiruan (36 pemeriksaan)                                             |               |

Jadwal cron siap pakai: `infra/backup/cron/kapdh-backup`. Pesan heartbeat hanya angka dan kode isu (N-14).

```sh
sh infra/monitoring/test/dry-run.sh
KAPDH_BACKUP_ENV=/etc/kapdh/monitoring.env KAPDH_BACKUP_SECRETS=/dev/null infra/monitoring/check-host.sh
```
