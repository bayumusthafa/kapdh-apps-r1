# Uji beban <yyyy-mm-dd> (templat, N-01, N-02, N-04)

Salin ke `docs/qa/load/<yyyy-mm-dd>/README.md` dan lampirkan laporan JSON/TXT alat. Prosedur:
`docs/runbooks/load-test.md`. Data sintetis staging saja (PRD 5.3).

| Butir | Nilai |
| ----- | ----- |
| Lingkungan (staging, VPS: CPU/RAM/disk/region) | |
| Image API/worker (tag + digest), commit, versi skema | |
| Mesin generator (CPU/RAM, region, versi Node), RTT ke API | |
| Dataset (`dataset_id`, hitungan: profil, pesan, akun login, admin, payment menunggu) | |
| Opsi `api-load.mjs` / `realtime-load.mjs` | |

## N-01 (10 rps, 15 menit) — LULUS / GAGAL / TIDAK SAH

| Kelas | n | p50 | p95 | p99 | Ambang | Hasil |
| ----- | - | --- | --- | --- | ------ | ----- |
| read | | | | | ≤ 500 ms | |
| decision | | | | | ≤ 1.000 ms | |
| galat tak terduga | | | | | < 1 % | |

Endpoint paling lambat (p95) dan tindak lanjut: …

## N-02 (realtime, bersamaan dengan N-01) — LULUS / GAGAL / TIDAK SAH

| Ukuran | Nilai | Ambang |
| ------ | ----- | ------ |
| Pengiriman ke penerima online | | |
| p95 kirim → `message.created` | | ≤ 2.000 ms |
| Hilang / duplikat | | 0 / 0 |
| Sinkron reconnect (pesan wajib ada, hilang, duplikat) | | 0 hilang, 0 duplikat |

## N-04 (kapasitas bertingkat)

| Tingkat (kedatangan/detik) | p95 read | p95 decision | Galat | CPU/RAM VPS | Lulus N-01 |
| -------------------------- | -------- | ------------ | ----- | ----------- | ---------- |
| | | | | | |

Kapasitas: … kedatangan/detik; titik gagal: …; ambang naik kapasitas (70 %): …; disalin ke monitoring.md bagian 8.

Tanda tangan: pengembang …… pengelola infra …… saksi QA ……
