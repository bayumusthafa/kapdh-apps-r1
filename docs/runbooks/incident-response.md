# Runbook: respons insiden KAPDH

Rujukan: PRD 5.5 (pembagian operasi, maintenance, restore), 4.5 (layar maintenance), 8.3 langkah 6, 8.4 (rollback dan
pemulihan), 10.1 D9 (peran dan kanal eskalasi), 10.2 (risiko); ARCHITECTURE §4.3 (gerbang maintenance), §5.4
(app_settings). Runbook terkait: monitoring.md (alert), backup-restore.md (restore), storage-migration.md.

> Nama pemegang peran dan nomor kanal ditetapkan D9 sebelum go-live dan disimpan di daftar kontak terkendali (bukan di
> repo). Kolom "Pemegang" di bawah sengaja kosong sampai disahkan.

## 1. Peran (usulan PRD 5.5)

| Peran | Tanggung jawab | Pemegang (D9) |
| ----- | -------------- | ------------- |
| Komandan insiden | Pengelola infra yang menerima alert pertama; memimpin sampai diserahkan; menulis log insiden | |
| Pengelola infra | Alert, diagnosis infrastruktur, mode maintenance teknis, restore, rotasi secret | utama: · cadangan: |
| Super Admin | Keputusan bisnis (buka/tutup layanan, restore yang menghilangkan data, refund), komunikasi ke pengurus dan anggota | |
| Pengembang | Perbaikan aplikasi (hotfix/forward-fix), analisis log, rilis | |
| QA | Uji regresi sebelum layanan dibuka kembali, verifikasi perbaikan | |

Satu orang boleh memegang beberapa peran, tetapi keputusan restore yang menghilangkan data dan pengumuman ke anggota
selalu disetujui Super Admin.

## 2. Tingkat insiden

| Tingkat | Contoh | Tanggap | Pembaruan status |
| ------- | ------ | ------- | ---------------- |
| SEV-1 | API/login mati untuk semua; data/berkas hilang atau rusak; paparan berkas privat; nominal/status salah massal; oversell; kegagalan MFA admin; kebocoran secret | ≤ 15 menit | setiap 30 menit |
| SEV-2 | Fitur inti terganggu sebagian (chat realtime, push, email, pembayaran tertunda, worker macet > 15 menit); backup gagal > 24 jam; disk ≥ 80 % | ≤ 1 jam | setiap 2 jam |
| SEV-3 | Gangguan kecil, alert peringatan (disk 60 %, antrean bayar), bug tanpa dampak data | hari kerja berikut | saat selesai |

Daftar PRD 8.4 (kegagalan login, salah status/nominal, paparan file privat, oversell, gagal MFA, konfigurasi produksi
belum disahkan) selalu SEV-1.

## 3. Alur

1. **Deteksi**: alert (monitoring.md) atau laporan pengguna/pengurus (bantuan@kapdh.or.id, WhatsApp admin).
2. **Triase** (≤ 15 menit): tetapkan tingkat dan komandan, buka log insiden (waktu UTC dan WIB, tindakan, siapa).
3. **Lindungi data lebih dahulu**: bila integritas terancam, aktifkan mode maintenance (bagian 4) SEBELUM diagnosis
   panjang. Simpan bukti (log, `request_id`, keadaan database) sebelum mengubah apa pun.
4. **Mitigasi**: pakai playbook bagian 5; pilih tindakan rollback sesuai bagian 6.
5. **Komunikasi**: templat bagian 7; jangan menjanjikan waktu yang belum pasti, beri rentang.
6. **Pemulihan dan verifikasi**: QA menjalankan smoke test PRD 8.3 langkah 3 yang relevan; Super Admin memutuskan
   membuka layanan.
7. **Pascainsiden** (≤ 5 hari kerja untuk SEV-1/2): post-mortem tanpa menyalahkan (bagian 8), tindak lanjut dengan
   pemilik dan tenggat.

## 4. Mode maintenance dan read-only

### 4.1 Mode maintenance (app_settings `maintenance`)

