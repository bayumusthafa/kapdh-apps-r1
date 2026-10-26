# ADR-028: Super Admin dapat mengubah nomor urut anggota (N)

- Status: Diterima (keputusan pemilik produk, 26 Oktober 2026). Menyimpang dari PRD 3.5 dan 6.4 ("N tidak pernah
  diketik atau didaur ulang"); lihat "Penyimpangan dari PRD".
- Tanggal dicatat: 26 Oktober 2026
- Diputuskan oleh: pemilik produk (Bayu Musthafa)
- Rujukan: PRD 2.3, 3.5, 6.4; AC F05-1, F05-6, F17-1; ADR-025
- Bukti di kode: migrasi `kapdh-platform/packages/database/migrations/0011_member_seq_admin_change.sql`
  (`app.member_seq_admin_change`, `app.alumni_guard_member_seq` diganti); kernel
  `kapdh-platform/apps/api/src/core/membership/membership.kernel.ts` (`changeMemberSeq`, lewati N terpakai di
  `allocateMemberNumber`); `apps/api/src/modules/membership/admin-members.{controller,service}.ts`
  (`POST /admin/members/{userId}/member-seq`); kontrak `packages/contracts/openapi/domains/admin-members.yaml`
  (`adminChangeMemberSeq`, `AdminMemberSeqChangeRequest`) dan `packages/contracts/CHANGELOG.md`; web admin
  `apps/admin/src/routes/members/{MemberActionDialogs,MemberDetailPage}.tsx` (`MemberSeqDialog`, tombol "Ubah nomor
  urut"); uji `packages/database/test/schema.pglite.test.ts` ("ADR-028: ..."),
  `apps/api/test/membership/admin-members.e2e.test.ts` (`POST /admin/members/{userId}/member-seq`),
  `apps/admin/src/routes/members/members.test.tsx` ("ubah nomor urut N oleh Super Admin")

## Konteks

Nomor anggota berbentuk AA.SS.JK.N. Sampai keputusan ini, N diambil sekali dari `app.membership_no_seq` saat iuran
pendaftaran disetujui, lalu dikunci trigger `alumni_guard_member_seq` (migrasi 0004): N tidak dapat diubah, dan N
anggota yang dihapus tidak pernah dipakai lagi (lantai `member_seq_floor` di ledger penghapusan). Koreksi data oleh
pengurus hanya menghitung ulang awalan AA.SS.JK.

Menjelang uji tertutup Google Play, pemilik produk ingin nomor anggota nyata dapat dimulai lagi dari 1 setelah akun uji
dihapus, dan ingin pengurus dapat membetulkan N tanpa mengubah database secara manual.

## Keputusan

1. **Hanya Super Admin** yang dapat mengubah N, lewat `POST /admin/members/{userId}/member-seq` dengan `member_seq`,
   alasan, `confirm: true`, `If-Match` dan `Idempotency-Key`. Tanpa reautentikasi, karena ini bukan tindakan kredensial
   (ADR-025). Akun alumni yang tertaut ke Super Admin pelaku ditolak (konflik kepentingan, PRD 2.3).
2. **Hanya anggota yang sudah bernomor.** Nomor PERTAMA tetap diterbitkan otomatis dari sequence (AC F05-1).
3. **N bekas akun terhapus boleh dipakai lagi.** N yang sedang dipakai anggota lain ditolak (400 pada `member_seq`;
   indeks unik `alumni_member_seq_key` menjaga balapan).
4. Satu transaksi menulis `member_seq` dan nomor lengkap bersama (awalan AA.SS.JK tetap), histori `number_correction`,
   audit `member.number_corrected` dengan `member_seq` dan `member_number` lama/baru, serta notifikasi ke anggota (rute
   /kta). QR lama tidak berlaku karena verifikasi publik mensyaratkan nomor terkini.
5. Database tetap menolak perubahan N kecuali transaksi menyetel `set_config('kapdh.member_seq', 'admin', true)` tepat
   sebelum UPDATE. Dengan flag pun N tidak dapat dikosongkan, dan INSERT tetap wajib dari `nextval`.
6. Penerbitan nomor otomatis melewati N yang sudah dipasang Super Admin (`nextval` berikutnya), sehingga tidak bentrok
   dengan indeks unik.

## Penyimpangan dari PRD

PRD 3.5 dan 6.4 menyatakan N tidak pernah diketik atau didaur ulang. Keputusan ini membolehkan keduanya, tetapi hanya
untuk Super Admin dan hanya untuk anggota yang sudah bernomor. Lantai N di ledger penghapusan tetap berlaku untuk
nomor otomatis, jadi sequence tidak pernah mundur sendiri; menurunkan N hanya terjadi lewat keputusan Super Admin yang
tercatat di histori dan audit.

## Alternatif yang dipertimbangkan

- **Reset sequence dan database penuh** (runbook go-live, "gagal sebelum ada data pengguna nyata"): menghapus juga
  berita, event dan pengaturan, dan tidak membantu koreksi N sesudah go-live.
- **Izin `members.manage`**: ditolak pemilik produk; N berdampak ke KTA dan QR sehingga dibatasi ke Super Admin.
- **Larang N bekas**: ditolak, karena tujuan utama (mulai dari 1 setelah akun uji dihapus) tidak tercapai.

## Konsekuensi

- Nomor KTA lama milik akun terhapus dapat terbit untuk orang lain. Pemeriksa yang menyimpan nomor lama akan melihat
  pemilik baru; QR lama tetap tidak berlaku karena tokennya terikat akun.
- Pembatalan darurat 0009-0010 (`infra/db/rollback/0009-0010-profile-lists.sql`) hanya berlaku sebelum 0011
  diterapkan. Bila 0011 sudah diterapkan, batalkan 0011 lebih dulu (butir berikut).
- Image API sebelum 0011 tidak menyetel flag, jadi rollback image aman: N kembali tidak dapat diubah.

## Cara membatalkan

Sebagai `kapdh_migrator` dalam satu transaksi: kembalikan `app.alumni_guard_member_seq` ke isi migrasi 0004, `DROP
FUNCTION app.member_seq_admin_change()`, lalu hapus catatan 0011 dari `drizzle.__drizzle_migrations` (created_at =
`when` journal 0011). N yang sudah diubah tetap berlaku.
