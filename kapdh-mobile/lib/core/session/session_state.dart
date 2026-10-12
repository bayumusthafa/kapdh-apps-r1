import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

/// Fase sesi aplikasi (ARCHITECTURE §8.3).
enum SessionPhase {
  /// Belum diketahui: bootstrap berjalan, atau gagal tanpa snapshot (lihat [SessionState.issue]).
  unknown,

  /// Tidak ada sesi; hanya layar publik, auth dan legal.
  anonymous,

  /// Sesi aktif dengan /me terbaru dari server.
  authenticated,

  /// Sesi tetap (token tidak dihapus) tetapi /me tidak dapat dimuat; memakai snapshot /me terakhir. Bukan bukti
  /// status saat ini; layar menampilkan keadaan offline.
  offlineLastKnown,
}

/// Masalah saat memuat sesi; ditampilkan splash sebagai "Tanpa koneksi" atau "Coba lagi" (PRD 4.6 Flutter sistem).
enum SessionIssue { none, offline, serverError }

/// Keadaan sesi yang dibaca router (PRD 2.2). Kelas ini murni (tanpa Flutter widget) agar matriks redirect diuji
/// sebagai fungsi murni.
@immutable
class SessionState {
  const SessionState._({
    required this.phase,
    this.me,
    this.syncedAt,
    this.challenge,
    this.resetToken,
    this.issue = SessionIssue.none,
  });

  const SessionState.unknown({SessionIssue issue = SessionIssue.none}) : this._(phase: SessionPhase.unknown, issue: issue);

  /// [challenge]: challenge OTP yang sedang berjalan (signup atau password_reset). [resetToken]: token reset sandi
  /// sekali pakai dari OTP pemulihan; hanya di memori, tidak pernah disimpan.
  const SessionState.anonymous({OtpChallenge? challenge, String? resetToken})
      : this._(phase: SessionPhase.anonymous, challenge: challenge, resetToken: resetToken);

  const SessionState.authenticated(Me me, {required DateTime syncedAt})
      : this._(phase: SessionPhase.authenticated, me: me, syncedAt: syncedAt);

  const SessionState.offlineLastKnown(Me me, {required DateTime syncedAt, SessionIssue issue = SessionIssue.offline})
      : this._(phase: SessionPhase.offlineLastKnown, me: me, syncedAt: syncedAt, issue: issue);

  final SessionPhase phase;

  /// Profil dan effective_status dari server (GET /me). Klien tidak menghitung status sendiri (PRD 2.2).
  final Me? me;

  /// Waktu /me terakhir berhasil dimuat.
  final DateTime? syncedAt;

  final OtpChallenge? challenge;
  final String? resetToken;
  final SessionIssue issue;

  bool get hasSession => phase == SessionPhase.authenticated || phase == SessionPhase.offlineLastKnown;

  bool get isOffline => phase == SessionPhase.offlineLastKnown;

  EffectiveStatus? get effectiveStatus => hasSession ? me?.effectiveStatus : null;

  String? get userId => hasSession ? me?.userId : null;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SessionState &&
          other.phase == phase &&
          other.me == me &&
          other.syncedAt == syncedAt &&
          other.challenge == challenge &&
          other.resetToken == resetToken &&
          other.issue == issue;

  @override
  int get hashCode => Object.hash(phase, me, syncedAt, challenge, resetToken, issue);

  @override
  String toString() => 'SessionState(${phase.name}, status: ${effectiveStatus?.value}, issue: ${issue.name}, '
      'challenge: ${challenge?.purpose.value}, reset: ${resetToken == null ? 'tidak' : 'ada'})';
}
