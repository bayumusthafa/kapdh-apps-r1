# Runbook: uji beban, kapasitas dan realtime KAPDH

Pemilik: pengembang dan pengelola infra (D7 "konfirmasi kapasitas melalui uji beban", akhir Tahap 0). Saksi: QA.
Rujukan: PRD 2.4 N-01, N-02, N-04, 5.3, 9.1 U-07/U-11, 10.1 D7, D8; ARCHITECTURE §10. Perkakas:
`kapdh-platform/infra/loadtest/` (generator beban) dan CLI `loadtest:seed` di image API (dataset sintetis).
Temuan audit yang ditutup alat ini: D2-04 (N-02 p95), D2-05 (N-01 p95), D2-06 (N-04 kapasitas).

> **Status bukti.** Alat dan alurnya diuji sungguhan dengan ukuran kecil terhadap API uji yang mendengar (Fastify +
> gateway Socket.IO yang sama dengan production, database PGlite): `apps/api/test/ops/loadtest.e2e.test.ts` menjalankan
> `loadtest:seed`, `api-load.mjs` (mode N-01, mode kapasitas, jalur GAGAL) dan `realtime-load.mjs` (latensi dan
> sinkron reconnect). Itu membuktikan alat, **bukan angka kinerja**. N-01, N-02 dan N-04 baru terbukti setelah run
> di VPS sasaran dengan dataset penuh tercatat sesuai bagian 7 (U-11). Belum pernah dijalankan di staging.

## 1. Sasaran dan cara mengukur

| ID | Target (PRD 2.4, usulan baseline D8) | Alat | Ukuran |
| -- | ------------------------------------ | ---- | ------ |
| N-01 | p95 ≤ 500 ms baca sederhana, ≤ 1.000 ms keputusan/reservasi, 10 rps selama 15 menit, galat tak terduga < 1 % | `api-load.mjs` mode N-01 | p95 per kelas `read` dan `decision`, `unexpected_error_rate` |
| N-02 | p95 pesan committed tampil di penerima online ≤ 2 detik; reconnect mengambil pesan yang hilang tanpa duplikasi | `realtime-load.mjs`, berjalan BERSAMAAN dengan N-01 | p95 `kirim → message.created diterima`, hilang/duplikat, sinkron `after=<jangkar>` |
| N-04 | Angka kapasitas dari uji beban; kapasitas dinaikkan sebelum N-01/N-02 gagal | `api-load.mjs --steps` | laju tertinggi yang masih lulus N-01, titik gagal pertama, ambang naik kapasitas |

Kondisi uji PRD 2.4: VPS sasaran (D7: 4 vCPU, RAM 8 GB, disk 100 GB), 100 sesi anggota, 5 sesi admin, 5.000 profil,
100.000 pesan. Unggah berkas, pengiriman email/push eksternal dan cold start diukur terpisah (tidak termasuk alat ini).

Definisi yang dipakai alat (catat di laporan bila D8 menetapkan lain):

- **Baca sederhana** (`read`): beranda, berita, daftar/detail event, cari/profil direktori, `/me`, kartu, keanggotaan,
  notifikasi, daftar room dan riwayat pesan (halaman terbaru dan `before`), konfigurasi publik, tiket saya; baca admin:
  antrean dan detail payment, cari anggota, dasbor.
- **Keputusan/reservasi** (`decision`): `POST /admin/payments/{id}/decision` (setujui renewal), `POST
  /events/{id}/reservations` (event gratis) dan `POST /me/tickets/{id}/cancel`.
- **Galat tak terduga**: 5xx, timeout/jaringan, dan 4xx selain yang diharapkan. 409 pada keputusan/reservasi/pembatalan
  (keputusan bersamaan, versi berubah) dicatat `conflict`, bukan galat; 429 dicatat `rate_limited` terpisah.
- **Latensi N-02**: jam generator yang sama, dari sebelum `POST /chat/rooms/{id}/messages` dikirim (batas atas waktu
  commit) sampai event `message.created` diterima socket penerima. Penerima online yang tidak menerima dalam
  `--grace-ms` (bawaan 10 detik) dihitung tak hingga. Waktu render di aplikasi Flutter tidak termasuk (diuji
  terpisah di U-13/N-03).

