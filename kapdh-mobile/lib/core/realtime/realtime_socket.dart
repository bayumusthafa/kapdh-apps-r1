import 'package:socket_io_client/socket_io_client.dart' as io;

/// Pengamat kejadian satu koneksi soket.
abstract interface class RealtimeSocketListener {
  void onConnected();

  /// [reason] dari Socket.IO, mis. `io server disconnect`, `transport close`.
  void onDisconnected(Object? reason);

  /// Galat handshake/middleware; untuk auth biasanya `{message: "UNAUTHENTICATED"}`.
  void onConnectError(Object? error);

  void onEvent(String event, Object? data);
}

/// Pemberi data auth handshake: memanggil [callback] dengan `{token: <access JWT>}` (ARCHITECTURE §4.9).
typedef RealtimeAuthProvider = void Function(void Function(Map<String, Object?> auth) callback);

/// Satu koneksi soket ke namespace `/realtime`. Abstraksi agar klien realtime dapat diuji tanpa jaringan.
abstract interface class RealtimeSocket {
  void connect();
  void emit(String event, Object? data);

  /// Memutus dan melepas sumber daya; soket tidak dipakai lagi setelahnya.
  void dispose();
}

typedef RealtimeSocketFactory =
    RealtimeSocket Function({
      required Uri uri,
      required String path,
      required RealtimeAuthProvider auth,
      required RealtimeSocketListener listener,
    });

/// Implementasi socket_io_client (transport websocket). Reconnect bawaan Socket.IO dimatikan: klien realtime
/// mengatur backoff sendiri dan membuat soket baru di setiap percobaan agar token selalu dari koordinator refresh.
class SocketIoRealtimeSocket implements RealtimeSocket {
  SocketIoRealtimeSocket._(this._socket);

  static RealtimeSocket create({
    required Uri uri,
    required String path,
    required RealtimeAuthProvider auth,
    required RealtimeSocketListener listener,
  }) {
    final socket = io.io(
      uri.toString(),
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setPath(path)
          .disableAutoConnect()
          .disableReconnection()
          .enableForceNew()
          .setAuthFn((callback) => auth((data) => callback(data)))
          .build(),
    );
    socket
      ..onConnect((_) => listener.onConnected())
      ..onDisconnect(listener.onDisconnected)
      ..onConnectError(listener.onConnectError)
      ..onAny((event, data) => listener.onEvent(event, data));
    return SocketIoRealtimeSocket._(socket);
  }

  final io.Socket _socket;

  @override
  void connect() => _socket.connect();

  @override
  void emit(String event, Object? data) => _socket.emit(event, data);

  @override
  void dispose() {
    _socket.clearListeners();
    _socket.dispose();
  }
}
