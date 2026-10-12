import 'dart:async';

import 'package:kapdh_api/kapdh_api.dart';

import '../config/server_clock.dart';
import '../storage/token_store.dart';

/// Pemanggil POST /auth/refresh tanpa interceptor auth (menghindari rekursi).
typedef SessionRefresher = Future<TokenPair> Function(String refreshToken);

/// Koordinator refresh token tunggal untuk satu perangkat (PRD 5.2 "satu proses", AC F02-3, ARCHITECTURE §8.3).
///
/// Dipakai bersama oleh interceptor Dio, klien Socket.IO dan layanan push. Aturan:
/// - Single-flight: semua pemanggil yang menemukan refresh sedang berjalan ikut menunggu hasil yang sama, sehingga
///   refresh token lama tidak pernah dikirim dua kali (server memperlakukannya sebagai reuse dan mencabut keluarga
///   sesi).
/// - Bandingkan token yang ditolak dengan token tersimpan: bila sudah berbeda (pihak lain baru saja me-refresh),
///   langsung pakai token terbaru tanpa refresh lagi.
/// - Token hanya dihapus bila /auth/refresh menjawab UNAUTHENTICATED. Jaringan putus, timeout, 5xx, MAINTENANCE
///   atau respons tak sesuai tidak pernah membuat pengguna keluar; galatnya diteruskan ke pemanggil.
///
/// Refresh proaktif membandingkan batas berlaku token MENURUT JAM PERANGKAT ([StoredTokens.deviceExpiresAt], dihitung
/// dari jam server saat token diterima) dengan jam perangkat, bukan stempel absolut server dengan jam perangkat:
/// perangkat yang jamnya melenceng tidak me-refresh pada setiap request.
class RefreshCoordinator {
  RefreshCoordinator({required TokenStore store, required SessionRefresher refresher, ServerClock? serverClock})
    : _store = store,
      _refresher = refresher,
      _serverClock = serverClock ?? ServerClock();

  final TokenStore _store;
  final SessionRefresher _refresher;
  final ServerClock _serverClock;
  final StreamController<void> _invalidated = StreamController<void>.broadcast(sync: true);
  Future<String?>? _inFlight;
  int _refreshCount = 0;

  /// Dipancarkan setelah token dihapus karena server menolak refresh (sesi dicabut, kedaluwarsa, reuse).
  Stream<void> get invalidated => _invalidated.stream;

  /// Jumlah POST /auth/refresh yang benar-benar dikirim (diagnostik dan uji).
  int get refreshCount => _refreshCount;

  /// Access token tersimpan tanpa refresh; null bila belum login.
  Future<String?> currentAccessToken() async => (await _store.read())?.accessToken;

  /// Access token yang masih berlaku minimal [leeway]; me-refresh lebih dulu bila hampir habis.
  ///
  /// Untuk handshake Socket.IO dan pekerjaan push. Melempar [ApiException] bila refresh gagal karena jaringan
  /// atau server (token tetap disimpan); mengembalikan null bila tidak ada sesi.
  Future<String?> validAccessToken({Duration leeway = const Duration(seconds: 30)}) async {
    await _store.load();
    final inFlight = _inFlight;
    if (inFlight != null) return inFlight;
    final current = _store.cached;
    if (current == null) return null;
    final deviceExpiry = current.deviceExpiresAt;
    // Tanpa perkiraan yang dapat dipercaya, token dipakai apa adanya; server menilai dan 401 memicu refresh.
    if (deviceExpiry == null || deviceExpiry.isAfter(_serverClock.deviceNow().add(leeway))) {
      return current.accessToken;
    }
    return _startRefresh(current);
  }

  /// Dipanggil setelah server menolak [rejectedToken] dengan 401. Mengembalikan access token yang harus dipakai
  /// untuk mengulang request, atau null bila sesi tidak lagi berlaku (token sudah dihapus).
  Future<String?> refreshAfterRejection(String? rejectedToken) async {
    await _store.load();
    // Sejak titik ini sampai _inFlight terisi tidak ada await: keputusan memakai cache token yang terbaru.
    final inFlight = _inFlight;
    if (inFlight != null) return inFlight;
    final current = _store.cached;
    if (current == null) return null;
    if (rejectedToken != null && current.accessToken != rejectedToken) return current.accessToken;
    return _startRefresh(current);
  }

  Future<String?> _startRefresh(StoredTokens current) {
    final future = _refresh(current);
    _inFlight = future;
    // Dilepas setelah token baru tersimpan di cache, sehingga pemanggil berikutnya membandingkan token terbaru.
    future.then<void>((_) {}, onError: (Object _) {}).whenComplete(() {
      if (identical(_inFlight, future)) _inFlight = null;
    });
    return future;
  }

  Future<String?> _refresh(StoredTokens current) async {
    final refreshToken = current.refreshToken;
    if (refreshToken == null) {
      // Sesi tanpa refresh token tidak dapat diperpanjang; sama artinya dengan ditolak server.
      await _invalidate();
      return null;
    }
    _refreshCount++;
    final TokenPair pair;
    try {
      pair = await _refresher(refreshToken);
    } on ApiException catch (error) {
      if (error.kind == ApiFailureKind.api && error.code == ErrorCode.unauthenticated) {
        // Satu-satunya kondisi token dihapus (ARCHITECTURE §8.3). Bila pengguna sudah login ulang selama refresh
        // berjalan, sesi baru tidak ikut dihapus dan dipakai untuk mengulang request.
        final latest = _store.cached;
        if (latest != null && latest.refreshToken != refreshToken) return latest.accessToken;
        await _invalidate();
        return null;
      }
      rethrow;
    }
    // Header `Date` respons refresh sudah dicatat ServerTimeInterceptor sebelum future ini selesai.
    final next = StoredTokens.received(pair, _serverClock);
    await _store.save(next);
    return next.accessToken;
  }

  Future<void> _invalidate() async {
    await _store.clear();
    _invalidated.add(null);
  }

  Future<void> dispose() => _invalidated.close();
}
