// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

/// Salinan [options] yang aman dikirim ulang oleh interceptor aplikasi, mis. setelah refresh token saat 401
/// (ARCHITECTURE §8.3) atau "Coba lagi" (PRD 4.3). Body [FormData] diklon karena dio memfinalisasi
/// FormData/MultipartFile setelah terkirim; mengirim ulang objek yang sama gagal dengan
/// "FormData has already been finalized". Pakai: `dio.fetch<Object?>(retryableRequest(error.requestOptions))`.
RequestOptions retryableRequest(RequestOptions options) {
  final data = options.data;
  return data is FormData ? options.copyWith(data: data.clone()) : options;
}
