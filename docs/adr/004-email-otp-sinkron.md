# ADR-004: Email OTP dikirim langsung oleh API, bukan lewat outbox/worker

- Status: Diterima (Fase B, dikonfirmasi Fase C)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 2.5, 3.1, 3.2, 3.14, 5.1; AC F01-1..F01-4; D10; ARCHITECTURE §4.7
- Bukti di kode: `kapdh-platform/apps/api/src/modules/auth/otp-challenge.service.ts` (`deliver`, `OTP_TTL_MS`,
  `OTP_RESEND_MS`, `OTP_SENDS_PER_HOUR`), `apps/api/src/core/adapters/mailer.ts` (`SmtpMailer`, `DevLogMailer`),
  `apps/api/src/main.ts` (menolak start tanpa `SMTP_URL` di luar development)

## Konteks

Semua notifikasi lain (email transaksional dan push) lewat outbox yang ditulis dalam transaksi bisnis lalu dikirim
worker (PRD 5.1). OTP berbeda: kode berlaku 10 menit, pengguna menunggu di layar OTP, dan tidak ada nilai bisnis bila
kode terkirim terlambat. Menaruh OTP di outbox berarti kode (atau HMAC-nya) harus disimpan di payload outbox, yang
dilarang (ARCHITECTURE §2 butir 3), dan keterlambatan antrean langsung terasa sebagai "kode tidak datang".

## Keputusan

1. API mengirim email OTP sendiri lewat `Mailer.sendOtp` setelah challenge ditulis (kode hanya di memori proses; yang
   disimpan hanya HMAC).
2. Untuk tujuan **signup** dan **email_change** pengiriman ditunggu: kegagalan SMTP terlihat oleh klien dan pengguna
   dapat mengirim ulang setelah cooldown 60 detik (`OTP_RESEND_MS`).
3. Untuk tujuan non-enumerasi (**password_reset**, **deletion**) pengiriman tidak ditunggu (fire-and-forget dengan log
   galat aman) agar waktu respons sama dengan challenge pengganti yang tidak mengirim email (ADR-012).
4. Batas: kode berlaku 10 menit, 5 percobaan per challenge, 5 pengiriman per email per jam dan 60 per IP per jam.
5. Development tanpa `SMTP_URL` memakai `DevLogMailer` yang mencetak kode (dan isi email undangan admin) ke log API.
   `main.ts` dan worker menolak berjalan tanpa `SMTP_URL` di staging/production (`packages/config`).

## Alternatif yang dipertimbangkan

- **OTP lewat outbox + worker**: ditolak; menyimpan materi rahasia di outbox dan menambah latensi antrean.
- **Antrean khusus OTP di Redis**: ditolak; menambah komponen kritis untuk satu jenis pesan yang sudah dapat dikirim
  ulang pengguna.

## Konsekuensi

- Ketersediaan provider email (D10) langsung memengaruhi registrasi dan pemulihan sandi; monitor kegagalan provider
  wajib (PRD 5.5) dan uji SMTP termasuk smoke test production (`docs/runbooks/go-live.md`).
- Batas waktu SMTP dibatasi di `SmtpMailer` (DNS 10 s, koneksi 15 s, greeting 10 s, socket 20 s) sehingga request API
  tidak menggantung.
- Alur publik non-enumerasi (`otp-challenge.service.ts` `deliver`, `web-deletion.service.ts`) tidak menunggu SMTP.
  Reset sandi yang dimulai pengurus (AC F16-4, `member-password-reset.service.ts`) menunggu SMTP karena dipanggil dari
  web admin, bukan endpoint publik.