Campuran operasi `api-load.mjs` (bobot per 100 kedatangan; ubah di kepala skrip bila D8 menetapkan profil lain):
79 baca anggota, 6 baca admin, 15 keputusan/reservasi (keputusan payment 5, reservasi 7, pembatalan 3). Model beban
TERBUKA: kedatangan dijadwalkan pada laju tetap tanpa menunggu respons, sehingga API yang melambat tidak menurunkan
beban (tanpa coordinated omission). Generator menghormati rate limit server (direktori 60/menit dan 600/jam,
reservasi 20/jam, kirim chat 60/menit per akun) agar 429 tidak mengaburkan hasil.

## 2. Lingkungan

- **Hanya staging** (`staging-api`, D12) dengan database, Redis, volume dan secrets terpisah dari production (PRD
  5.3). Data sintetis saja; `loadtest:seed` menolak `NODE_ENV=production` dan menuntut nama database dikonfirmasi.
- **VPS setara production** (D7). Bila staging berbagi VPS dengan production, uji beban DILARANG setelah ada data
  pengguna nyata (PRD 5.3 "staging tidak boleh melakukan stress test yang mengganggu production"): jalankan sebelum
  go-live, atau di VPS sementara berspesifikasi sama yang dimusnahkan setelahnya.
- **Image** sama dengan kandidat rilis (catat tag/digest). Worker hidup (outbox, notifikasi), Redis hidup.
- **Generator** di mesin TERPISAH dari VPS yang diuji, dekat secara jaringan (region Jakarta/Singapura), Node ≥ 22,
  tanpa dependensi lain. Generator di VPS yang sama ikut memakan CPU dan memalsukan hasil.
- **Pengiriman eksternal dimatikan**: `SMTP_URL` ke penampung (mis. Mailpit di staging), `FCM_*` kosong (push nonaktif),
  sehingga persetujuan payment dan pesan chat tidak mengirim email/push ke alamat `.test`.
- `app_settings.min_app_version` ≤ `--app-version` alat (bawaan `1.0.0`), maintenance nonaktif.

## 3. Persiapan dataset (sekali per siklus uji)

1. Reset database staging: buat ulang database kosong → `pnpm --filter @kapdh/database migrate` → `infra/db/roles.sql`
   → `seed:reference` → bootstrap Super Admin (PRD 8.2). Kosongkan volume berkas staging.
2. Dataset sintetis PRD 2.4 dari kontainer API staging (env API: `DATABASE_URL` kapdh_app, `BCRYPT_COST`,
   `TOTP_ENC_KEY`):

   ```sh
   docker exec -it <kontainer-api-staging> node dist/cli/loadtest-seed.js \
     --confirm-database <nama-database-staging> --out /tmp/kapdh-loadtest.json
   # Bawaan: --profiles 5000 --login-members 100 --admins 5 --messages 100000 --group-rooms 40 --direct-rooms 200
   #         --events 20 --pending-payments 1000 --posts 30. Untuk uji kapasitas tambah akun: --login-members 300.
   docker cp <kontainer-api-staging>:/tmp/kapdh-loadtest.json ./kapdh-loadtest.json && chmod 600 kapdh-loadtest.json
   docker exec <kontainer-api-staging> rm /tmp/kapdh-loadtest.json
   ```

   Isi dataset: profil alumni aktif bertanda bio "[Uji Beban]" dengan domain `@uji-beban.kapdh.test` (nama orang
   wajar agar pencarian prefix realistis), profesi/keahlian dari master, 100 akun login, 5 admin (izin
   `payments.read`, `payments.decide`, `members.read`) dengan TOTP, room realtime (10 akun login + 40 profil lain per
   room), grup biasa, dua grup "besar" untuk paging riwayat dalam, room langsung, 100.000 pesan, 20 event gratis
   terbuka, 1.000 payment renewal menunggu keputusan, 30 berita.
3. Pindahkan `kapdh-loadtest.json` ke mesin generator lewat kanal aman (scp). Berkas berisi sandi akun uji dan secret
   TOTP admin uji: 0600, jangan di-commit, hapus setelah siklus selesai.
