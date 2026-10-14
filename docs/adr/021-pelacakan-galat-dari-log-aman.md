# ADR-021: Pelacakan galat GlitchTip dari baris log yang sudah aman, tanpa SDK

- Status: Diterima (Fase E); belum diuji terhadap GlitchTip sungguhan
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 5.5 (monitoring), 7.1 (GlitchTip/Uptime Kuma), 2.4 N-14; D9
- Bukti di kode: `kapdh-platform/apps/api/src/core/logging/error-tracker.ts`, `logger.ts` (`createRootLogger` opsi
  `errorTracking`), `apps/api/src/bootstrap.ts`, `apps/api/src/worker.ts`, `apps/worker/src/main.ts`;
  `packages/config` (`SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`); uji
  `apps/api/src/core/logging/error-tracker.test.ts`; runbook `docs/runbooks/monitoring.md` bagian 5

## Konteks

PRD 7.1 menyebut GlitchTip (kompatibel Sentry) untuk observabilitas. SDK Sentry menangkap pesan galat, breadcrumb,
header dan body request secara bawaan; di aplikasi ini pesan galat dapat memuat SQL beserta parameter (email, hash),
alamat SMTP atau potongan input, yang dilarang N-14. Logger pino sudah menormalkan galat menjadi bentuk aman
(`safeError`: tipe, kode, constraint, frame stack tanpa baris pesan) dan menyensor kunci rahasia.

## Keputusan

1. Bila `SENTRY_DSN` diisi, `createRootLogger` memasang `pino.multistream` dengan target tambahan level `error` ke
   `ErrorTrackerStream`, yang mengubah setiap baris log error/fatal menjadi envelope Sentry dan mengirimnya ke
   `/api/<id-proyek>/envelope/` GlitchTip.
2. Event dibangun dari DAFTAR PUTIH field: pesan log (teks statis), tipe/kode/constraint/tabel/status galat, frame
   stack, service, module, route, `request_id`/`job_id`, lingkungan, rilis. Field lain tidak pernah dikirim.
3. Fire-and-forget dengan batas 30 event per menit dan 5 kiriman bersamaan per proses; kegagalan tidak memengaruhi
   request, job atau logging stdout.

## Alternatif yang dipertimbangkan

- **`@sentry/node`:** fitur lengkap (tracing, breadcrumb), tetapi perlu `beforeSend` yang menghapus pesan, request
  dan breadcrumb di setiap jalur, menambah dependensi besar dan instrumentasi otomatis yang sulit diaudit untuk N-14.
- **Hanya log kontainer:** tanpa pengelompokan isu dan notifikasi isu baru.

## Konsekuensi

- Pengelompokan isu berdasarkan tipe + kode + pesan log + rute; tanpa nilai variabel, sehingga diagnosis lanjutan
  memakai `request_id` untuk mencari baris log lengkap di kontainer.
- Web admin dan Flutter belum memiliki pelacakan galat (`VITE_SENTRY_DSN` dicadangkan).