Efek (ARCHITECTURE §4.3, PRD 4.5): semua mutasi anggota (POST/PUT/PATCH/DELETE) ditolak `503 MAINTENANCE` dengan pesan
dan `Retry-After` dari `until`, KECUALI `/auth/refresh`, `/auth/logout`, `/auth/logout-all`,
`DELETE /auth/sessions/{id}`, seluruh `/admin/**`, dan `POST /public/kta/verify`; untuk access token admin yang sah juga
`POST /auth/reauth` (reautentikasi untuk mematikan maintenance) dan `POST /files` (unggahan bukti pengurus). Baca (GET)
tetap jalan, aplikasi menampilkan layar maintenance dari `GET /public/config`.
Worker tetap berjalan (job terjadwal, outbox, penghapusan akun) kecuali dihentikan.

**Cara utama (teraudit):** web admin → Pengaturan → Maintenance (Super Admin atau admin `settings.manage`, wajib
reautentikasi). Isi pesan dengan rentang estimasi dan kanal dukungan, contoh: "Layanan KAPDH sedang dipulihkan,
perkiraan selesai 14.00-15.00 WIB. Bantuan: bantuan@kapdh.or.id." Perubahan berlaku ≤ 5 detik di setiap instance
(cache SettingsService).

**Cara darurat (web admin tidak dapat dipakai):** psql sebagai pemilik database (kapdh_migrator) di VPS, lalu catat di
log insiden karena jalur ini tidak menulis audit aplikasi:

```sql
UPDATE app.app_settings
SET value = jsonb_build_object(
      'active', true,
      'message', 'Layanan KAPDH sedang dalam pemeliharaan, perkiraan selesai 14.00-15.00 WIB. Bantuan: bantuan@kapdh.or.id',
      'until', to_char((now() + interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    version = version + 1,
    updated_at = now()
WHERE key = 'maintenance';
-- Mengakhiri: value = '{"active": false, "message": null, "until": null}'::jsonb, version = version + 1.
```

### 4.2 Read-only saat integritas data terancam (PRD 8.4 baris 2)

Bertingkat, gunakan yang paling ringan yang cukup:

1. **Maintenance** (4.1): anggota tidak dapat mengubah data. Pengurus diminta lewat grup pengurus untuk tidak
   memutuskan pembayaran/menghapus apa pun sampai diumumkan (API admin tetap terbuka agar maintenance dapat diakhiri).
2. **Hentikan worker** (Coolify: stop service worker): tidak ada email/push, job kedaluwarsa reservasi, penghapusan akun
   atau ekspor. Outbox menumpuk dengan aman dan diproses saat worker dinyalakan lagi (PRD 5.1). Catat waktu henti:
   reservasi yang seharusnya kedaluwarsa akan diproses setelahnya.
3. **Darurat tingkat database** (hanya bila pengurus pun tidak boleh menulis, mis. dugaan akun admin dibobol): sebagai
   superuser `ALTER ROLE kapdh_app SET default_transaction_read_only = on;` lalu restart API. Semua tulis gagal
   (termasuk refresh token, jadi sesi admin/anggota tidak dapat diperpanjang dan login gagal); baca tetap jalan.
   Kembalikan dengan `ALTER ROLE kapdh_app RESET default_transaction_read_only;` + restart. Selalu kombinasikan dengan
   maintenance agar pengguna melihat pesan yang benar.

## 5. Playbook

