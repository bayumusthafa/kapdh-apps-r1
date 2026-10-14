# infra/loadtest — uji beban N-01, N-02, N-04

Generator beban Node ≥ 22 tanpa dependensi (model kedatangan terbuka) untuk staging (PRD 2.4, 9.1 U-11; D7; ADR-020).
Prosedur, lingkungan, tabel kapasitas dan bukti: `docs/runbooks/load-test.md`.

| Berkas              | Fungsi                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-load.mjs`      | N-01: campuran baca/keputusan/reservasi pada laju tetap (bawaan 10 rps, 15 menit), p95 per kelas, galat tak terduga; `--steps` = N-04 kapasitas bertingkat (titik gagal, ambang naik kapasitas) |
| `realtime-load.mjs` | N-02: latensi kirim → `message.created` di penerima online (p95 ≤ 2 detik), pesan hilang/duplikat, sinkron reconnect `after=<jangkar>`                                                          |
| `lib.mjs`           | Penjadwal kedatangan, pencatat persentil, klien HTTP, sesi anggota (refresh) dan admin (TOTP), klien Socket.IO minimal                                                                          |

Dataset dan kredensial dibuat CLI di image API (staging saja; menolak production):
`node dist/cli/loadtest-seed.js --confirm-database <db> --out kapdh-loadtest.json`.

```sh
node infra/loadtest/api-load.mjs --credentials kapdh-loadtest.json --base-url https://staging-api.kapdh.or.id
node infra/loadtest/realtime-load.mjs --credentials kapdh-loadtest.json --base-url https://staging-api.kapdh.or.id
```

Kode keluar: 0 lulus/selesai, 1 gagal ambang, 2 tidak sah (masalah generator/dataset). Uji alat di repo:
`apps/api/test/ops/loadtest.e2e.test.ts` (membuktikan alat, bukan angka kinerja).
