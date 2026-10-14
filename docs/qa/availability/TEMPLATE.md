# Laporan ketersediaan <yyyy-mm> (templat, N-05)

Salin ke `docs/qa/availability/<yyyy-mm>.md` pada awal bulan berikutnya. Prosedur: `docs/runbooks/monitoring.md`
bagian 7. Sasaran usulan 99,5 % per bulan untuk API publik dan auth (ukuran: monitor 2 readiness), diukur Uptime Kuma
di luar VPS; downtime deployment tetap dihitung.

| Monitor (Uptime Kuma) | Uptime 30 hari | Gangguan (jumlah, total menit) |
| --------------------- | -------------- | ------------------------------ |
| 1 API liveness `/api/v1/health` | | |
| **2 API readiness `/api/v1/health/ready` (ukuran N-05)** | | |
| 3 Konfigurasi publik `/api/v1/public/config` | | |
| 4 Web admin | | |
| 5 Situs publik | | |
| 6 Realtime WS (Push) | | |

**N-05 bulan ini:** ……… % → lulus / tidak lulus (≥ 99,5 %).

## Insiden dan deployment yang menimbulkan downtime

| Mulai (WIB) | Selesai (WIB) | Durasi | Penyebab | Post-mortem / tiket |
| ----------- | ------------- | ------ | -------- | ------------------- |
| | | | | |

## Alert lain bulan ini (ringkas)

Backup (umur/integritas), disk, worker, outbox, penyedia email/push, penghapusan akun, antrean bayar: jumlah alert,
alert palsu, perubahan ambang yang dilakukan.

## Tindakan bila < 99,5 %

| Tindakan | Pemilik | Tenggat |
| -------- | ------- | ------- |
| | | |

Disusun oleh pengelola infra ……; ditinjau Super Admin ……
