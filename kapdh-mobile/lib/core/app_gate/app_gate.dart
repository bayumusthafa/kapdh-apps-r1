import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:pub_semver/pub_semver.dart';

import '../api/api_providers.dart';
import '../api/api_signals.dart';
import '../config/app_info.dart';
import '../session/repositories.dart';

/// Keputusan gerbang aplikasi sebelum sesi (PRD 4.5, 4.6 Flutter sistem).
enum GateStatus {
  /// GET /public/config sedang diperiksa (splash).
  checking,

  /// Versi didukung dan tidak maintenance.
  ok,

  /// Konfigurasi tidak dapat dimuat (offline/galat server). Aplikasi tetap berjalan; server tetap menolak mutasi
  /// dari versi lama (426) dan saat maintenance (503) di setiap request.
  unavailable,

  /// Versi aplikasi di bawah `min_app_version` platform ini: layar wajib update.
  updateRequired,

  /// Maintenance aktif: layar maintenance dengan estimasi dan kanal dukungan.
  maintenance,
}

@immutable
class AppGateState {
  const AppGateState({required this.status, this.config, this.maintenanceMessage, this.maintenanceUntil, this.checkedAt});

  const AppGateState.checking() : this(status: GateStatus.checking);

  final GateStatus status;

  /// Konfigurasi publik terakhir (tautan toko, kontak dukungan).
  final PublicConfig? config;
  final String? maintenanceMessage;
  final DateTime? maintenanceUntil;
  final DateTime? checkedAt;

  SupportContact? get support => config?.support;
  StoreLinks? get storeLinks => config?.storeLinks;

  AppGateState copyWith({GateStatus? status, String? maintenanceMessage, DateTime? maintenanceUntil}) => AppGateState(
        status: status ?? this.status,
        config: config,
        maintenanceMessage: maintenanceMessage ?? this.maintenanceMessage,
        maintenanceUntil: maintenanceUntil ?? this.maintenanceUntil,
        checkedAt: checkedAt,
      );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppGateState &&
          other.status == status &&
          other.config == config &&
          other.maintenanceMessage == maintenanceMessage &&
          other.maintenanceUntil == maintenanceUntil &&
          other.checkedAt == checkedAt;

  @override
  int get hashCode => Object.hash(status, config, maintenanceMessage, maintenanceUntil, checkedAt);
}

/// Membandingkan versi semver aplikasi dengan versi minimum platform. Versi yang tidak dapat dibaca tidak memblokir
/// (server tetap menegakkan 426 UPGRADE_REQUIRED).
bool isBelowMinimum({required String current, required String minimum}) {
  try {
    return Version.parse(current) < Version.parse(minimum);
  } on FormatException {
    return false;
  }
}

/// Keputusan murni dari konfigurasi publik.
AppGateState evaluateConfig(PublicConfig config, AppInfo info, DateTime now) {
  final minimum = switch (info.platform) {
    DevicePlatform.android => config.minAppVersion.android,
    DevicePlatform.ios => config.minAppVersion.ios,
    DevicePlatform.unknown => null,
  };
  if (minimum != null && isBelowMinimum(current: info.version, minimum: minimum)) {
    return AppGateState(status: GateStatus.updateRequired, config: config, checkedAt: now);
  }
  if (config.maintenance.active) {
    return AppGateState(
      status: GateStatus.maintenance,
      config: config,
      maintenanceMessage: config.maintenance.message,
      maintenanceUntil: config.maintenance.until,
      checkedAt: now,
    );
  }
  return AppGateState(status: GateStatus.ok, config: config, checkedAt: now);
}

final appGateProvider = NotifierProvider<AppGateController, AppGateState>(AppGateController.new);

/// Gerbang aplikasi: GET /public/config saat splash dan saat aplikasi kembali aktif, ditambah sinyal 426/503 dari
/// request mana pun (PRD 4.5).
class AppGateController extends Notifier<AppGateState> {
  static const recheckInterval = Duration(minutes: 5);

  Future<void>? _checking;

  @override
  AppGateState build() {
    final sub = ref.watch(apiSignalsProvider).stream.listen(_onSignal);
    ref.onDispose(() => unawaited(sub.cancel()));
    return const AppGateState.checking();
  }

  Future<void> check() => _checking ??= _check().whenComplete(() => _checking = null);

  /// Periksa ulang bila pemeriksaan terakhir sudah lama (saat aplikasi kembali ke latar depan).
  Future<void> recheckIfStale() {
    final last = state.checkedAt;
    final now = ref.read(clockProvider)();
    if (last != null && now.difference(last) < recheckInterval && state.status == GateStatus.ok) {
      return Future<void>.value();
    }
    return check();
  }

  Future<void> _check() async {
    final now = ref.read(clockProvider)();
    try {
      final config = await ref.read(publicRepositoryProvider).getConfig();
      state = evaluateConfig(config, ref.read(appInfoProvider), now);
    } on ApiException catch (error) {
      if (error.code == ErrorCode.maintenance) {
        state = AppGateState(
          status: GateStatus.maintenance,
          config: state.config,
          maintenanceMessage: error.error?.message,
          maintenanceUntil: error.retryAfter == null ? null : now.add(error.retryAfter!),
          checkedAt: now,
        );
      } else if (error.code == ErrorCode.upgradeRequired) {
        state = AppGateState(status: GateStatus.updateRequired, config: state.config, checkedAt: now);
      } else if (state.status == GateStatus.checking) {
        // Offline atau galat server: jangan memblokir (KTA offline tetap dapat dibuka).
        state = AppGateState(status: GateStatus.unavailable, config: state.config, checkedAt: now);
      }
    }
  }

  void _onSignal(ApiSignal signal) {
    final now = ref.read(clockProvider)();
    switch (signal) {
      case MaintenanceSignal(:final message, :final retryAfter):
        state = AppGateState(
          status: GateStatus.maintenance,
          config: state.config,
          maintenanceMessage: message ?? state.maintenanceMessage,
          maintenanceUntil: retryAfter == null ? state.maintenanceUntil : now.add(retryAfter),
          checkedAt: state.checkedAt,
        );
      case UpgradeRequiredSignal():
        state = AppGateState(status: GateStatus.updateRequired, config: state.config, checkedAt: state.checkedAt);
      case StatusStaleSignal():
        break;
    }
  }
}
