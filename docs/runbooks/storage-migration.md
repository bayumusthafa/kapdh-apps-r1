# Runbook: perpindahan berkas dari disk lokal ke S3-compatible

Rujukan: PRD 5.4 (pemicu dan syarat perpindahan: salin, cocokkan checksum, baca-cadangan, bersihkan), 7.1 (Storage:
lokal awal, S3 setelah perpindahan terverifikasi), 10.1 D9 (ambang, penyedia, jadwal), D2 (retensi); ARCHITECTURE
§4.2 (`FilesService` + `StorageDriver`); `packages/storage` (`S3Driver`, `FallbackReadDriver`, `transferObject`).
Pemilik: pengelola infra; persetujuan jadwal: pemilik produk (D9).

> **Status bukti.** Baca-cadangan diimplementasikan dan diuji unit: `FallbackReadDriver` (tulis ke S3, baca S3 lalu
> disk lama, hapus di keduanya) dipasang `createStorageDriver` bila `STORAGE_DRIVER=s3` dan
> `STORAGE_FALLBACK_LOCAL_ROOT` diisi (`packages/storage/src/drivers.test.ts`, server S3 tiruan;
> `packages/config` menolak variabel itu tanpa `STORAGE_DRIVER=s3`). Prosedur di bawah **belum pernah dijalankan**
> terhadap penyedia S3 sungguhan, dan skrip backup/restore belum mendukung berkas di S3 (bagian 2 butir 5, bagian 7).
> Gladi wajib di staging lebih dahulu.

## 1. Pemicu (PRD 5.4, D9)

- Disk `/data/files` (atau volume VPS) > 60 % ATAU total berkas > 20 GB, disertai proyeksi pertumbuhan
  (`infra/monitoring/check-host.sh`, monitor "Disk peringatan"). Kritis 80 %: lakukan langkah sementara (perbesar disk)
  lalu jadwalkan perpindahan.
- Keputusan ditulis di log operasional: tanggal, penyedia, region, perkiraan biaya, jendela pengalihan.

## 2. Prasyarat

1. **Bucket berkas** baru `kapdh-<env>-files` di penyedia S3-compatible (region Jakarta/Singapura): PRIVAT (blokir akses
   publik; berkas publik tetap dilayani lewat API `/files/public/{id}`), terpisah dari bucket backup dan bucket deletion
   ledger (packages/config menolak bucket berkas = bucket ledger). Versioning boleh dengan aturan hapus versi noncurrent
   ≤ 30 hari (D2: berkas akun terhapus tidak boleh tertahan melebihi masa rotasi backup).
2. Kunci API khusus aplikasi (baca/tulis/hapus objek di bucket itu saja).
3. `rclone` ≥ 1.60 di VPS dengan remote `kapdhfiles:` (env `RCLONE_CONFIG_KAPDHFILES_*`) memakai kunci yang sama.
4. Backup berhasil < 24 jam dan restore drill bulan berjalan lulus (backup-restore.md).
5. **Backup berkas S3 sudah siap dan diuji** (bagian 7): mulai tahap A, unggahan baru hanya ada di bucket, sedangkan
   `backup.sh` saat ini hanya mencadangkan `/data/files`. Tanpa butir ini RPO berkas baru tidak terpenuhi (N-06).

## 3. Tahap A: pengalihan tulis dengan baca-cadangan (restart singkat, tanpa maintenance)

1. Umumkan jendela singkat (restart API/worker). Catat waktu **T-switch**.
2. Env API DAN worker di Coolify (keduanya tetap memasang volume `/data/files`):

   ```
   STORAGE_DRIVER=s3
   S3_ENDPOINT=...  S3_REGION=...  S3_BUCKET=kapdh-prod-files
   S3_ACCESS_KEY_ID=...  S3_SECRET_ACCESS_KEY=...  S3_FORCE_PATH_STYLE=(bila penyedia butuh)
   STORAGE_FALLBACK_LOCAL_ROOT=/data/files
   ```

