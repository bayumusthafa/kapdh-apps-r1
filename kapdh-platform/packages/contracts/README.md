# @kapdh/contracts

Kontrak API KAPDH Apps (OpenAPI 3.1), skema event realtime, tipe TypeScript, dan SDK Dart `kapdh_api` yang
dibangkitkan (PRD 5.2, N-13, ARCHITECTURE §6). Kontrak ditulis lebih dulu; API, web admin, situs publik dan Flutter
mengikuti kontrak.

## Struktur

```
openapi/
  root.yaml               info, servers, keamanan global, komponen BERSAMA (Error, ErrorCode, Permission, Money,
                          Password, EffectiveStatus, AccountStatus, Gender, ClassLevel, AdminRole, DevicePlatform,
                          parameter Cursor/Limit/IfMatch/IdempotencyKey/ReauthToken/AppVersion/AppPlatform,
                          respons baku, securitySchemes bearerAuth + adminRefreshCookie)
  domains/<domain>.yaml   tags + paths + components milik SATU domain (24 berkas, ARCHITECTURE §6)
events/
  envelope.schema.json    amplop event Socket.IO /realtime (JSON Schema 2020-12), lihat events/README.md
scripts/                  assemble.mjs, gen-ts.mjs, gen-dart.mjs, validate-events.mjs (+ lib/, test/)
redocly.yaml              aturan lint ketat
dart/kapdh_api/           paket Dart: pubspec.yaml, analysis_options.yaml, lib/kapdh_api.dart dan test/ ditulis
                          tangan; lib/src/** DIBANGKITKAN
dist/openapi.yaml         hasil gabungan (dibangkitkan; diekspor sebagai "@kapdh/contracts/openapi.yaml")
src/index.ts              ekspor tipe; src/generated/** DIBANGKITKAN
```

Berkas yang dibangkitkan (`dist/`, `src/generated/`, `dart/kapdh_api/lib/src/`) di-gitignore dan merupakan output
turbo. Klon baru cukup `pnpm install && pnpm build`. Setelah pull, jalankan `pnpm contracts:gen` agar SDK Dart untuk
kapdh-mobile ikut diperbarui.

## Alur kerja penulis domain

1. **Miliki satu berkas** `openapi/domains/<domain>.yaml` (lihat peta kepemilikan di docs/BUILD_PLAN.md). Jangan
   menyunting `root.yaml`, berkas domain lain, atau berkas yang dibangkitkan. Butuh komponen bersama baru? Ajukan ke
   integrator sebagai perubahan kecil pada `root.yaml`.
2. Berkas domain hanya boleh berisi `tags`, `paths`, `components` dan memakai rujukan internal
   `#/components/...` (komponen root dan domain lain dapat dirujuk setelah digabung).
3. Setiap operasi: tepat satu tag milik domainnya, `operationId` camelCase berawalan kata kerja (`listX`, `getX`,
   `createX`, admin `adminX`), `summary`/`description` Bahasa Indonesia dengan rujukan AC/PRD, dan
   `default: { $ref: "#/components/responses/Error" }`. Endpoint tanpa autentikasi memakai `security: []`.
4. Body request/response wajib `$ref` ke skema bernama (aturan lint). Nama skema PascalCase dan berprefiks domain
   bila ambigu (`EventSummary`, `ChatMessage`, `AdminMemberDetail`); hindari nama yang bentrok dengan Dart/Flutter
   (`Notification`, `Banner`, `Page`, `Route`, `State`, ...) karena generator Dart menolaknya.
5. Konvensi: properti snake_case; enum string lower_snake; nullable `type: [X, "null"]` atau
   `oneOf: [{ $ref }, { type: "null" }]` untuk ref; uang `Money`; waktu `format: date-time` UTC; daftar `cursor` +
   `limit` dengan respons `<Thing>Page` = `{items, next_cursor}` (admin + `total`); pembaruan berversi memakai
   `IfMatch` dan respons berisi `version`; tindakan sensitif memakai parameter `ReauthToken`; mutasi yang dapat
   diulang memakai `IdempotencyKey`. Field berisi rahasia yang tidak bernama `*password*`/`*token*` diberi
   `x-sensitive: true` agar tidak tercetak oleh `toString()` SDK.
6. Generator Dart tidak mendukung `oneOf`/`anyOf` polimorfik, `discriminator`, enum non-string, atau respons 2xx
   dengan skema berbeda dalam satu operasi; gunakan objek dengan field opsional, `allOf`, atau satu skema respons.
7. Jalankan `pnpm contracts:lint` sampai bersih, lalu `pnpm contracts:gen` dan implementasikan endpoint. Setiap
   endpoint diuji dengan `expectOperation(method, path, res)` di `apps/api/test` (lihat contract.e2e.test.ts); tes
   cakupan gagal bila rute Fastify terdaftar tanpa operasi di kontrak.

## Perintah

| Perintah (dari kapdh-platform)        | Fungsi                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm contracts:bundle`               | Gabung root + domain ke `dist/openapi.yaml` (gagal bila ada duplikat, lihat di bawah). |
| `pnpm contracts:lint`                 | Bundle, `redocly lint` aturan ketat, validasi `events/*.schema.json`, eslint skrip.    |
| `pnpm contracts:gen`                  | Bundle, tipe TypeScript (`src/generated`), dan SDK Dart (`dart/kapdh_api/lib/src`).    |
| `pnpm --filter @kapdh/contracts test` | Uji skrip (penggabung, generator Dart, skema event).                                   |

Bundle gagal bila ada path, operationId, tag atau komponen ganda (termasuk path yang hanya beda nama parameter),
`$ref` yang tidak ditemukan atau eksternal, kunci tingkat atas selain `tags`/`paths`/`components`, atau operasi
yang memakai tag milik domain lain.

SDK Dart diverifikasi dari `packages/contracts/dart/kapdh_api` dengan `dart.bat pub get`, `dart.bat analyze`
(tanpa galat/peringatan) dan `dart.bat test`. kapdh-mobile memakainya lewat dependensi path (ADR-001); saat rilis
diganti dependensi git bertag `contracts-vX.Y.Z`.

## SDK Dart `kapdh_api`

- Model imutabel dengan `fromJson`/`toJson` (JSON snake_case, field camelCase), `==`/`hashCode` struktural, dan
  `toString()` tanpa sandi/OTP/token. `Money` tetap `String`; waktu `DateTime` (dikirim UTC).
- Enum memiliki nilai cadangan `unknown` sehingga klien lama tidak gagal saat server menambah nilai (N-13).
- Field body request yang opsional sekaligus nullable bertipe `Optional<T?>` (tidak dikirim / null / nilai).
- Satu kelas API per tag (`AuthApi`, `PaymentsApi`, ...; agregat `KapdhApi(dio)`) di atas `Dio` milik aplikasi,
  sehingga interceptor auth/refresh aplikasi tetap berlaku. `RequestOptions.extra` berisi `kapdhOperationIdKey` dan
  `kapdhAuthRequiredKey` (false untuk operasi publik: jangan tempel token atau refresh saat 401).
- Semua kegagalan menjadi `ApiException` (`api`, `network`, `cancelled`, `invalidResponse`) dengan `ui` dari katalog
  galat terbangkit `errorUiFor` (sumber: `@kapdh/shared` ERROR_UI) serta `routeForStatus`/`membershipLabel`
  (sumber: `@kapdh/shared` status.ts). Kegagalan jaringan tidak boleh menghapus token.

Perubahan kontrak yang memutus versi klien yang masih didukung harus gagal di CI (N-13).
