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
  <type>.schema.json      payload per jenis event (ditulis penulis kontrak C6)
scripts/                  assemble, gen-ts, gen-dart, validate-events, check-dart, release-dart-sdk (+ lib/, test/)
redocly.yaml              aturan lint ketat
dart/kapdh_api/           paket Dart: pubspec.yaml, analysis_options.yaml, lib/kapdh_api.dart dan test/ ditulis
                          tangan; lib/src/** DIBANGKITKAN
dist/openapi.yaml         hasil gabungan (dibangkitkan; diekspor sebagai "@kapdh/contracts/openapi.yaml")
src/index.ts              ekspor tipe; src/generated/** DIBANGKITKAN
CHANGELOG.md              perubahan kontrak per versi, termasuk yang memutus klien (N-13)
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
   `createX`, admin `adminX`; bukan kata tercadang Dart seperti `new`, `default`, `switch`), `summary`/`description`
   Bahasa Indonesia dengan rujukan AC/PRD, dan `default: { $ref: "#/components/responses/Error" }`. Endpoint tanpa
   autentikasi memakai `security: []`.
4. Body request/response wajib `$ref` ke skema bernama (aturan lint). Nama skema PascalCase dan berprefiks domain
   bila ambigu (`EventSummary`, `ChatMessage`, `AdminMemberDetail`); hindari nama yang bentrok dengan Dart/Flutter
   (`Notification`, `Banner`, `Page`, `Route`, `State`, ...) karena generator Dart menolaknya.
5. Konvensi: properti snake_case; enum string lower_snake; uang `Money`; waktu `format: date-time` UTC; daftar
   `cursor` + `limit` dengan respons `<Thing>Page` = `{items, next_cursor}` (admin + `total`); pembaruan berversi
   memakai `IfMatch` dan respons berisi `version`; tindakan sensitif memakai parameter `ReauthToken`; mutasi yang
   dapat diulang memakai `IdempotencyKey`. Field berisi rahasia yang tidak bernama `*password*`/`*token*` diberi
   `x-sensitive: true` agar tidak tercetak oleh `toString()` SDK. Nullable:
   - primitif: `type: [string, "null"]`;
   - ref: `oneOf: [{ $ref: "#/components/schemas/X" }, { type: "null" }]` (skema komponen sendiri tidak boleh
     nullable);
   - **enum inline**: `type: [string, "null"]` DAN `null` di daftar enum, mis.
     `{ type: [string, "null"], enum: [open, closed, null] }`. Tanpa `null` di `enum`, validator JSON Schema
     (expectOperation) menolak nilai null dari API; generator Dart menolak bentuk itu dengan pesan jelas. Untuk enum
     bernama pakai bentuk `oneOf` di atas.
6. Generator Dart tidak mendukung `oneOf`/`anyOf` polimorfik, `discriminator`, enum non-string, atau respons 2xx
   dengan skema berbeda dalam satu operasi; gunakan objek dengan field opsional, `allOf`, atau satu skema respons.
   Respons 2xx dengan body ditambah 2xx tanpa body (mis. `200` + `204`) didukung dan menjadi hasil nullable.
7. Jalankan `pnpm contracts:lint` sampai bersih, lalu `pnpm contracts:gen` dan, bila Dart SDK tersedia,
   `pnpm contracts:test-dart` (wajib sebelum menyerahkan perubahan generator atau konstruksi skema baru). Catat
   perubahan yang memutus klien di `CHANGELOG.md`. Implementasikan endpoint; setiap endpoint diuji dengan
   `expectOperation(method, path, res)` dari `apps/api/test/support/contract.ts`; tes cakupan di
   `contract.e2e.test.ts` gagal bila rute Fastify terdaftar tanpa operasi di kontrak.

## Perintah

| Perintah (dari kapdh-platform)        | Fungsi                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm contracts:bundle`               | Gabung root + domain ke `dist/openapi.yaml` (gagal bila ada duplikat, lihat di bawah).         |
| `pnpm contracts:lint`                 | Bundle, `redocly lint` aturan ketat, validasi `events/*.schema.json`, eslint skrip.            |
| `pnpm contracts:gen`                  | Bundle, tipe TypeScript (`src/generated`), dan SDK Dart (`dart/kapdh_api/lib/src`).            |
| `pnpm contracts:test-dart`            | SDK Dart: `dart analyze --fatal-infos` + `dart test` pada paket nyata dan paket fixture.       |
| `pnpm contracts:breaking`             | Gerbang N-13: `oasdiff breaking` terhadap tag `contracts-v*` tertinggi (lihat "Gerbang N-13"). |
| `pnpm contracts:release-sdk`          | Tag rilis `contracts-vX.Y.Z` berisi SDK terbangkit (lihat "Rilis SDK"); `-- --dry-run` dahulu. |
| `pnpm --filter @kapdh/contracts test` | Uji skrip (penggabung, generator Dart, skema event).                                           |

Bundle gagal bila ada path, operationId, tag atau komponen ganda (termasuk path yang hanya beda nama parameter),
`$ref` yang tidak ditemukan atau eksternal, kunci tingkat atas selain `tags`/`paths`/`components`, atau operasi
yang memakai tag milik domain lain.

`pnpm contracts:test-dart` mencari Dart dari env `DART`, `PATH`, atau `C:\flutter\flutter\bin`. Paket fixture
(`.dart_tool/kapdh_api_fixture`, di-gitignore) dibangkitkan dari kontrak nyata ditambah
`scripts/test/fixtures/sdk` (respons 200 | 204, enum inline nullable, multipart daftar berkas, payload event dengan
`$ref` antarberkas) dan diuji `scripts/test/fixtures/sdk/fixture_test.dart`, sehingga konstruksi yang belum dipakai
kontrak produk tetap terbukti lolos analyzer ketat.

## Event realtime

Amplop `{v, event_id, type, entity_id, ts, payload}` di `events/envelope.schema.json`; payload per jenis di
`events/<type>.schema.json` (title `<Type>Payload`). Setiap jenis event wajib punya berkas payload atau terdaftar di
`x-kapdh-payload-less` (payload selalu `{}`) atau `x-kapdh-payload-pending` (belum ditulis; lint memberi
peringatan). Rincian di `events/README.md`. Dibangkitkan menjadi TypeScript `RealtimePayloads`, `RealtimeEvent`
(union terdiskriminasi) dan Dart `RealtimeEvent` (sealed, satu subkelas per jenis, `UnknownRealtimeEvent` untuk
jenis baru).

## SDK Dart `kapdh_api`

- Model imutabel dengan `fromJson`/`toJson` (JSON snake_case, field camelCase), `==`/`hashCode` struktural, dan
  `toString()` tanpa sandi/OTP/token/field `x-sensitive`. `Money` tetap `String`; waktu `DateTime` (dikirim UTC).
- Enum memiliki nilai cadangan `unknown` sehingga klien lama tidak gagal saat server menambah nilai (N-13).
- Field body request yang opsional sekaligus nullable (atau bernilai bebas `{}`) bertipe `Optional<T?>` (tidak
  dikirim / null / nilai). Field opsional lain yang null tidak dikirim.
- Satu kelas API per tag (`AuthApi`, `PaymentsApi`, ...; agregat `KapdhApi(dio)`) di atas `Dio` milik aplikasi,
  sehingga interceptor auth/refresh aplikasi tetap berlaku. `RequestOptions.extra` berisi `kapdhOperationIdKey` dan
  `kapdhAuthRequiredKey` (false untuk operasi publik: jangan tempel token atau refresh saat 401).
- Body multipart membentuk `FormData` baru dengan berkas yang diklon setiap pemanggilan, sehingga objek request yang
  sama dapat dikirim ulang ("Coba lagi", PRD 4.3). Interceptor yang mengulang request (refresh token saat 401) WAJIB
  memakai `dio.fetch(retryableRequest(error.requestOptions))`, karena `FormData` yang sudah terkirim tidak dapat
  dikirim lagi.
- Semua kegagalan menjadi `ApiException`: `api` (body Error server), `network` (koneksi/timeout/galat I/O; tampilkan
  offline, jangan hapus token), `cancelled`, `invalidResponse` (respons tidak sesuai kontrak), dan `unexpected`
  (galat pemrograman/interceptor atau sertifikat ditolak; bukan offline, catat `cause`). `ui` berasal dari katalog
  galat terbangkit `errorUiFor` (sumber: `@kapdh/shared` ERROR_UI) serta `routeForStatus`/`membershipLabel`
  (sumber: `@kapdh/shared` status.ts).

## Gerbang N-13 (perubahan yang memutus klien)

`pnpm contracts:breaking` merakit kontrak kepala, mengambil kontrak rilis terakhir dari tag `contracts-v*` tertinggi
(`dist/openapi.yaml` pada commit rilis, atau dirakit dari `openapi/` tag lama), lalu menjalankan
`oasdiff breaking` (biner dari env `OASDIFF` atau `PATH`). Perubahan level ERR hanya lulus bila versi mayor
`info.version` (di bawah 1.0.0: minor) DAN `info.x-kapdh-min-app-version` naik bersama; WARN hanya peringatan.
`info.version`, `package.json` dan `pubspec.yaml` wajib sama. Sebelum tag rilis pertama gerbang lulus dengan
pemberitahuan. Uji kering tanpa oasdiff: `node scripts/check-breaking.mjs --changes-json <keluaran oasdiff json>`;
pembanding lain: `--base-ref <ref>`. Kebijakan lengkap: `docs/runbooks/ci-cd.md` bagian 3.

## Rilis SDK (ADR-001)

Selama build, kapdh-mobile memakai SDK lewat dependensi path. `lib/src/**` tidak pernah di-commit ke branch, jadi
dependensi git ke commit biasa tidak akan berisi kode SDK. Saat rilis:

1. Naikkan versi yang SAMA di `openapi/root.yaml` (`info.version`), `package.json` dan `dart/kapdh_api/pubspec.yaml`,
   catat di `CHANGELOG.md`, commit. Di CI rilis dijalankan workflow Release aksi `contracts-sdk` (docs/runbooks/ci-cd.md).
2. `pnpm contracts:release-sdk -- --dry-run`, lalu `pnpm contracts:release-sdk`. Skrip menolak sumber kontrak yang
   belum di-commit, membangkitkan ulang SDK dari HEAD, membuat commit rilis terpisah (anak HEAD; branch, index dan
   working tree tidak berubah) berisi pohon HEAD + `lib/src` terbangkit + `dist/openapi.yaml` (kontrak rilis yang
   menjadi pembanding gerbang N-13), lalu tag beranotasi `contracts-vX.Y.Z`.
3. `git push origin contracts-vX.Y.Z`. Repo Flutter hasil `git subtree split` memakai:

   ```yaml
   kapdh_api:
     git:
       url: <URL repo KAPDHAPPS>
       path: kapdh-platform/packages/contracts/dart/kapdh_api
       ref: contracts-vX.Y.Z
   ```

Perubahan kontrak yang memutus versi klien yang masih didukung harus gagal di CI (N-13).