3. Deploy ulang API lalu worker. `GET /api/v1/health/ready` harus `storage: ok`.
4. Perilaku sejak T-switch (`FallbackReadDriver`):
   - unggahan baru dan ekspor ditulis ke bucket; baris `files` baru bercatatan `storage_driver = 's3'`;
   - pembacaan mencoba bucket lalu `/data/files`, sehingga berkas lama tetap tersaji tanpa salinan lebih dahulu;
   - penghapusan (akun, discard, cleanup) menghapus di bucket DAN di disk, sehingga berkas terhapus tidak tertinggal di
     lokasi lama (D2, AC F14-6).
5. Smoke test: unduh 5 berkas lama (bukti bayar lewat admin, avatar publik, gambar chat), unggah avatar baru (objek
   muncul di bucket: `rclone lsf kapdhfiles:kapdh-prod-files/avatar --max-age 10m`), ekspor audit kecil.

## 4. Tahap B: salin dan cocokkan checksum (layanan tetap berjalan)

```sh
# Salinan berkas lama (tanpa folder sementara unggahan); --checksum membandingkan hash, bukan hanya ukuran/waktu.
rclone copy /data/files kapdhfiles:kapdh-prod-files --checksum --exclude "/.tmp/**" --transfers 8 \
  --log-file /var/log/kapdh-storage-copy.log --log-level INFO
# Verifikasi satu arah (setiap berkas lokal ada di bucket dengan hash sama).
rclone check /data/files kapdhfiles:kapdh-prod-files --one-way --exclude "/.tmp/**" --checksum
```

Verifikasi terhadap checksum yang dicatat aplikasi (`files.sha256`, PRD 5.4 "cocokkan checksum") untuk SELURUH baris
lama (bukan sampel; jalankan di luar jam sibuk bila egress berbayar):

```sh
# Daftar key dan sha256 baris lama yang belum dihapus (role kapdh_backup atau pemilik database).
psql -X -A -t -F ' ' -c "select object_key, sha256 from app.files where status = 'ready' and storage_driver = 'local' order by object_key" > /root/berkas-lama.txt
while read -r key sha; do
  remote=$(rclone cat "kapdhfiles:kapdh-prod-files/$key" | sha256sum | cut -d ' ' -f 1)
  [ "$remote" = "$sha" ] || echo "BERBEDA $key"
done < /root/berkas-lama.txt > /root/berkas-berbeda.txt
wc -l < /root/berkas-berbeda.txt   # wajib 0
```

Tidak boleh ada baris `BERBEDA`. Selama tahap ini pembacaan tetap aman karena baca-cadangan.

**Penghapusan yang bersilangan dengan salinan.** Bila sebuah berkas dihapus (penghapusan akun, discard) tepat saat
rclone menyalinnya, salinan dapat tertulis ke bucket SESUDAH penghapusan. Setelah salinan selesai:

1. Terapkan ulang deletion ledger terbaru terhadap driver baru (menghapus lagi objek akun yang sudah dihapus):
   salin bucket ledger luar VPS (`rclone copy kapdhledger:<bucket> /root/ledger --include "/account-deletions/**"`),
   lalu jalankan CLI di kontainer worker: `node dist/modules/account/ledger-reapply.cli.js --dir /root/ledger/account-deletions`
   (pasang folder ke kontainer). Keluaran `Gagal : 0`.
2. Hapus objek bucket milik baris yang sudah `deleted`:

   ```sh
   psql -X -A -t -c "select object_key from app.files where status = 'deleted' and object_key is not null" > /root/terhapus.txt
   rclone delete kapdhfiles:kapdh-prod-files --files-from /root/terhapus.txt --dry-run   # tinjau, lalu tanpa --dry-run
   ```

3. Catatan lokasi per berkas (bookkeeping PRD 5.4), sebagai pemilik database, hanya setelah verifikasi bersih:
   `UPDATE app.files SET storage_driver = 's3', updated_at = now() WHERE storage_driver = 'local' AND status <> 'deleted';`

## 5. Tahap C: lepas baca-cadangan

1. Ulangi `rclone check` (bagian 4) untuk menangkap berkas yang tersisa; wajib bersih.
2. Kosongkan `STORAGE_FALLBACK_LOCAL_ROOT` di env API dan worker, deploy ulang. Volume `/data/files` boleh tetap
   terpasang (salinan lama untuk jalur kembali) sampai bagian 8.
