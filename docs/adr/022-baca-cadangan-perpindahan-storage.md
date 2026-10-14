# ADR-022: Baca-cadangan (fallback read) selama perpindahan berkas lokal ke S3

- Status: Diterima (Fase E); prosedur perpindahan belum digladi di staging
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 5.4 (salin, cocokkan checksum, baca-cadangan, bersihkan), 7.1; D2; D9; AC F14-6
- Bukti di kode: `kapdh-platform/packages/storage/src/fallback-driver.ts` (`FallbackReadDriver`),
  `packages/storage/src/index.ts` (`createStorageDriver`), `packages/config` (`STORAGE_FALLBACK_LOCAL_ROOT`); uji
  `packages/storage/src/drivers.test.ts`, `packages/config/src/index.test.ts`; runbook
  `docs/runbooks/storage-migration.md`

## Konteks

Berkas dimulai di disk lokal VPS dan dipindah ke S3-compatible saat disk > 60 % atau > 20 GB (PRD 5.4). Kolom
`files.storage_driver` hanya catatan; aplikasi membaca dari satu driver. Tanpa baca-cadangan, pengalihan memerlukan
salinan penuh sebelum pengalihan dan jendela maintenance selama salinan susulan.

## Keputusan

1. `FallbackReadDriver(primary = S3, fallback = disk lama)`: tulisan hanya ke S3; baca/stat/exists mencoba S3 lalu
   disk; penghapusan dijalankan di keduanya (berkas akun terhapus tidak tertinggal di lokasi lama, D2/AC F14-6);
   `copy` dari objek yang belum tersalin menulis ke S3. Galat S3 selain "tidak ada" tidak pernah diam-diam dialihkan
   ke disk.
2. Dipasang `createStorageDriver` bila `STORAGE_DRIVER=s3` dan `STORAGE_FALLBACK_LOCAL_ROOT` diisi; variabel itu
   ditolak packages/config tanpa `STORAGE_DRIVER=s3` dan dikosongkan setelah verifikasi.
3. Prosedur: tahap A pengalihan tulis + baca-cadangan (restart saja), tahap B salin rclone + verifikasi sha256 penuh
   terhadap `files.sha256` + penerapan ulang ledger untuk penghapusan yang bersilangan, tahap C lepas baca-cadangan,
   pembersihan setelah backup dan restore drill dengan S3 lulus.

## Alternatif yang dipertimbangkan

- **Baca per berkas berdasarkan `files.storage_driver`:** butuh dua driver di FilesService dan seluruh pembaca
  (ledger, ekspor, readiness); lebih banyak titik perubahan untuk keadaan sementara.
- **Salinan penuh dalam maintenance:** downtime sebanding ukuran berkas.

## Konsekuensi

- Selama tahap A-C setiap baca berkas lama melakukan satu permintaan S3 yang gagal lebih dahulu (latensi tambahan
  terbatas pada masa transisi).
- Backup berkas di S3 belum didukung skrip backup (ADR-018); prasyarat sebelum tahap A.
