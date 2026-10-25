// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

// Platform dengan dart:io (Android, iOS, desktop, VM uji).

import 'dart:io';

/// Apakah [error] adalah galat I/O jaringan (SocketException, HttpException, HandshakeException/TlsException).
bool isIoFailure(Object? error) => error is IOException;
