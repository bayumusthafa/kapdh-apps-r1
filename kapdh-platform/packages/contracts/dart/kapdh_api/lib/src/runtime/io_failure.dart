// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

// Platform tanpa dart:io (web): kegagalan jaringan dilaporkan dio sebagai DioExceptionType.connectionError.

/// Apakah [error] adalah galat I/O jaringan (selalu false tanpa dart:io).
bool isIoFailure(Object? error) => false;
