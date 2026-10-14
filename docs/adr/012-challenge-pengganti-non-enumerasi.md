# ADR-012: Challenge pengganti (decoy) agar alur publik tidak mengungkap email terdaftar

- Status: Diterima (Fase C, migrasi `0007_auth_otp_decoys`)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 2.5 ("respons lupa sandi tidak mengungkap apakah email terdaftar"), 3.2, 3.14; N-09; kontrak C1
  (`forgotPassword`, `startWebDeletion`, `resendOtp`, `getOtpChallengeStatus`, `verifyPasswordResetOtp`)
- Bukti di kode: `kapdh-platform/packages/database/src/schema/identity.ts` (`otpDecoys`),
  `packages/database/migrations/0007_auth_otp_decoys.sql`, `apps/api/src/modules/auth/otp-challenge.service.ts`
  (`issueDecoy`), `apps/api/src/modules/account/web-deletion-decoys.ts`, `apps/api/src/core/db/locks.ts`
  (`ADVISORY_LOCK_NAMESPACES.otpDecoy`)

## Konteks

Lupa sandi (aplikasi) dan hapus akun lewat web (`https://kapdh.or.id/delete-account`, PRD 3.14, [R2]) dapat dipanggil
siapa saja dengan email apa saja. Bila respons, status kode, kuota, cooldown, atau waktu respons berbeda antara email
terdaftar dan tidak, alur itu menjadi oracle keanggotaan. Menolak dengan "email tidak ditemukan" melanggar PRD 2.5;
mengembalikan `challenge_id` acak tanpa keadaan membuat kirim ulang, cek status, dan percobaan kode berperilaku berbeda
dari challenge nyata.

## Keputusan

1. Untuk email yang tidak memenuhi syarat, API membuat **challenge pengganti** di tabel `otp_decoys`: id challenge,
   tujuan (`password_reset` atau `deletion`), `email_key` = HMAC-SHA256 `OTP_HMAC_SECRET` atas email ternormalisasi,
   `email_masked`, percobaan, kedaluwarsa, dan waktu kirim ulang. Tidak ada kode, akun, atau email mentah.
2. Challenge pengganti memakai kuota kirim per email/IP, cooldown, batas percobaan, dan bentuk respons yang sama
   dengan challenge nyata; verifikasi selalu "kode salah" sampai percobaan habis.
3. Penerbit bersamaan untuk (email, tujuan) yang sama diurutkan advisory lock (`otpDecoy`), cermin kunci baris
   `users` pada challenge nyata; satu challenge pengganti aktif per email dan tujuan (`otp_decoys_active_key`).
4. Email OTP challenge nyata untuk tujuan ini tidak ditunggu (ADR-004) agar waktu respons tidak membedakan keduanya.
5. Baris yang melewati masa simpan dibersihkan bertahap pada setiap penerbitan challenge (nyata maupun pengganti,
   `SKIP LOCKED`), tanpa job terpisah.

## Alternatif yang dipertimbangkan

- **Selalu 202 tanpa `challenge_id`**: ditolak; layar OTP dan kontrak C1 membutuhkan challenge untuk status, kirim
  ulang dan verifikasi.
- **Keadaan di Redis**: ditolak; Redis opsional di development dan bukan sumber kebenaran (PRD 5.1).

## Konsekuensi

- Satu tabel tambahan di luar inventaris PRD (ADR-005), tanpa data pribadi yang dapat dibalik selain bentuk tersamar.
- Rotasi `OTP_HMAC_SECRET` membuat kuota per email lama tidak dikenali; dampaknya hanya sampai jendela kuota berakhir.
