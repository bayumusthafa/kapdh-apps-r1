# Runbook: perpindahan berkas dari disk lokal ke S3-compatible

Rujukan: PRD 5.4 (pemicu dan syarat perpindahan), 7.1 (Storage: lokal awal, S3 setelah perpindahan terverifikasi),
10.1 D9 (ambang, penyedia, jadwal); ARCHITECTURE §4.2 (`FilesService` + `StorageDriver`); packages/storage
(`S3Driver`, `transferObject`). Pemilik: pengelola infra; persetujuan jadwal: pemilik produk (D9).

> **Status bukti.** Prosedur ini belum pernah dijalankan. Kode saat ini membaca SEMUA berkas dari satu driver yang
> dikonfigurasi (`STORAGE_DRIVER`); kolom `files.storage_driver` hanya catatan. Artinya belum ada "fallback read" per
> berkas (PRD 5.4) di aplikasi: prosedur di bawah menggantinya dengan salinan penuh + verifikasi SEBELUM pengalihan dan
> jalur kembali (rollback) yang menjaga salinan lokal. Gladi wajib di staging lebih dahulu.

## 1. Pemicu (PRD 5.4, D9)

- Disk `/data/files` (atau volume VPS) > 60 % ATAU total berkas > 20 GB, disertai proyeksi pertumbuhan
  (`infra/monitoring/check-host.sh`, monitor "Disk peringatan"). Kritis 80 %: lakukan langkah sementara (perbesar disk)
  lalu jadwalkan perpindahan.
- Keputusan ditulis di log operasional: tanggal, penyedia, region, perkiraan biaya, jendela maintenance.

## 2. Prasyarat

1. **Bucket berkas** baru `kapdh-<env>-files` di penyedia S3-compatible (region Jakarta/Singapura): PRIVAT (blokir akses
   publik; berkas publik tetap dilayani lewat API `/files/public/{id}`), terpisah dari bucket backup dan bucket deletion
   ledger. Versioning boleh diaktifkan dengan aturan hapus versi noncurrent ≤ 30 hari (D2: berkas akun terhapus tidak
   boleh tertahan lebih dari masa rotasi backup).
2. Kunci API khusus aplikasi (baca/tulis/hapus objek di bucket itu saja).
3. `rclone` di VPS dengan remote `kapdhfiles:` (env `RCLONE_CONFIG_KAPDHFILES_*`) memakai kunci yang sama.
4. Backup berhasil < 24 jam dan restore drill bulan berjalan lulus (backup-restore.md).
5. **Backup berkas S3 sudah disiapkan** (bagian 6): skrip backup saat ini hanya mencadangkan `/data/files` lokal.

## 3. Salin dan cocokkan checksum (tanpa henti layanan)

Salinan awal saat layanan berjalan; unggahan baru selama itu tetap ke disk dan disusul pada langkah 4.

```sh
# Salinan awal (tanpa folder sementara unggahan); --checksum membandingkan hash, bukan hanya ukuran/waktu.
rclone copy /data/files kapdhfiles:kapdh-prod-files --checksum --exclude "/.tmp/**" --transfers 8 \
  --log-file /var/log/kapdh-storage-copy.log --log-level INFO
# Verifikasi dua arah ukuran+hash (MD5 sisi S3) untuk seluruh objek yang sudah tersalin.
rclone check /data/files kapdhfiles:kapdh-prod-files --one-way --exclude "/.tmp/**" --checksum
```

Verifikasi terhadap checksum yang dicatat aplikasi (`files.sha256`, PRD 5.4 "cocokkan checksum"): bandingkan sha256
objek di bucket dengan basis data untuk sampel acak (atau seluruh berkas bila egress penyedia murah):

```sh
# Daftar key dan sha256 dari database (role kapdh_backup atau pemilik), lalu sha256 objek di bucket.
psql -X -A -t -F ' ' -c "select object_key, sha256 from app.files where status = 'ready' and storage_driver = 'local' order by random() limit 500" > /tmp/sampel.txt
while read -r key sha; do
  remote=$(rclone cat "kapdhfiles:kapdh-prod-files/$key" | sha256sum | cut -d ' ' -f 1)
  [ "$remote" = "$sha" ] || echo "BERBEDA $key"
done < /tmp/sampel.txt
```

Tidak boleh ada baris `BERBEDA` sebelum lanjut. (`transferObject` di packages/storage melakukan pencocokan sha256 yang
sama per objek bila perpindahan nanti diotomatiskan sebagai CLI.)

## 4. Pengalihan (jendela maintenance singkat)

1. Umumkan jendela (incident-response.md bagian 7.1). Aktifkan mode maintenance (mutasi anggota, termasuk unggahan,
   ditolak) dan minta pengurus tidak mengunggah (API admin tetap terbuka).