| Situasi | Tindakan |
| ------- | -------- |
| API mati/readiness gagal | `checks` readiness → DB/Redis/storage. Log kontainer API 15 menit terakhir. Restart kontainer bila macet. Bila setelah deploy: rollback image (bagian 6) |
| PostgreSQL mati/penuh | Disk (`df`), log PostgreSQL. Disk penuh: hapus log/image lama, perbesar volume. Korupsi: aktifkan maintenance, putuskan restore (backup-restore.md bagian 7) |
| Redis mati | Worker keluar sendiri bila Redis tidak siap 30 detik; API readiness gagal (Redis wajib di production). Pulihkan Redis (data Redis boleh hilang: dibangun ulang dari outbox, PRD 5.5) |
| Worker macet / outbox menumpuk | Heartbeat worker (isu). Restart worker; lease outbox diambil alih otomatis. Event `dead`: periksa `last_error`, perbaiki, jadwalkan ulang yang aman |
| Penyedia email/FCM gagal | Status penyedia. Pengiriman diulang dengan backoff; inbox in-app tetap. OTP dikirim langsung oleh API (ADR-004): pengguna dapat kirim ulang; bila penyedia mati lama, ganti penyedia D10 (SMTP_URL) dan umumkan |
| Ledger penghapusan luar VPS gagal | Permintaan `failed` dengan `ledger_*:OffsiteLedgerWriteError`: periksa kunci/kuota/object lock bucket ledger; job mengulang otomatis. Data belum dihapus sebelum entri luar VPS ada (D5-07) |
| Paparan berkas privat (SEV-1) | Maintenance; identifikasi berkas dan pengakses dari log (`request_id`); rotasi `FILE_URL_SECRET` (semua URL bertanda tangan ≤ 10 menit batal); perbaiki; nilai kewajiban pemberitahuan (bagian 7.4) |
| Akun admin diduga dibobol | Super Admin lain menonaktifkan admin itu (web admin); cabut sesi (bagian 5.1); periksa audit tindakan admin itu; reset TOTP lewat undangan ulang |
| Akun alumni disalahgunakan / investigasi keamanan | Atas keputusan tertulis Super Admin: status `disabled` lewat CLI `account:status` (docs/runbooks/alumni-account-disabled.md); pelanggaran perilaku memakai suspend di web admin, bukan `disabled` |
| Kebocoran secret | Rotasi sesuai bagian 5.2; cabut sesi bila JWT/OTP terdampak |
| Oversell/salah nominal/status | Maintenance; hentikan worker bila job ikut memperburuk; koreksi hanya lewat payment_adjustments (status paid tidak diubah, ARCHITECTURE §2.13); forward-fix |
| Konfigurasi produksi belum disahkan terdeteksi | Maintenance; perbaiki app_settings lewat web admin; catat (PRD 8.4) |

### 5.1 Mencabut semua sesi

Satu akun: web admin (anggota/admin) atau "keluar dari semua perangkat". Massal (darurat, psql sebagai pemilik):

```sql
BEGIN;
UPDATE app.sessions SET revoked_at = now() WHERE revoked_at IS NULL;
UPDATE app.users SET session_version = session_version + 1;
COMMIT;
```

AuthGuard memeriksa sesi dan `session_version` di database pada setiap request, jadi access token lama langsung
ditolak; gateway realtime memvalidasi ulang semua socket setiap 60 detik (`REALTIME_REVALIDATE_MS`) sehingga socket
sesi yang dicabut terputus paling lambat sekitar satu menit. Semua pengguna harus login ulang; umumkan.

### 5.2 Rotasi secret (Coolify, lalu restart API/worker)

| Secret | Dampak rotasi |
| ------ | ------------- |
| `JWT_ACCESS_SECRET` | Semua access token batal (≤ 15 menit lagi pula); refresh tetap jalan |
| `QR_SIGNING_KEYS` | Tambahkan kunci baru DI DEPAN, pertahankan kunci lama untuk verifikasi sampai QR lama kedaluwarsa (≤ 7 hari), lalu hapus. Kunci bocor: hapus segera (QR lama menjadi "perlu diperbarui") |
| `OTP_HMAC_SECRET` | OTP aktif dan backup code admin tidak lagi cocok: admin harus membuat ulang backup code |
| `TOTP_ENC_KEY` | JANGAN diganti tanpa migrasi enkripsi ulang secret TOTP (semua admin gagal MFA). Bila bocor: undang ulang semua admin agar mendaftar TOTP baru |
| `FILE_URL_SECRET` | URL berkas bertanda tangan yang sedang aktif batal; klien meminta ulang |
| Sandi role DB | `ALTER ROLE ... PASSWORD`, perbarui `DATABASE_URL` di Coolify, restart |
| Kunci S3/bucket ledger, SMTP, FCM | Buat kunci baru di penyedia, perbarui env, restart, cabut kunci lama |
| Kata sandi restic | backup-restore.md bagian 9 |

## 6. Rollback dan pemulihan (PRD 8.4)

