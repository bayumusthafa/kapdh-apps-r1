import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/app_services.dart';
import '../../core/push/push_platform.dart';
import '../../core/session/session_controller.dart';

/// Keadaan push perangkat ini untuk layar preferensi (F-13, AC F13-2).
@immutable
class PushPermissionState {
  const PushPermissionState({this.available, this.permission, this.busy = false});

  /// Null: belum diperiksa. False: build/perangkat tanpa push (konfigurasi Firebase tidak ada); kotak masuk tetap
  /// menjadi riwayat resmi.
  final bool? available;

  /// Izin terakhir yang diketahui dari [PushService]; null bila belum pernah diminta di peluncuran ini.
  final PushPermission? permission;
  final bool busy;

  bool get granted => permission == PushPermission.granted || permission == PushPermission.provisional;

  PushPermissionState copyWith({bool? available, PushPermission? permission, bool? busy}) => PushPermissionState(
    available: available ?? this.available,
    permission: permission ?? this.permission,
    busy: busy ?? this.busy,
  );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PushPermissionState &&
          other.available == available &&
          other.permission == permission &&
          other.busy == busy;

  @override
  int get hashCode => Object.hash(available, permission, busy);
}

final pushPermissionProvider = NotifierProvider<PushPermissionController, PushPermissionState>(
  PushPermissionController.new,
);

/// Alur izin push memakai PushService inti (ARCHITECTURE §8.3): izin diminta setelah login, dan bila diberikan
/// token FCM didaftarkan untuk keluarga sesi ini (PUT /devices). Penolakan izin tidak menghalangi fitur apa pun;
/// kotak masuk tetap menerima seluruh notifikasi (AC F13-2). Pencabutan token saat keluar/berganti akun ditangani
/// PushService lewat sessionServicesProvider (AC F13-5).
class PushPermissionController extends Notifier<PushPermissionState> {
  @override
  PushPermissionState build() => const PushPermissionState();

  /// Membaca keadaan terkini tanpa memunculkan dialog izin OS.
  Future<void> check() async {
    final push = ref.read(pushServiceProvider);
    final available = await push.start();
    if (!ref.mounted) return;
    state = PushPermissionState(available: available, permission: push.permission);
  }

  /// Meminta izin OS lalu mendaftarkan token perangkat untuk akun yang sedang masuk. Pada iOS/Android 13+, izin yang
  /// sudah ditolak tidak memunculkan dialog lagi; layar menjelaskan cara mengaktifkannya dari pengaturan perangkat.
  Future<void> request() async {
    final userId = ref.read(sessionProvider).userId;
    if (userId == null || state.busy) return;
    state = state.copyWith(busy: true);
    final push = ref.read(pushServiceProvider);
    try {
      await push.onSignedIn(userId);
    } finally {
      if (ref.mounted) {
        state = PushPermissionState(available: push.available, permission: push.permission);
      }
    }
  }
}
