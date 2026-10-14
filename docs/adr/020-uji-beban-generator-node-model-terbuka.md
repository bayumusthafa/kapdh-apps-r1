# ADR-020: Uji beban dengan generator Node tanpa dependensi (model terbuka) dan dataset sintetis lewat CLI API

- Status: Diterima (Fase E, menutup alat untuk audit D2-04, D2-05, D2-06); angka kinerja belum diukur
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 2.4 N-01, N-02, N-04, 5.3, 9.1 U-07/U-11; D7 (konfirmasi kapasitas lewat uji beban), D8
- Bukti di kode: `kapdh-platform/infra/loadtest/{lib.mjs,api-load.mjs,realtime-load.mjs}`,
  `apps/api/src/cli/{loadtest-dataset.ts,loadtest-seed-command.ts,loadtest-seed.ts}` (`loadtest:seed`); uji
  `apps/api/test/ops/loadtest.e2e.test.ts`; runbook `docs/runbooks/load-test.md`

## Konteks

N-01 (p95 baca ≤ 500 ms, keputusan/reservasi ≤ 1.000 ms pada 10 rps selama 15 menit, galat < 1 %), N-02 (p95 pesan
committed tampil di penerima online ≤ 2 detik, reconnect tanpa celah/duplikat) dan N-04 (kapasitas dari uji beban)
harus diukur dengan 100 sesi anggota, 5 sesi admin, 5.000 profil dan 100.000 pesan. Login admin wajib TOTP;
realtime memakai Socket.IO (Engine.IO v4) dengan auth handshake. Mesin build tidak memiliki Docker/Java dan alat beban
harus dapat dibuktikan bekerja sebelum dipakai di staging.

## Keputusan

1. **Generator Node ≥ 22 tanpa dependensi** (fetch dan WebSocket bawaan, TOTP RFC 6238, klien Socket.IO minimal),
   bukan k6/artillery. Alasan: dapat diuji otomatis terhadap API uji yang benar-benar mendengar di CI/lokal (uji
   `loadtest.e2e`), protokol Socket.IO dan TOTP ditangani tanpa ekstensi, satu runtime yang sama dengan probe monitoring.
2. **Model beban terbuka:** kedatangan pada laju tetap tanpa menunggu respons (setara constant-arrival-rate k6),
   sehingga API yang melambat tidak menurunkan beban; kedatangan yang tidak dapat dijalankan dicatat `dropped`.
3. **Penilaian di alat:** p95 nearest-rank dari seluruh sampel (tanpa histogram aproksimasi), kelas `read` dan
   `decision`, galat tak terduga dibedakan dari konflik bisnis 409 dan 429. Run yang hasilnya ditentukan generator
   (dropped > 1 %, 429 > 1 %, sampel keputusan kurang) dinyatakan TIDAK SAH (kode 2), bukan GAGAL (kode 1).
   Generator menghormati rate limit server per akun agar 429 tidak mengaburkan pengukuran.
4. **N-04** memakai tingkat beban bertingkat dengan ambang N-01 yang sama; kapasitas = tingkat tertinggi yang lulus,
   ambang naik kapasitas usulan 70 % kapasitas.
5. **N-02** diukur dengan jam generator yang sama dari sebelum POST pesan sampai event `message.created` tiba;
   penerima online yang tidak menerima dihitung tak hingga. Sebagian sesi diputus lalu disinkron `after=<jangkar>`.
6. **Dataset** dibuat CLI `loadtest:seed` di image API (bukan SQL lepas) agar invarian produksi terjaga (nomor anggota
   dari nextval pada sesi yang sama, TOTP terenkripsi `TOTP_ENC_KEY`, urutan pesan). Menolak production, menuntut
   konfirmasi nama database, menolak dijalankan dua kali, menulis kredensial 0600.

## Alternatif yang dipertimbangkan

- **k6:** standar industri dengan laporan bawaan, tetapi Socket.IO dan TOTP perlu implementasi manual di JS k6, tidak
  dapat diuji di jalur uji repo tanpa biner tambahan, dan menambah alat yang harus dipin/diunduh.
- **autocannon/artillery:** menambah dependensi npm; model terbuka dan penilaian kelas tetap harus ditulis sendiri.
- **Dataset lewat SQL `generate_series`:** cepat, tetapi melanggar pemicu nomor anggota dan tidak dapat membuat secret
  TOTP terenkripsi.

## Konsekuensi

- Generator satu proses Node; untuk laju sangat tinggi jalankan beberapa proses/mesin dan gabungkan laporan, atau
  pertimbangkan k6 bila kapasitas jauh di atas ratusan rps.
- Angka N-01/N-02/N-04 tetap harus dihasilkan di VPS sasaran (U-11); uji repo hanya membuktikan alat.
