import 'dart:async';
import 'dart:collection';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../api/refresh_coordinator.dart';
import '../config/api_config.dart';
import 'realtime_socket.dart';

/// Keadaan koneksi realtime untuk indikator UI (mis. "Menyambungkan…" di chat).
enum RealtimeConnectionState { disconnected, connecting, connected, waitingRetry }

/// Klien Socket.IO namespace `/realtime` (ARCHITECTURE §4.9, PRD 5.2, N-02).
///
/// - Token handshake diambil dari [RefreshCoordinator] yang sama dengan HTTP dan push, sehingga tidak ada refresh
///   paralel dengan token lama (PRD 5.2).
/// - Handshake ditolak UNAUTHENTICATED: koordinator me-refresh sekali (atau memakai token yang baru diperbarui);
///   bila sesi tidak berlaku lagi, klien berhenti dan sesi keluar lewat koordinator.
/// - Putus koneksi: sambung ulang dengan backoff eksponensial ber-jitter (1 detik sampai 30 detik).
/// - Amplop `{v, event_id, type, entity_id, ts, payload}` dibaca dengan `RealtimeEvent.fromJson`; event ganda setelah
///   reconnect (event_id sama) dibuang. Event bukan sumber kebenaran: layar memuat ulang lewat HTTP bila ragu.
class RealtimeClient {
  RealtimeClient({
    required ApiConfig config,
    required RefreshCoordinator coordinator,
    RealtimeSocketFactory socketFactory = SocketIoRealtimeSocket.create,
    this.initialBackoff = const Duration(seconds: 1),
    this.maxBackoff = const Duration(seconds: 30),
    math.Random? random,
  }) : _config = config,
       _coordinator = coordinator,
       _socketFactory = socketFactory,
       _random = random ?? math.Random();

  /// Jumlah event_id terakhir yang diingat untuk deduplikasi.
  static const dedupWindow = 512;

  final ApiConfig _config;
  final RefreshCoordinator _coordinator;
  final RealtimeSocketFactory _socketFactory;
  final math.Random _random;
  final Duration initialBackoff;
  final Duration maxBackoff;

  final StreamController<RealtimeEvent> _events = StreamController<RealtimeEvent>.broadcast();
  final ValueNotifier<RealtimeConnectionState> _state = ValueNotifier(RealtimeConnectionState.disconnected);
  final LinkedHashSet<String> _seen = LinkedHashSet<String>();

  RealtimeSocket? _socket;
  _Listener? _listener;
  Timer? _retryTimer;
  bool _desired = false;
  int _attempt = 0;
  String? _handshakeToken;
  bool _disposed = false;

  /// Semua event bertipe dari server.
  Stream<RealtimeEvent> get events => _events.stream;

  /// Event satu jenis, mis. `client.on<MessageCreatedEvent>()`.
  Stream<T> on<T extends RealtimeEvent>() => _events.stream.where((event) => event is T).cast<T>();

  ValueListenable<RealtimeConnectionState> get connectionState => _state;

  /// Jumlah percobaan sambung ulang berturut-turut sejak koneksi terakhir berhasil (diagnostik dan uji).
  int get attempt => _attempt;

  /// Mulai (atau lanjutkan) koneksi; dipanggil saat sesi aktif.
  void start() {
    if (_disposed) return;
    _desired = true;
    if (_socket == null && _retryTimer == null) unawaited(_connect());
  }

  /// Putuskan dan berhenti menyambung ulang; dipanggil saat logout atau status dibatasi.
  void stop() {
    _desired = false;
    _retryTimer?.cancel();
    _retryTimer = null;
    _attempt = 0;
    _closeSocket();
    _seen.clear();
    _state.value = RealtimeConnectionState.disconnected;
  }

  /// Indikator mengetik (klien hanya boleh mengirim `typing {room_id}` dan `presence.ping`).
  void sendTyping(String roomId) => _socket?.emit('typing', <String, Object?>{'room_id': roomId});

  void sendPresencePing() => _socket?.emit('presence.ping', const <String, Object?>{});

  Future<void> dispose() async {
    stop();
    _disposed = true;
    await _events.close();
    _state.dispose();
  }

