import 'dart:async';

import 'package:flutter/foundation.dart';

/// Sinyal global dari respons API yang memengaruhi seluruh aplikasi, terlepas dari layar yang memanggil
/// (PRD 4.5, 5.2). Dipancarkan oleh [ErrorSignalsInterceptor], didengar gerbang aplikasi dan sesi.
sealed class ApiSignal {
  const ApiSignal();
}

/// 503 MAINTENANCE: tampilkan layar maintenance dengan estimasi dan dukungan.
@immutable
final class MaintenanceSignal extends ApiSignal {
  const MaintenanceSignal({this.message, this.retryAfter});

  final String? message;
  final Duration? retryAfter;
}

/// 426 UPGRADE_REQUIRED: versi aplikasi di bawah minimum; tampilkan layar wajib update.
final class UpgradeRequiredSignal extends ApiSignal {
  const UpgradeRequiredSignal();
}

/// MEMBERSHIP_REQUIRED atau ACCOUNT_SUSPENDED: status di klien sudah usang; muat ulang /me lalu arahkan ulang
/// (ErrorUiAction.refreshStatus / goToRestricted).
final class StatusStaleSignal extends ApiSignal {
  const StatusStaleSignal();
}

class ApiSignals {
  final StreamController<ApiSignal> _controller = StreamController<ApiSignal>.broadcast();

  Stream<ApiSignal> get stream => _controller.stream;

  void emit(ApiSignal signal) {
    if (!_controller.isClosed) _controller.add(signal);
  }

  Future<void> dispose() => _controller.close();
}
