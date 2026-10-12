/// Klien API KAPDH Apps yang dibangkitkan dari kontrak OpenAPI (PRD 5.2, N-13).
///
/// Isi `src/` dibangkitkan oleh `pnpm contracts:gen` di kapdh-platform; jangan disunting.
/// Pemakaian di aplikasi:
///
/// ```dart
/// final api = KapdhApi(dio); // dio milik aplikasi dengan baseUrl .../api/v1 dan interceptor auth
/// try {
///   final me = await api.me.getMe();
///   final route = routeForStatus(me.effectiveStatus);
/// } on ApiException catch (e) {
///   switch (e.ui.action) { /* perilaku UI seragam dari katalog galat */ }
/// }
///
/// // Interceptor refresh 401: kirim ulang dengan body multipart yang diklon.
/// // handler.resolve(await dio.fetch<Object?>(retryableRequest(error.requestOptions)));
///
/// // Event Socket.IO /realtime: payload bertipe per jenis; jenis baru diabaikan.
/// switch (RealtimeEvent.fromJson(data)) {
///   case SessionRevokedEvent(): /* keluar */
///   case UnknownRealtimeEvent(): break;
///   case final other: /* tangani jenis lain */
/// }
/// ```
library;

export 'src/generated.dart';