  Future<void> _connect() async {
    if (!_desired || _disposed) return;
    _closeSocket();
    _state.value = RealtimeConnectionState.connecting;
    String? token;
    try {
      token = await _coordinator.validAccessToken();
    } on ApiException {
      // Jaringan/server bermasalah saat refresh: coba lagi nanti; token tetap tersimpan.
      _scheduleRetry();
      return;
    }
    if (!_desired || _disposed) return;
    if (token == null) {
      // Tidak ada sesi: berhenti tanpa mencoba lagi.
      stop();
      return;
    }
    _handshakeToken = token;
    final listener = _Listener(this);
    _listener = listener;
    final socket = _socketFactory(
      uri: _config.realtimeUri,
      path: _config.realtimePath,
      auth: (callback) => callback(<String, Object?>{'token': _handshakeToken}),
      listener: listener,
    );
    _socket = socket;
    socket.connect();
  }

  void _closeSocket() {
    _listener?.active = false;
    _listener = null;
    final socket = _socket;
    _socket = null;
    socket?.dispose();
  }

  /// Penundaan percobaan ke-[attempt] (mulai 0): eksponensial dengan jitter 50 sampai 100 %, dibatasi [maxBackoff].
  Duration backoffFor(int attempt) {
    final base = initialBackoff.inMilliseconds * math.pow(2, math.min(attempt, 16));
    final capped = math.min(base.toDouble(), maxBackoff.inMilliseconds.toDouble());
    final jitter = 0.5 + _random.nextDouble() * 0.5;
    return Duration(milliseconds: (capped * jitter).round());
  }

  void _scheduleRetry({Duration? delay}) {
    if (!_desired || _disposed) return;
    _closeSocket();
    _retryTimer?.cancel();
    final wait = delay ?? backoffFor(_attempt);
    _attempt++;
    _state.value = RealtimeConnectionState.waitingRetry;
    _retryTimer = Timer(wait, () {
      _retryTimer = null;
      unawaited(_connect());
    });
  }

  void _handleConnected() {
    _attempt = 0;
    _state.value = RealtimeConnectionState.connected;
  }

  void _handleDisconnected(Object? reason) {
    if (!_desired) return;
    // Server memutus (logout semua perangkat, suspend, kehilangan izin; AC F02-6, F11-6): sambung ulang dengan
    // backoff; handshake baru divalidasi ulang server sehingga sesi yang dicabut berakhir di UNAUTHENTICATED.
    _scheduleRetry();
  }

  Future<void> _handleConnectError(Object? error) async {
    if (!_desired) return;
    if (!isUnauthenticated(error)) {
      _scheduleRetry();
      return;
    }
    _closeSocket();
    final String? fresh;
    try {
      fresh = await _coordinator.refreshAfterRejection(_handshakeToken);
    } on ApiException {
      _scheduleRetry();
      return;
    }
    if (fresh == null) {
      // Sesi tidak berlaku lagi; koordinator sudah menghapus token dan sesi aplikasi keluar.
      stop();
      return;
    }
    // Token baru tersedia: coba lagi segera, tetap dihitung agar penolakan berulang tidak berputar cepat.
    _scheduleRetry(delay: _attempt == 0 ? Duration.zero : backoffFor(_attempt));
  }

  void _handleEvent(String name, Object? data) {
    if (data is! Map) return;
    final RealtimeEvent event;
    try {
      event = RealtimeEvent.fromJson(Map<String, Object?>.from(data));
    } on FormatException catch (error) {
      debugPrint('realtime: event "$name" diabaikan karena tidak sesuai kontrak: ${error.message}');
      return;
    }
    if (!_seen.add(event.eventId)) return;
    if (_seen.length > dedupWindow) _seen.remove(_seen.first);
    if (!_events.isClosed) _events.add(event);
  }

  /// Penolakan handshake karena autentikasi: `{message: "UNAUTHENTICATED"}`, `{data: {code: "UNAUTHENTICATED"}}`
  /// atau teks yang memuat kode tersebut.
  @visibleForTesting
  static bool isUnauthenticated(Object? error) {
    const code = 'UNAUTHENTICATED';
    if (error is Map) {
      final message = error['message'];
      final data = error['data'];
      if (message is String && message.contains(code)) return true;
      if (data is Map && data['code'] == code) return true;
      return false;
    }
    return error is String && error.contains(code);
  }
}

class _Listener implements RealtimeSocketListener {
  _Listener(this._client);

  final RealtimeClient _client;

  /// Listener soket lama dinonaktifkan agar kejadian terlambat tidak memengaruhi soket baru.
  bool active = true;

  @override
  void onConnected() {
    if (active) _client._handleConnected();
  }

  @override
  void onDisconnected(Object? reason) {
    if (active) _client._handleDisconnected(reason);
  }

  @override
  void onConnectError(Object? error) {
    if (active) unawaited(_client._handleConnectError(error));
  }

  @override
  void onEvent(String event, Object? data) {
    if (active) _client._handleEvent(event, data);
  }
}