2. Hentikan worker (tidak ada ekspor/cleanup/penghapusan akun yang menulis atau menghapus berkas selama pengalihan).
3. Salinan susulan dan verifikasi akhir: ulangi kedua perintah bagian 3 (hanya delta yang tersalin).
4. Perbarui env API DAN worker di Coolify: `STORAGE_DRIVER=s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (bila perlu). Bucket berkas wajib berbeda dari
   `DELETION_LEDGER_S3_BUCKET` (packages/config menolak bila sama pada endpoint yang sama).
5. Catatan lokasi per berkas (bookkeeping PRD 5.4), sebagai pemilik database:
   `UPDATE app.files SET storage_driver = 's3', updated_at = now() WHERE storage_driver = 'local' AND status <> 'deleted';`
6. Deploy ulang API lalu worker. `GET /api/v1/health/ready` harus `storage: ok`.
7. Smoke test: unduh 5 berkas lama (bukti bayar lewat admin, avatar publik, gambar chat), unggah avatar baru, ekspor
   audit kecil. Lalu nonaktifkan maintenance.
8. Catat waktu pengalihan (T-switch) di log operasional.

## 5. Masa transisi, fallback dan kembali

- **Salinan lokal TIDAK dihapus** selama masa transisi (usulan 14 hari) dan sampai minimal dua backup berkas S3 berhasil
  dan satu restore drill memakai backup S3 lulus. Ini fallback yang tersedia selama aplikasi belum punya baca-cadangan
  per berkas.
- **Kembali ke lokal** (bila S3 bermasalah): maintenance → salin objek baru sejak T-switch dari bucket ke disk
  (`rclone copy kapdhfiles:kapdh-prod-files /data/files --max-age <durasi sejak T-switch> --checksum`) → kembalikan env
  `STORAGE_DRIVER=local` → `UPDATE app.files SET storage_driver = 'local' WHERE storage_driver = 's3'` → deploy ulang →
  smoke test. Objek yang dihapus di S3 selama transisi (penghapusan akun) juga harus dihapus dari disk: jalankan CLI
  ledger-reapply terhadap salinan ledger terbaru (backup-restore.md bagian 7 langkah 5) agar berkas akun terhapus tidak
  hidup kembali dari salinan lokal lama (AC F14-6).
- Ledger penghapusan lokal (`/data/files/ledger/account-deletions`) ikut tersalin; entri baru sesudah pengalihan ditulis
  ke bucket berkas dan tetap juga ke bucket deletion ledger luar VPS.

## 6. Backup setelah pindah ke S3 (wajib sebelum pengalihan)

`infra/backup/backup.sh`, `restore.sh` dan `verify-restore.sh` saat ini hanya mendukung `STORAGE_DRIVER=local`. Sebelum
langkah 4, salah satu dari:

1. **Disarankan:** tambahkan mode berkas S3 ke skrip backup: `rclone sync kapdhfiles:kapdh-prod-files
   /var/backups/kapdh/files-mirror --checksum` (cermin lokal sementara, butuh ruang disk seukuran berkas) lalu `restic
   backup` cermin itu dengan tag `kapdh-files`, catat di manifest; restore menyalin balik ke bucket bersih dengan
   `rclone copy`. Perbarui verify-restore.sh agar memeriksa objek S3 (`files-local.sql` hanya baris `local`).
2. Atau replikasi bucket ke penyedia/akun lain (versi harian, retensi ≤ 30 hari) dan tuliskan prosedur restore-nya.

Uji di staging dengan restore drill lengkap sebelum production.

## 7. Pembersihan salinan lama (sesudah verifikasi dan backup)

Syarat: masa transisi lewat tanpa insiden, dua backup berkas S3 berhasil, restore drill dengan backup S3 lulus, dan
pemeriksaan sha256 sampel ulang (bagian 3) bersih. Lalu:

```sh
# Arsipkan dahulu daftar yang akan dihapus untuk bukti, kemudian hapus berkas lokal (kecuali .tmp yang dibersihkan job).
find /data/files -type f ! -path '/data/files/.tmp/*' | wc -l > /var/log/kapdh-storage-cleanup.count
rm -rf /data/files/avatar /data/files/chat_image /data/files/post_cover /data/files/banner_image \
  /data/files/event_cover /data/files/payment_proof /data/files/adjustment_evidence /data/files/audit_export
```

Catat tanggal, jumlah berkas dan penanggung jawab di log operasional; perbarui `DISK_PATHS`/ambang monitor bila perlu.

## 8. Hal yang perlu diputuskan/dikembangkan

- Baca-cadangan per berkas (`files.storage_driver` dipakai saat membaca, atau driver gabungan S3-lalu-lokal) agar
  pengalihan tidak memerlukan maintenance dan salinan susulan.
- CLI perpindahan di API memakai `transferObject` (pencocokan `files.sha256` per objek) untuk menggantikan bagian 3.
- Mode berkas S3 pada skrip backup/restore/verifikasi (bagian 6).
