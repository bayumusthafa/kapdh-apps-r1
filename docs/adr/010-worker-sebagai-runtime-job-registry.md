# ADR-010: Worker adalah runtime tipis di atas job registry milik API

- Status: Diterima (Fase B, runtime Fase C)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 5.1, 5.5, 7.2, 9.2 (worker mati setelah commit, job diulang); N-14; ARCHITECTURE §4.1, §4.8
- Bukti di kode: `kapdh-platform/apps/api/src/worker.ts` (`@kapdh/api/worker`: `createWorkerDeps`,
  `createWorkerContext`), `apps/api/src/core/jobs/job-runner.ts`, `apps/api/src/modules/*/*-jobs.module.ts`,
  `apps/api/src/core/core.module.ts` (`API_ONLY_PROVIDERS`), `apps/worker/src/**`, `apps/worker/README.md`,
  `infra/Dockerfile.worker`

## Konteks

Job (pengiriman notifikasi, pengingat event/keanggotaan, pelepasan kursi, penghapusan akun, ekspor audit, cleanup)
memakai aturan domain yang sama dengan endpoint: kernel keanggotaan, registry handler payment, audit, outbox.
Menyalin logika itu ke paket worker berarti dua implementasi aturan bisnis. Di sisi lain worker tidak boleh memegang
secret API (JWT, OTP, TOTP, QR) dan tidak boleh memuat controller HTTP (PRD 5.1 least privilege).

## Keputusan

1. Prosesor job, handler topik outbox, dan handler tipe payment hidup di modul domain API, di berkas
   `modules/<m>/<m>-jobs.module.ts`, dan mendaftar ke `JobRegistry` (`registerScheduled`, `registerTopicHandler`).
   Modul jobs dilarang memuat controller atau provider yang membutuhkan `API_ONLY_PROVIDERS` (TokenService,
   SessionIssuer, PasswordVerifier, guard, gateway, QrTokenService, ...); uji `jobs.e2e` "Batas modul worker" menjaga ini.
2. `apps/worker` hanya runtime: memuat modul jobs lewat `@kapdh/api/worker`, menjalankan
   - dispatcher outbox (poll 2 detik, `FOR UPDATE SKIP LOCKED`, lease `locked_until` dengan pengambilalihan atomik dan
     heartbeat; `dead` setelah 10 percobaan),
   - penjadwal untuk setiap job terdaftar dengan **satu leader** lewat advisory lock sesi
     (`ADVISORY_LOCK_KEYS.workerSchedulerLeader = 4711000520`),
   - antrean BullMQ bila `REDIS_URL` diisi (wajib production), atau driver inline dalam proses bila tidak,
   - endpoint `GET /healthz` (port bawaan 3001, tidak dirutekan publik) dan shutdown halus.
3. Env worker divalidasi `loadWorkerEnv` (`packages/config`) dan tidak menerima secret khusus API; koneksi database
   memakai role `kapdh_worker`.
4. Migrasi tidak pernah dijalankan worker maupun API saat startup (PRD 5.5).

## Alternatif yang dipertimbangkan

- **Worker dengan salinan logika domain**: ditolak (dua sumber aturan).
- **Job berjalan di dalam proses API**: ditolak; job panjang bersaing dengan request, API memegang secret yang tidak
  diperlukan job, dan scaling tidak dapat dipisah.
- **Redis/BullMQ sebagai sumber kebenaran**: ditolak; PRD 5.1 menetapkan outbox di PostgreSQL agar event dapat
  diproses ulang bila Redis hilang.

## Konsekuensi

- Image worker membawa kode API (tanpa controller yang dimuat) dan dependensi workspace; dibangun di CI
  (`infra/Dockerfile.worker`; belum pernah dibangun di mesin build karena tanpa Docker).
- Handler wajib idempoten karena event dapat diproses ulang setelah lease habis.
- Production: `WORKER_CONCURRENCY >= 2` (nilai 1 tidak menyisakan koneksi untuk heartbeat lease), `REDIS_URL` harus
  terjangkau dalam 30 detik setelah start (bila tidak, proses keluar dan orkestrator menjalankan ulang), dan
  `stop_grace_period` > `WORKER_SHUTDOWN_TIMEOUT_MS` + 10 detik.
- Monitor wajib memeriksa `GET /healthz` dengan `status != ok` (kode isu `dispatcher_failing`, `scheduler_failing`,
  `queue_unreachable`, `outbox_lagging`), bukan hanya kode HTTP.
- Jalur BullMQ (skrip Lua) belum diuji terhadap Redis nyata; smoke test staging wajib (lihat `docs/runbooks/go-live.md`).
