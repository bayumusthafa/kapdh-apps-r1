# ADR-013: Identitas admin terpisah, aktivasi lewat undangan + TOTP wajib, sesi admin cookie pada site yang sama

- Status: Diterima (kontrak C1/C7 Fase B, diterapkan Fase C)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 2.3, 3.2, 3.16, 5.2, 8.2 langkah 3; F-02, F-16; AC F02-2, F02-5, F16-1..F16-4; D1, D12;
  handoff `docs/handoff/phase-b-contract-C1-identity.md`
- Bukti di kode: `kapdh-platform/apps/api/src/modules/admin-auth/**`, `apps/api/src/cli/bootstrap-*.ts`,
  `apps/api/src/core/identity/{crypto.ts,admin-refresh-cookie.ts}`, `apps/api/src/core/http/origin.ts`,
  `apps/admin/src/routes/auth/**` (`/login`, `/login/mfa`, `/login/enroll`, `/invite`), `apps/admin/src/api/client.ts`

## Konteks

PRD 3.16: hak admin tidak boleh menempel pada akun alumni; Super Admin pertama dibuat lewat CLI sekali pakai dan wajib
mengganti sandi awal serta mendaftarkan TOTP sebelum aktif (PRD 8.2); tidak ada akses admin aal1 di production (D1).
PRD 5.2: web admin memakai access token di memori dan refresh cookie HttpOnly, Secure, SameSite pada site yang sama
dengan API (D12: `admin.kapdh.or.id` dan `api.kapdh.or.id`), dengan pemeriksaan Origin/CSRF untuk mutasi berbasis
cookie, tanpa token di `localStorage`.

## Keputusan

1. Admin adalah identitas login sendiri (`users.kind = 'admin'`); tautan ke akun alumni (`admins.linked_alumni_user_id`)
   hanya untuk pemeriksaan konflik kepentingan pembayaran (PRD 2.3).
2. Siklus hidup `invited → active → disabled`. Admin baru (termasuk Super Admin pertama dari CLI
   `admin:bootstrap`) dibuat `invited` dengan sandi awal acak yang tidak pernah ditampilkan dan token undangan sekali
   pakai 72 jam (hanya hash disimpan). Tautan berbentuk `${ADMIN_ORIGIN}/invite#t=<token>`: token di fragmen URL
   sehingga tidak terkirim ke server web maupun tercatat di access log.
3. Menerima undangan = mengganti sandi awal dan menerima token pendaftaran (audience `kapdh-admin-enroll`, 30 menit,
   terikat hash sandi baru). TOTP didaftarkan dan dikonfirmasi; admin menjadi `active` dan menerima 10 backup code
   yang tampil sekali.
4. Login admin menolak (401 yang sama dengan sandi salah) admin `invited` atau tanpa TOTP terverifikasi; tahap kedua
   memakai token MFA 5 menit. Reset MFA oleh Super Admin adalah undangan ulang (`POST /admin/admins/{adminId}/recovery`):
   TOTP dihapus, sesi dicabut, status kembali `invited`.
5. Sesi web admin: access token di memori; refresh token di cookie `kapdh_admin_rt` (HttpOnly, SameSite=Strict, Secure
   di luar development/test, `path=/api/v1/auth`, 12 jam); endpoint berbasis cookie memeriksa Origin terhadap
   `ADMIN_ORIGIN`. Idle 30 menit (ADR-011).
6. Tindakan sensitif (undang/ubah admin, nominal, metode bayar, pengaturan) butuh reautentikasi level 2
   (`X-Reauth-Token`).

## Alternatif yang dipertimbangkan

- **Peran admin pada akun alumni**: ditolak oleh PRD 3.16 dan 2.3.
- **TOTP opsional/didaftarkan setelah login pertama**: ditolak; membuka jendela aal1 (D1, AC F02-2).
- **Token undangan di path/query**: ditolak; tercatat di log proxy dan riwayat peramban.
- **Bearer token admin di `localStorage`**: ditolak oleh PRD 5.2 (XSS).

## Konsekuensi

- Undangan admin selain bootstrap dikirim lewat email melalui outbox, jadi worker dan SMTP harus berjalan sebelum
  Super Admin kedua diundang (`docs/runbooks/production-init.md`).
- CLI bootstrap menolak bila sudah ada Super Admin yang dapat login. Selama belum ada yang aktif, menjalankan CLI
  dengan email **lain** membuat undangan Super Admin tambahan (diamati pada uji coba 14 Oktober 2026); runbook
  mewajibkan satu eksekusi dengan email yang benar.
- Admin dan API harus tetap pada site `kapdh.or.id` yang sama (staging: `staging-admin` dan `staging-api`), bila
  tidak cookie SameSite=Strict tidak terkirim.
