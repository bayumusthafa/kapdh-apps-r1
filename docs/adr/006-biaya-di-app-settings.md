# ADR-006: Nominal iuran disimpan di `app_settings.fees` berversi; payment menyimpan `settings_version`

- Status: Diterima (Fase A)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 3.3, 4.3, 6.3, 7.3; AC F03-1, F03-5; D4; ARCHITECTURE §3.3, §5.4
- Bukti di kode: `kapdh-platform/packages/database/src/schema/{settings.ts,payments.ts}`,
  `packages/database/seeds/reference.ts` (`REFERENCE_SETTINGS.fees`), `apps/api/src/core/settings/keys.ts`,
  `apps/api/src/core/settings/settings.service.ts`, `apps/api/src/modules/admin/settings.controller.ts`
  (`PUT /admin/settings/fees`)

## Konteks

PRD 6 memuat tabel `fee_settings`. D4 menetapkan nominal awal (pendaftaran Rp50.000, pembuatan KTA Rp10.000,
perpanjangan Rp10.000/tahun) yang dikelola pengurus dari web admin. Payment harus memakai nominal yang berlaku saat
instruksi dibuat (AC F03-5) dan tetap dapat dijelaskan setelah nominal berubah. Pengaturan lain (periode, event, chat,
versi minimum, maintenance, tautan toko, kontak, legal, instruksi bayar) juga butuh penyimpanan berversi yang diaudit.

## Keputusan

1. Tidak ada tabel `fee_settings`. Semua pengaturan aplikasi berada di `app_settings` (kolom `key`, `value` jsonb,
   `version`, `updated_by_admin_id`, `updated_at`) dengan 10 kunci yang divalidasi zod (`core/settings/keys.ts`): `fees`,
   `membership`, `events`, `chat`, `min_app_version`, `maintenance`, `store_links`, `support`, `legal`,
   `payment_instructions`.
2. `fees = {registration_fee, card_fee, renewal_fee}` sebagai string Money `numeric(14,2)`. Perubahan lewat
   `PUT /admin/settings/fees` (izin `settings.manage` + `If-Match`; syarat reautentikasi dicabut oleh ADR-025),
   menaikkan `version`, menulis audit before/after dalam transaksi yang sama.
3. Payment pendaftaran/perpanjangan menghitung `amount` di server dan menyimpan `lines_snapshot`, `method_snapshot` dan
   `settings_version` (wajib kecuali `type = 'ticket'`, `payments_settings_version_chk`). Tiket memakai harga event.
4. Seed referensi menyisipkan nilai D4 dengan `version = 1` dan tidak pernah menimpa nilai yang sudah diubah pengurus;
   kunci baru ditambahkan ke lingkungan lama dengan menjalankan ulang `seed:reference`.

## Alternatif yang dipertimbangkan

- **Tabel `fee_settings` per baris versi**: ditolak; duplikasi mekanisme versi/audit yang sudah ada di `app_settings`
  dan satu tabel lagi untuk satu objek kecil.
- **Nominal di env/konfigurasi deploy**: ditolak; PRD 7.3 melarang nominal rekaan masuk production dan D4 mewajibkan
  pengelolaan dari web admin.

## Konsekuensi

- Rekonsiliasi keuangan memakai `amount` dan snapshot pada payment, bukan nilai `fees` saat ini.
- SettingsService menyimpan cache 5 detik per proses (`SETTINGS_CACHE_TTL_MS`); perubahan nominal berlaku untuk
  instruksi baru paling lambat beberapa detik kemudian, instruksi lama tetap pada snapshot-nya.
- Nilai seed D4 sudah disahkan PRD v3.3, tetapi bendahara tetap wajib memeriksa dan menandatangani konfigurasi biaya
  sebelum go-live (PRD 9.3; `docs/runbooks/production-init.md` langkah 4).
