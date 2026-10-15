# Catatan keputusan arsitektur (ADR) KAPDH Apps R1.0

ADR mencatat keputusan rekayasa yang diambil selama build R1.0 beserta alasan, alternatif dan dampaknya (PRD 11.1
"ADR"). Keputusan produk tetap ada di register D pada PRD 10.1; ADR merujuk ID D bila relevan. Bila ADR bertentangan
dengan PRD soal perilaku produk, PRD yang berlaku; bila bertentangan dengan `docs/ARCHITECTURE.md`, perbarui keduanya
dalam satu perubahan.

| No. | Keputusan | Rujukan utama |
| --- | --------- | ------------- |
| [001](001-repo-tunggal-dan-subtree-split.md) | Satu repo selama build; `git subtree split` + SDK Dart bertag saat rilis | PRD 7.2, N-13 |
| [002](002-kontrak-per-domain-dan-generator-dart.md) | OpenAPI per domain; generator Dart kustom (Node, tanpa Java) | PRD 5.2, N-13 |
| [003](003-jalur-uji-pglite-dan-postgresql-embedded.md) | Jalur uji PGlite (bawaan) dan PostgreSQL 17 embedded (konkurensi) | PRD 9.2, N-16 |
| [004](004-email-otp-sinkron.md) | Email OTP dikirim langsung oleh API, bukan lewat outbox | PRD 2.5, 3.1, D10 |
| [005](005-tabel-tambahan.md) | Tabel tambahan `admin_permissions`, `categories`, `otp_decoys` | PRD 2.3, 3.8, 6 |
| [006](006-biaya-di-app-settings.md) | Nominal di `app_settings.fees` berversi; payment menyimpan `settings_version` | PRD 3.3, D4 |
| [007](007-audit-append-only-dan-role-purge.md) | Audit append-only (trigger + grant) dan role `kapdh_audit_purge` | F-17, D2 |
| [008](008-penjaga-super-admin-terakhir.md) | Penjaga Super Admin terakhir di database | PRD 9.2, AC F16-2 |
| [009](009-realtime-socketio-kirim-lewat-http.md) | Realtime Socket.IO `/realtime`; kirim pesan lewat HTTP | PRD 5.2, F-11 |
| [010](010-worker-sebagai-runtime-job-registry.md) | Worker = runtime tipis di atas job registry API | PRD 5.1, 5.5 |
| [011](011-sisa-teknis-d1-sesi-dan-rate-limit.md) | Sisa teknis D1: TTL sesi, idle admin, rate limit | D1, PRD 2.5 |
| [012](012-challenge-pengganti-non-enumerasi.md) | Challenge pengganti (decoy) untuk alur publik non-enumerasi | PRD 2.5, N-09 |
| [013](013-identitas-admin-undangan-dan-totp.md) | Identitas admin terpisah, undangan + TOTP wajib, cookie site sama (butir 6 reautentikasi digantikan ADR-025) | PRD 3.16, 5.2, D12 |
| [014](014-deletion-ledger-eksternal.md) | Deletion ledger eksternal dan penerapan ulang setelah restore (diperbarui ADR-019) | AC F14-6, D2 |
| [015](015-rencana-cadangan-ios-d13.md) | Rencana cadangan iOS untuk iuran lewat `payment_instructions` | D13, [R6] |
| [016](016-konfigurasi-lingkungan-flutter.md) | Lingkungan Flutter via `--dart-define-from-file`; push opsional | PRD 5.3, AC F13-2 |
| [017](017-token-qr-kta-dan-qr-tiket.md) | QR KTA bertanda tangan (rotasi kunci), QR tiket acak di DB | PRD 3.5, 3.6, 3.9 |
| [018](018-backup-pg-dump-restic-dan-manifest.md) | Backup harian pg_dump + restic ke object storage luar VPS, diikat manifest | N-06, PRD 5.5, 8.4 |
| [019](019-deletion-ledger-luar-vps.md) | Deletion ledger juga ditulis sinkron ke bucket append-only luar VPS | AC F14-6, D2, D9 |
| [020](020-uji-beban-generator-node-model-terbuka.md) | Uji beban: generator Node model terbuka + dataset sintetis lewat CLI API | N-01..N-04, U-11 |
| [021](021-pelacakan-galat-dari-log-aman.md) | Pelacakan galat GlitchTip dari baris log yang sudah aman, tanpa SDK | PRD 5.5, 7.1, N-14 |
| [022](022-baca-cadangan-perpindahan-storage.md) | Baca-cadangan selama perpindahan berkas lokal ke S3 | PRD 5.4 |
| [023](023-job-rilis-dan-gerbang-go-live.md) | Job rilis (image `kapdh-release`) dan gerbang go-live `golive:check`; jalur CI memakai urutan yang sama | PRD 5.5, 9.2 #9, 9.3, U-12 |
| [024](024-pipeline-ci-cd.md) | Pipeline CI/CD GitHub Actions, promosi digest yang sama, gerbang kontrak N-13 | PRD 5.5, 7.1, N-13, N-16 |
| [025](025-reautentikasi-hanya-tindakan-kredensial.md) | Reautentikasi step-up hanya untuk tindakan kredensial (termasuk koreksi email login admin, bersyarat); perubahan pengaturan, metode bayar dan admin lainnya cukup sesi MFA (keputusan PO, menyimpang dari AC F15-3/F16-1; menggantikan ADR-013 butir 6) | PRD 2.3, AC F15-3, AC F16-1 |

ADR 023 dan 024 ditulis paralel dengan nomor sementara (ADR-0002 dan ADR-010) lalu dinomori ulang saat integrasi akhir
R1.0 (`docs/handoff/integration-final.md`); rujukan lama di riwayat git menunjuk ke berkas yang sama.

## Format

Setiap ADR memuat: status, tanggal dicatat, rujukan PRD/D/AC, bukti di kode, Konteks, Keputusan, Alternatif yang
dipertimbangkan, Konsekuensi. Nomor tidak dipakai ulang; keputusan yang diganti diberi status "Digantikan oleh ADR-xxx"
dan tidak dihapus. Upgrade mayor framework/runtime memerlukan ADR baru (PRD 7.1).

## Cara menambah ADR

1. Salin struktur ADR yang ada, beri nomor berikutnya (tiga digit) dan judul singkat dalam Bahasa Indonesia.
2. Tulis bukti di kode dengan path yang dapat di-grep; jangan mengklaim sesuatu yang belum ada di `main`.
3. Tambahkan baris ke tabel di atas pada commit yang sama (`docs: ADR-0xx ...`).