| Titik kegagalan | Tindakan yang diperbolehkan | Langkah |
| --------------- | --------------------------- | ------- |
| Gagal sebelum ada data pengguna nyata | Hentikan, perbaiki, reset production terkendali, ulangi inisialisasi 8.2 | Hapus database dan volume, jalankan ulang migrasi, roles.sql, seed referensi, bootstrap Super Admin; backup + restore drill ulang |
| Bug kritis setelah ada data | Forward-fix/hotfix; maintenance read-only bila integritas terancam | Bagian 4.2; rilis perbaikan lewat CI (tag baru); untuk Flutter, naikkan `min_app_version` hanya setelah versi baru dapat diunduh di toko |
| Perubahan skema tidak kompatibel dengan image sebelumnya | Jangan menganggap rollback image memulihkan skema | Bandingkan journal migrasi image lama (`node_modules/@kapdh/database/migrations/meta/_journal.json`) dengan `drizzle.__drizzle_migrations`; bila image lama tidak kompatibel, forward-fix atau restore (pertimbangkan RPO nyata) |
| Data/berkas hilang atau rusak | Restore DB+berkas dengan manifest yang sama, terapkan deletion ledger, replay outbox, periksa konsistensi sebelum dibuka | backup-restore.md bagian 7 (`restore.sh` melakukan semuanya dan berhenti bila pemeriksaan gagal) |

**Rollback image** (skema kompatibel): Coolify → service → deploy ulang tag image sebelumnya (image yang sama dari CI,
PRD 5.5). Migrasi TIDAK pernah dibalik otomatis; job migrasi tidak dijalankan untuk rollback.

## 7. Templat komunikasi (Bahasa Indonesia)

### 7.1 Pengumuman gangguan (grup WhatsApp alumni, situs, pesan maintenance)

> **[KAPDH] Gangguan layanan aplikasi** — Sejak pukul {jam} WIB, {fitur} sedang terganggu. Tim sedang menangani.
> Data Anda aman{atau: "kami sedang memastikan keamanan data"}. Perkiraan pulih: {rentang} WIB. Informasi berikutnya
> pukul {jam}. Bantuan: bantuan@kapdh.or.id / WhatsApp {nomor}.

### 7.2 Pemulihan selesai

> **[KAPDH] Layanan pulih** — Layanan {fitur} kembali normal sejak pukul {jam} WIB. {Bila restore:} Data yang Anda kirim
> antara {waktu backup} dan {waktu gangguan} WIB (mis. bukti pembayaran, reservasi tiket, pesan chat) mungkin perlu
> dikirim ulang. Mohon maaf atas ketidaknyamanannya. Bantuan: bantuan@kapdh.or.id.

### 7.3 Untuk pengurus (grup pengurus)

> Insiden {SEV} {judul}, mulai {jam} WIB. Dampak: {ringkas}. Mohon {tidak memutuskan pembayaran / tidak mengubah data
> event} sampai diumumkan. Komandan: {nama}. Pembaruan berikut {jam}.

### 7.4 Kegagalan pelindungan data pribadi

Bila data pribadi terpapar atau hilang (mis. berkas privat terbuka, akun dibobol): Super Admin bersama penasihat hukum
menilai kewajiban pemberitahuan menurut UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi (pemberitahuan tertulis
kepada subjek data dan lembaga paling lambat 3 x 24 jam; verifikasi ketentuan terbaru dengan penasihat hukum). Isi
pemberitahuan: data apa yang terdampak, kapan dan bagaimana, tindakan yang diambil, dan langkah yang disarankan bagi
pengguna. Simpan bukti pengiriman.

## 8. Post-mortem

Simpan di `docs/qa/incidents/<yyyy-mm-dd>-<judul>.md` (tanpa data pribadi):

- Ringkasan, tingkat, durasi (mulai, terdeteksi, dimitigasi, pulih), dampak (pengguna, transaksi, data).
- Linimasa (UTC dan WIB) dari log insiden.
- Penyebab akar dan faktor pendukung (tanpa menyalahkan individu).
- Yang berjalan baik / tidak; apakah alert mendeteksi lebih dahulu dari pengguna.
- Tindak lanjut: tindakan, pemilik, tenggat, ID tiket. Downtime dicatat ke laporan ketersediaan bulanan (N-05).
