import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/app_services.dart';
import '../../core/realtime/realtime_client.dart';

/// Bagian klien realtime `/realtime` yang dipakai fitur chat (ARCHITECTURE §4.9): event bertipe yang sudah
/// dideduplikasi per `event_id`, keadaan koneksi untuk sinkron setelah reconnect (AC F11-3), dan emit klien yang
/// diizinkan (`typing {room_id}`, `presence.ping`). Antarmuka agar logika room dapat diuji tanpa soket.
abstract interface class ChatRealtime {
  Stream<RealtimeEvent> get events;

  ValueListenable<RealtimeConnectionState> get connection;

  void sendTyping(String roomId);

  void sendPresencePing();
}

/// Implementasi di atas [RealtimeClient] bersama (satu soket untuk notifikasi, sesi dan chat).
class RealtimeClientChatRealtime implements ChatRealtime {
  RealtimeClientChatRealtime(this._client);

  final RealtimeClient _client;

  @override
  Stream<RealtimeEvent> get events => _client.events;

  @override
  ValueListenable<RealtimeConnectionState> get connection => _client.connectionState;

  @override
  void sendTyping(String roomId) => _client.sendTyping(roomId);

  @override
  void sendPresencePing() => _client.sendPresencePing();
}

final chatRealtimeProvider = Provider<ChatRealtime>(
  (ref) => RealtimeClientChatRealtime(ref.watch(realtimeClientProvider)),
);
