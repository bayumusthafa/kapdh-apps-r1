# @kapdh/worker

Runtime worker KAPDH (PRD 5.1, 5.5, N-14; ARCHITECTURE §4.8). Prosesor job hidup di modul API
(`modules/<m>/<m>-jobs.module.ts`) dan dimuat lewat `@kapdh/api/worker`; paket ini hanya menjalankannya.

| Komponen          | Perilaku                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatcher outbox | Poll setiap `OUTBOX_POLL_INTERVAL_MS` (2 s). Klaim `FOR UPDATE SKIP LOCKED` + lease `locked_until` sebanyak slot antrean kosong, enqueue dengan jobId = dedup key + token lease. Handler topik → `dispatched`, atau `failed` + backoff eksponensial + `last_error` aman, atau `dead` setelah 10 percobaan. Lease diperpanjang selama handler berjalan; proses mati → lease habis → diklaim ulang. |
| Antrean           | BullMQ + ioredis bila `REDIS_URL` diisi (wajib di production; prefix `kapdh:<NODE_ENV>:bull`), inline dalam proses bila tidak. Data job hanya rujukan (id + lease / nama job + slot).                                                                                                                                                                                                             |
| Penjadwal         | Semua job `registerScheduled` dijadwalkan per slot `floor(now / everyMs)`. Hanya pemegang kunci advisory sesi PostgreSQL (`ADVISORY_LOCK_KEYS.workerSchedulerLeader`, koneksi khusus `kapdh-worker-leader`) yang menjadwalkan; instance lain standby dan mengambil alih bila leader berhenti/mati.                                                                                                |
| Health            | `GET /healthz` di `WORKER_HEALTH_HOST:WORKER_HEALTH_PORT` (0.0.0.0:3001). 200 `ok`/`degraded` (backlog outbox > 5 menit, event `dead`), 503 `error` (DB/Redis tidak terjangkau, loop macet) atau `stopping`. Berisi umur outbox pending tertua, keterlambatan jatuh tempo, tick penjadwal terakhir. Jangan dirutekan publik.                                                                      |
| Shutdown          | SIGTERM/SIGINT: berhenti poll dan tick, tunggu job berjalan sampai `WORKER_SHUTDOWN_TIMEOUT_MS` (25 s), lepas kunci leader, tutup koneksi dan pool. Sinyal kedua = keluar paksa. `stop_grace_period` container > timeout + 10 s.                                                                                                                                                                  |
| Log               | JSON pino `service: kapdh-worker`, `job_id`/`request_id` terikat, redaksi kunci rahasia, galat hanya bentuk aman.                                                                                                                                                                                                                                                                                 |

Env (validasi `loadWorkerEnv`, `packages/config`): basis API minus secret JWT/OTP/TOTP/QR, plus `WORKER_CONCURRENCY`,
`WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST`, `OUTBOX_POLL_INTERVAL_MS`, `WORKER_SHUTDOWN_TIMEOUT_MS`. `DATABASE_URL` memakai
role `kapdh_worker` (`infra/db/roles.sql`). Koneksi per instance: pool kerja (`WORKER_CONCURRENCY + 1`), 1 koneksi kunci
leader, 1 koneksi health.

Perintah (dari `kapdh-platform/`): `pnpm --filter @kapdh/worker build`, `... start`, `... test` (PGlite),
`... test:pg` (PostgreSQL 17 embedded: leader dua worker, SKIP LOCKED lintas koneksi, runtime lengkap sebagai
`kapdh_worker`). Image: `docker build -f infra/Dockerfile.worker .`.
