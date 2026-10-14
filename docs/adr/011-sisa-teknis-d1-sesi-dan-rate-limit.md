# ADR-011: Sisa teknis D1: masa berlaku sesi, idle admin, dan nilai rate limit

- Status: Diterima (dikunci pengembang pada Tahap 0/Fase B; dapat ditinjau ulang sebelum go-live)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 2.5, 3.2, 5.2; D1 ("sisa teknis: TTL refresh dan nilai rate limit final"); N-07, N-08; AC F02-1..F02-6
- Bukti di kode: `kapdh-platform/apps/api/src/core/identity/{token.service.ts,session-issuer.ts,password-verifier.ts}`,
  `apps/api/src/core/guards/auth.guard.ts` (`ADMIN_IDLE_MS`), `apps/api/src/modules/auth/auth.service.ts`,
  `apps/api/src/modules/auth/otp-challenge.service.ts`, `apps/api/src/modules/auth/sessions.service.ts`,
  `apps/api/src/modules/admin-auth/admin-auth.shared.ts`,
  `apps/api/src/modules/chat/chat.constants.ts`, `apps/api/src/core/files/{purposes.ts,files.service.ts}`

## Konteks

D1 (PRD v3.5) menyerahkan dua nilai teknis kepada pengembang: TTL refresh mobile/admin (terpisah dari idle timeout,
PRD 5.2) dan nilai rate limit final. Nilai ini menentukan keseimbangan antara kenyamanan anggota (jarang login ulang)
dan risiko token curian, serta antara perlindungan tebak sandi/kode dan penguncian pengguna sah.

## Keputusan

| Hal | Nilai | Konstanta |
| --- | ----- | --------- |
| Access token (mobile dan admin) | 15 menit (AC F02-1) | `ACCESS_TTL_SECONDS` |
| Refresh mobile | 60 hari, berotasi; pemakaian ulang mencabut seluruh keluarga (AC F02-3) | `REFRESH_TTL_MS.mobile` |
| Refresh admin | 12 jam, cookie HttpOnly `path=/api/v1/auth` | `REFRESH_TTL_MS.admin` |
| Idle admin | 30 menit, mencabut seluruh keluarga sesi; permintaan latar `X-Background-Request: 1` tidak dihitung aktivitas | `ADMIN_IDLE_MS` |
| Token reautentikasi | 10 menit, terikat keluarga sesi; sesi admin butuh level 2 (TOTP) | `TokenService.signReauth` |
| Gagal login per email | 10 per 15 menit (slot dicadangkan sebelum bcrypt) | `LOGIN_FAILS_LIMIT` |
| Gagal login per IP | 50 per 15 menit | `LOGIN_FAILS_PER_IP` |
| Gagal MFA admin | 5 per 15 menit per admin | `MFA_FAILS_LIMIT` |
| Gagal reautentikasi | 5 | `REAUTH_FAILS_LIMIT` |
| Registrasi per IP | 120 per jam (sebelum bcrypt) | `REGISTER_ATTEMPTS_PER_IP_PER_HOUR` |
| OTP | berlaku 10 menit, 5 percobaan, cooldown kirim ulang 60 detik, 5 kirim per email per jam, 60 per IP per jam | `OTP_*` |
| Kirim pesan chat | 60 per menit | `SEND_LIMIT` |
| Unggah berkas | 10 berhasil per purpose per pengguna per 24 jam (N-10); 30 percobaan per jam; gambar <= 5 MB, PDF <= 10 MB | `UPLOAD_QUOTA_WINDOW_MS`, `UPLOAD_ATTEMPTS_PER_HOUR`, `MAX_*_BYTES` |
| Cost bcrypt | env `BCRYPT_COST`, bawaan 12, minimal 10 di production | `packages/config` |

Rate limit memakai penyimpanan memori di development/test dan Redis (skrip Lua, kunci di-hash tanpa PII) bila
`REDIS_URL` diisi. Batas kegagalan yang menjaga pemeriksaan rahasia selalu memakai pola reserve → periksa → release.

## Alternatif yang dipertimbangkan

- **Refresh mobile tanpa batas/absolut 1 tahun**: ditolak; perangkat hilang memberi akses terlalu lama.
- **Refresh mobile 7-14 hari**: ditolak untuk R1.0; anggota yang jarang membuka aplikasi akan sering login ulang,
  sementara rotasi + deteksi pemakaian ulang + logout-all sudah membatasi risiko.
- **Penguncian akun permanen setelah N gagal**: ditolak; membuka serangan penolakan layanan terhadap anggota tertentu.

## Konsekuensi

- Nilai-nilai ini adalah konstanta kode, bukan `app_settings`; mengubahnya memerlukan rilis.
- Pemilik produk perlu mengonfirmasi nilai sebelum go-live (bagian sisa teknis D1 pada tabel sign-off
  `docs/runbooks/go-live.md`).
- Kuota unggah N-10 juga membatasi admin yang mencatat iuran D13 (10 bukti per admin per hari); dikonfirmasi pemilik
  produk (handoff `phase-b-core-api.md`).