3. Smoke test bagian 3 butir 5. Selama 14 hari pantau log API untuk berkas yang tidak ditemukan (galat
   `StorageObjectNotFoundError`/404 berkas); setiap kasus: periksa key di disk lama, salin, cocokkan sha256.

## 6. Jalur kembali ke disk lokal

Dapat dilakukan dari tahap A, B atau C selama salinan lama belum dibersihkan (bagian 8):

1. Maintenance (incident-response.md bagian 4.1) dan hentikan worker (tidak ada unggahan/penghapusan selama pindah).
2. Salin objek yang hanya ada di bucket (dibuat sejak T-switch) ke disk dan cocokkan:
   `rclone copy kapdhfiles:kapdh-prod-files /data/files --checksum` lalu `rclone check kapdhfiles:kapdh-prod-files
   /data/files --one-way --checksum`.
3. Terapkan ulang deletion ledger terbaru terhadap disk (bagian 4 butir 1, dengan env `STORAGE_DRIVER=local`) agar
   berkas akun yang dihapus selama di S3 tidak hidup kembali dari salinan lama (AC F14-6), dan hapus berkas baris
   `deleted` dari disk (daftar bagian 4 butir 2).
4. Env API/worker: `STORAGE_DRIVER=local`, kosongkan `S3_*` dan `STORAGE_FALLBACK_LOCAL_ROOT`; `UPDATE app.files SET
   storage_driver = 'local' WHERE storage_driver = 's3'`; deploy ulang; smoke test; akhiri maintenance.

## 7. Backup berkas di S3 (wajib sebelum tahap A)

`infra/backup/backup.sh`, `restore.sh` dan `verify-restore.sh` saat ini hanya mendukung berkas di `/data/files`
(`files-local.sql` hanya baris `local`). Sebelum tahap A, salah satu dari:

1. **Disarankan:** tambahkan mode berkas S3 ke skrip backup: `rclone sync kapdhfiles:kapdh-prod-files
   /var/backups/kapdh/files-mirror --checksum` (cermin lokal, butuh ruang disk seukuran berkas) lalu `restic backup`
   cermin itu dengan tag `kapdh-files`, catat di manifest; restore menyalin balik ke bucket bersih dengan `rclone copy`;
   verify-restore.sh memeriksa objek bucket untuk baris `s3`. Selama tahap A-C, backup memuat KEDUA lokasi (disk dan
   cermin bucket).
2. Atau replikasi bucket ke penyedia/akun lain (versi harian, retensi ≤ 30 hari) dan tuliskan prosedur restore-nya.

Uji di staging dengan restore drill lengkap memakai backup S3 sebelum production.

## 8. Pembersihan salinan lama (sesudah verifikasi dan backup)

Syarat: tahap C berjalan ≥ 14 hari tanpa berkas hilang, dua backup berkas S3 berhasil, restore drill dengan backup S3
lulus, dan verifikasi sha256 bagian 4 diulang bersih. Lalu:

```sh
# Bukti jumlah berkas yang akan dihapus, kemudian hapus salinan lama (kecuali .tmp yang dibersihkan job).
find /data/files -type f ! -path '/data/files/.tmp/*' | wc -l > /var/log/kapdh-storage-cleanup.count
rm -rf /data/files/avatar /data/files/chat_image /data/files/post_cover /data/files/banner_image \
  /data/files/event_cover /data/files/payment_proof /data/files/adjustment_evidence /data/files/audit_export
```

Folder `ledger/account-deletions` lokal dipertahankan sampai backup yang memuatnya kedaluwarsa (30 hari). Catat tanggal,
jumlah berkas dan penanggung jawab di log operasional; perbarui `DISK_PATHS`/ambang monitor bila perlu.

## 9. Hal yang perlu dikembangkan

- Mode berkas S3 pada skrip backup/restore/verifikasi (bagian 7) dan uji keringnya.
- CLI perpindahan di API memakai `transferObject` (pencocokan `files.sha256` per objek, memperbarui
  `files.storage_driver` per berkas yang terverifikasi) untuk menggantikan rclone + skrip verifikasi bagian 4.
