// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

// Rute awal dan label status anggota (PRD 2.2, 4.5) dari packages/shared/src/status.ts.

import 'models.dart';

/// Rute awal aplikasi anggota beserta path go_router (ARCHITECTURE §8.4). Server tetap menegakkan izin.
enum MemberRoute {
  verifyOtp('verify_otp', '/register/otp'),
  onboardingPayment('onboarding_payment', '/onboarding/fees'),
  home('home', '/home'),
  renewal('renewal', '/renewal'),
  restricted('restricted', '/restricted'),
  deletionStatus('deletion_status', '/deletion-status');

  const MemberRoute(this.value, this.path);

  /// Nama rute di katalog @kapdh/shared.
  final String value;

  /// Path go_router di aplikasi Flutter.
  final String path;
}

/// Rute awal untuk effective_status dari GET /me (PRD 2.2). Mengembalikan `null` untuk status yang belum dikenal versi aplikasi ini; aplikasi tidak menebak akses dan meminta pembaruan aplikasi.
MemberRoute? routeForStatus(EffectiveStatus status) => switch (status) {
      EffectiveStatus.pendingOtp => MemberRoute.verifyOtp,
      EffectiveStatus.unverified => MemberRoute.onboardingPayment,
      EffectiveStatus.verified => MemberRoute.home,
      EffectiveStatus.expiring => MemberRoute.home,
      EffectiveStatus.expired => MemberRoute.renewal,
      EffectiveStatus.suspended => MemberRoute.restricted,
      EffectiveStatus.disabled => MemberRoute.deletionStatus,
      EffectiveStatus.deletionPending => MemberRoute.deletionStatus,
      EffectiveStatus.unknown => null,
    };

/// Label status yang selalu ditampilkan bersama warna/ikon (PRD 4.5: status tidak dibedakan dengan warna saja).
String membershipLabel(EffectiveStatus status) => switch (status) {
      EffectiveStatus.pendingOtp => 'Menunggu Verifikasi Email',
      EffectiveStatus.unverified => 'KTA Tidak Aktif',
      EffectiveStatus.verified => 'KTA Aktif',
      EffectiveStatus.expiring => 'Segera Berakhir',
      EffectiveStatus.expired => 'KTA Kedaluwarsa',
      EffectiveStatus.suspended => 'Dibatasi',
      EffectiveStatus.disabled => 'Nonaktif',
      EffectiveStatus.deletionPending => 'Penghapusan Diproses',
      EffectiveStatus.unknown => 'Status Tidak Dikenal',
    };