4. Antrean payment habis setelah beberapa run keputusan: tambah dengan
   `node dist/cli/loadtest-seed.js --confirm-database <db> --top-up-payments 1000`.
5. Cuplik ukuran tabel untuk bukti: `select count(*) from app.alumni; select count(*) from app.messages;`.

## 4. Menjalankan N-01 dan N-02 (bersamaan)

Di mesin generator, dua terminal, mulai hampir bersamaan (warmup realtime lebih pendek):

```sh
# Terminal 1: N-01, 10 rps selama 15 menit setelah warmup 60 detik, 100 anggota + 5 admin.
node infra/loadtest/api-load.mjs --credentials kapdh-loadtest.json --base-url https://staging-api.kapdh.or.id \
  --rate 10 --duration 900 --warmup 60 --report-dir ./bukti-uji-beban

# Terminal 2: N-02, 100 sesi realtime, 2 pesan/detik selama 15 menit, 10 % sesi diputus lalu disinkron.
node infra/loadtest/realtime-load.mjs --credentials kapdh-loadtest.json --base-url https://staging-api.kapdh.or.id \
  --sessions 100 --rate 2 --duration 900 --warmup 30 --reconnect-fraction 0.1 --report-dir ./bukti-uji-beban
```

Keduanya login dengan akun yang sama (sesi berbeda per alat), sehingga di VPS terlihat sekitar 200 sesi anggota; untuk
tepat 100 sesi anggota PRD 2.4, jalankan realtime dengan `--sessions 50` dan api-load dengan `--members 50`, atau
buat dataset dengan `--login-members 200` lalu bagi akun (catat pilihan di laporan).

Selama run, rekam metrik server di VPS (setiap 10 detik, simpan sebagai bukti):

```sh
while sleep 10; do date -u +%FT%TZ; docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'; \
  uptime; done > metrik-$(date +%F).log
```

Kode keluar dan putusan:

| Alat | 0 | 1 | 2 |
| ---- | - | - | - |
| `api-load.mjs` (N-01) | LULUS | GAGAL ambang N-01 | TIDAK SAH |
| `realtime-load.mjs` (N-02) | LULUS | GAGAL (p95, pesan hilang/duplikat, sinkron reconnect) | TIDAK SAH |
| `api-load.mjs --steps` (N-04) | SELESAI (laporan memuat titik jenuh) | - | TIDAK SAH |

**TIDAK SAH** berarti generator, bukan API, yang bermasalah; perbaiki lalu ulangi:

| Penyebab di laporan | Tindakan |
| ------------------- | -------- |
| `dropped_rate` > 1 % | Generator jenuh/terlalu lambat: naikkan `--max-in-flight`, pakai mesin generator lebih kuat atau dekat |
| `rate_limited_rate` > 1 % | Terlalu sedikit akun untuk laju itu: dataset dengan `--login-members` lebih besar, `--members` lebih banyak |
| `decision_samples` < 80 % rencana | Antrean payment habis (`--top-up-payments`) atau anggaran reservasi akun habis (lebih banyak akun) |
| Setup gagal (login/MFA) | Periksa dataset, min_app_version, maintenance; MFA admin menunggu langkah TOTP baru bila admin sama baru dipakai |

## 5. Kapasitas N-04 (titik jenuh dan ambang naik kapasitas)

```sh
node infra/loadtest/api-load.mjs --credentials kapdh-loadtest.json --base-url https://staging-api.kapdh.or.id \
  --steps 10,20,30,40,60,80 --step-duration 300 --warmup 60 --members 300 --report-dir ./bukti-uji-beban
```

- Setiap tingkat berjalan 5 menit pada laju tetap dan dinilai dengan ambang N-01 yang sama. **Kapasitas** = laju
  tertinggi yang masih lulus; **titik gagal** = tingkat pertama yang gagal. Bila tidak ada yang gagal, tambah tingkat.
- Jalankan juga `realtime-load.mjs` pada tingkat sekitar kapasitas untuk memastikan N-02 belum gagal lebih dahulu
  (realtime dapat jenuh sebelum HTTP).
