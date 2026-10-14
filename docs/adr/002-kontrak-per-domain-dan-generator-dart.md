# ADR-002: Kontrak OpenAPI dipecah per domain, SDK Dart dibangkitkan generator Node kustom

- Status: Diterima (Fase A, diperketat Fase B)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 5.2, 7.2, N-13; ARCHITECTURE §6; handoff `docs/handoff/phase-a-contracts-infra.md`
- Bukti di kode (di `kapdh-platform/packages/contracts/`): `openapi/root.yaml`, `openapi/domains/*.yaml`,
  `scripts/assemble.mjs`, `scripts/gen-ts.mjs`, `scripts/gen-dart.mjs`, `scripts/lib/dart/generate.mjs`,
  `redocly.yaml`, `CHANGELOG.md`

## Konteks

PRD 5.2 mewajibkan OpenAPI 3.1 sebagai sumber SDK Dart dan TypeScript; skema TypeScript bersama tidak boleh
menggantikan kontrak Dart. Tujuh penulis kontrak (C1 sampai C7) bekerja paralel, sehingga satu berkas `openapi.yaml`
besar akan selalu konflik. Mesin build tidak memiliki Java (ARCHITECTURE §1), sehingga `openapi-generator` (JVM) tidak
dapat dipakai, dan generator Dart yang tersedia tidak memahami konvensi proyek (Money string, enum yang kompatibel ke
depan, `x-sensitive`, katalog galat).

## Keputusan

1. Sumber kontrak = `openapi/root.yaml` (komponen bersama saja, `paths` kosong) + 24 berkas
   `openapi/domains/<domain>.yaml`, masing-masing hanya `tags`, `paths`, `components` milik satu domain.
2. `pnpm contracts:bundle` menggabungkan ke `dist/openapi.yaml` dan gagal pada path, operationId, tag, atau komponen
   ganda serta `$ref` yang tidak ditemukan. `pnpm contracts:lint` menjalankan Redocly dengan aturan ketat (body
   bernama, properti snake_case) dan validasi skema event realtime.
3. Tipe TypeScript dibangkitkan dengan openapi-typescript (`scripts/gen-ts.mjs`); SDK Dart `kapdh_api` dibangkitkan
   generator Node milik proyek (`scripts/gen-dart.mjs`), termasuk katalog galat `ERROR_UI` dari `@kapdh/shared`,
   `RealtimeEvent.fromJson` dan `ApiException`. `pnpm contracts:test-dart` menjalankan `dart analyze --fatal-infos` dan
   `dart test` pada SDK nyata dan paket fixture.
4. Berkas terbangkit (`dist/`, `src/generated/`, `dart/kapdh_api/lib/src/`) tidak di-commit; turbo memperlakukannya
   sebagai output build.
5. Setiap rute Fastify wajib punya operasi di kontrak (uji cakupan `contract.e2e.test.ts`), dan setiap respons uji API
   divalidasi `expectOperation(method, path, res)`.

## Alternatif yang dipertimbangkan

- **Satu berkas OpenAPI**: ditolak karena konflik merge antar penulis domain.
- **openapi-generator (Java) atau swagger_dart_code_generator**: ditolak karena tidak ada JVM di mesin build dan hasil
  tidak sesuai konvensi (enum tidak dikenal, Money, rahasia di `toString()`).
- **Klien Dart tulisan tangan**: ditolak; melanggar PRD 5.2 dan N-13.

## Konsekuensi

- Generator Dart menjadi kode proyek yang harus dipelihara; ia menolak konstruksi yang tidak didukung (oneOf
  polimorfik, discriminator, enum non-string, nama yang bentrok dengan Dart/Flutter). Aturan penulisan ada di
  `packages/contracts/README.md`.
- Dua peringatan Redocly `no-ambiguous-paths` (`/files/content/{token}`, `/files/public/{fileId}` vs
  `/files/{fileId}/access`) diketahui dan diterima; mengganti nama path adalah perubahan yang memutus klien.
- Belum ada gerbang CI yang membandingkan kontrak dengan rilis sebelumnya (temuan audit D2-12); perubahan yang memutus
  klien dicatat manual di `CHANGELOG.md`.
