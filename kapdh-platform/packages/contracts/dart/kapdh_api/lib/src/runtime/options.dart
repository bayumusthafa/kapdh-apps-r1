// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

/// Kunci `RequestOptions.extra` berisi operationId kontrak setiap request SDK, untuk log dan penyimpanan
/// Idempotency-Key per operasi di interceptor aplikasi (PRD 4.3).
const String kapdhOperationIdKey = 'kapdh.operation_id';

/// Kunci `RequestOptions.extra` bernilai `false` untuk operasi tanpa bearer (`security: []`, mis. login,
/// register, refresh). Interceptor aplikasi tidak menempelkan token dan tidak mencoba refresh saat 401 pada
/// operasi ini (ARCHITECTURE §8.3).
const String kapdhAuthRequiredKey = 'kapdh.auth_required';
