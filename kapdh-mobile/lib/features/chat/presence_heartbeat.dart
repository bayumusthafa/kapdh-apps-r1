import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../core/realtime/realtime_client.dart';
import 'chat_realtime.dart';

/// Interval `presence.ping`: lebih sering daripada `ttl_seconds` event `presence` (contoh kontrak 60 detik).
const Duration presencePingInterval = Duration(seconds: 25);

/// Mengirim `presence.ping` berkala selama layar jejaring/chat terpasang, soket tersambung dan aplikasi aktif
/// (events/README.md "Emit klien"). Presence hanya sementara dan bukan bukti pesan dibaca (PRD 3.11). Dibuat dan
/// dibuang oleh `State` layar sehingga tidak ada penghitung waktu yang tertinggal.
class PresenceHeartbeat {
  PresenceHeartbeat(this._realtime, {this.interval = presencePingInterval});

  final ChatRealtime _realtime;
  final Duration interval;
  Timer? _timer;
  AppLifecycleListener? _lifecycle;
  bool _foreground = true;

  void start() {
    _realtime.connection.addListener(_onConnection);
    _lifecycle = AppLifecycleListener(
      onStateChange: (state) {
        _foreground = state == AppLifecycleState.resumed;
        _reschedule();
      },
    );
    _reschedule();
  }

  void _onConnection() => _reschedule();

  void _reschedule() {
    _timer?.cancel();
    _timer = null;
    if (!_foreground || _realtime.connection.value != RealtimeConnectionState.connected) return;
    _realtime.sendPresencePing();
    _timer = Timer.periodic(interval, (_) => _realtime.sendPresencePing());
  }

  void dispose() {
    _timer?.cancel();
    _timer = null;
    _lifecycle?.dispose();
    _lifecycle = null;
    _realtime.connection.removeListener(_onConnection);
  }
}