- **Ambang naik kapasitas** (usulan, sahkan di D7/D8): 70 % dari kapasitas terukur (`scale_trigger_rps` di laporan),
  ATAU CPU rata-rata > 70 % selama 15 menit, RAM > 85 %, atau p95 baca produksi > 350 ms (70 % batas N-01). Catat di
  tabel berikut dan di docs/runbooks/monitoring.md bagian 8 setelah run pertama:

| Tanggal | Image | VPS | Kapasitas (kedatangan/detik) | Titik gagal | CPU/RAM pada kapasitas | Ambang naik kapasitas | Penanggung jawab |
| ------- | ----- | --- | ---------------------------- | ----------- | ---------------------- | --------------------- | ---------------- |
| (isi)   |       |     |                              |             |                        |                       |                  |

- Baseline 30 hari setelah go-live (PRD 1.1) dibandingkan dengan angka ini; ulangi uji kapasitas setelah perubahan
  besar (versi PostgreSQL/Node, kueri baru di jalur baca utama, pindah storage) dan setiap kali ambang tercapai.

## 6. Membaca laporan

`<report-dir>/api-load-<waktu>.json|txt` dan `realtime-load-<waktu>.json|txt`:

- `phases[].classes.read|decision`: jumlah, p50/p90/p95/p99/maks, ok/konflik/429/galat.
- `phases[].ops.<operasi>`: rincian per endpoint (status HTTP dan kode galat), untuk mencari endpoint yang paling
  lambat. Bila p95 gagal, jalankan `EXPLAIN (ANALYZE, BUFFERS)` kueri endpoint itu di staging (PRD 6.5, indeks).
- `phases[].substituted`: operasi yang diganti baca beranda karena anggaran rate limit/antrean habis.
- `capacity`: `capacity_rps`, `knee_rate`, `scale_trigger_rps` (mode N-04).
- Realtime: `delivery.latency_ms`, `delivery.missing`, `counters.unexpectedDisconnects`, `reconnect` (pesan yang di-ack
  selama sesi offline wajib muncul tepat sekali pada sinkron `after=<jangkar>`).

Laporan tidak memuat sandi, token, kode TOTP, isi pesan atau data pribadi (data memang sintetis).

## 7. Bukti untuk paket penerimaan (U-11)

Simpan di `docs/qa/load/<yyyy-mm-dd>/` (atau arsip terkendali yang dirujuk dari sana):

- [ ] Laporan JSON dan TXT N-01 (LULUS), N-02 (LULUS) dan N-04 (SELESAI dengan kapasitas dan titik gagal)
- [ ] Versi image API/worker (tag + digest), commit, versi skema (journal migrasi)
- [ ] Spesifikasi VPS staging dan generator (CPU/RAM, region, versi Node), jaringan antara keduanya
- [ ] Ringkasan dataset (keluaran `loadtest:seed`, hitungan tabel) dan opsi alat yang dipakai
- [ ] Metrik server selama run (`metrik-*.log`), termasuk CPU/RAM PostgreSQL dan Redis
- [ ] Tabel kapasitas bagian 5 terisi dan disalin ke monitoring.md bagian 8
- [ ] Tanda tangan pengembang dan pengelola infra; saksi QA; persetujuan D7 bila kapasitas VPS diubah

## 8. Pembersihan

Hapus `kapdh-loadtest.json` dari mesin generator dan kontainer, reset database staging (bagian 3 langkah 1) sebelum
dipakai uji fungsional lain, dan kosongkan penampung email staging.

## 9. Batasan yang diketahui

- Belum dijalankan di staging (lihat Status bukti). Run pertama juga membuktikan perilaku generator pada laju tinggi
  (koneksi keep-alive Node, batas file descriptor mesin generator).
- Event berbayar (hold, unggah bukti, review) tidak termasuk campuran reservasi; reservasi memakai event gratis.
  Unggah berkas dan pengiriman email/push diukur terpisah (PRD 2.4).
- N-02 diukur sampai socket menerima event; waktu tampil di aplikasi Flutter tidak termasuk.
- Ketersediaan bulanan N-05 diukur monitor eksternal (monitoring.md), bukan alat ini.
