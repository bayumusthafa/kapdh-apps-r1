import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/config/server_clock.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';

/// Batas percobaan OTP (PRD 2.5).
const int otpMaxAttempts = 5;

/// Masa berlaku kode OTP (PRD 2.5: berlaku 10 menit).
const Duration otpValidity = Duration(minutes: 10);

/// Jeda minimum kirim ulang (PRD 2.5: kirim ulang paling cepat 60 detik).
const Duration otpResendCooldown = Duration(seconds: 60);

/// Sisa percobaan dari pesan galat server, mis. field_errors.code "Kode salah. Sisa percobaan 3." (AC F01-3).
int? attemptsLeftFrom(ApiException error) {
  final pattern = RegExp(r'[Ss]isa percobaan\s*:?\s*(\d+)');
  final candidates = [...?error.fieldErrors['code'], error.message];
  for (final text in candidates) {
    final match = pattern.firstMatch(text);
    if (match != null) return int.parse(match.group(1)!);
  }
  return null;
}

/// Keadaan satu challenge OTP di layar (PRD 2.5, AC F01-3), dipakai layar OTP aktivasi dan pemulihan.
///
/// Waktu dinilai dengan jam server (header `Date`), bukan jam perangkat: perangkat yang jamnya maju (mis. zona waktu
/// disetel UTC) tidak boleh menganggap setiap challenge baru sudah kedaluwarsa (PRD 2.1, AC F01-2). Saat challenge
/// pertama terlihat dicatat menurut jam perangkat; challenge diterbitkan paling lambat saat itu, sehingga kirim ulang
/// pasti tersedia setelah [otpResendCooldown] dan kode pasti kedaluwarsa setelah [otpValidity] sejak titik ini,
/// berapa pun selisih jam perangkat terhadap server.
class OtpChallengeTracker {
  OtpChallengeTracker(this._clock);

  final ServerClock _clock;
  String? _challengeId;
  DateTime? _seenAt;

  /// Batas RATE_LIMITED kirim ulang menurut jam perangkat (dari retry_after_seconds yang relatif).
  DateTime? _rateLimitedUntil;

  /// Sisa percobaan terakhir yang diketahui dari server.
  int attemptsLeft = otpMaxAttempts;

  /// Batas percobaan challenge ini (`max_attempts`, bawaan 5).
  int maxAttempts = otpMaxAttempts;

  /// Server menyatakan kode tidak berlaku (OTP_EXPIRED pada verifikasi) atau percobaan habis.
  bool expired = false;

  /// Challenge tidak dapat diperbarui lagi (kirim ulang/status menjawab OTP_EXPIRED): alur harus dimulai ulang.
  bool dead = false;

  String? get challengeId => _challengeId;

  /// Menyelaraskan dengan [challenge]; true bila challenge ini baru bagi layar (keadaan percobaan diatur ulang).
  bool sync(OtpChallenge challenge) {
    if (challenge.challengeId == _challengeId) return false;
    _challengeId = challenge.challengeId;
    _seenAt = _clock.deviceNow();
    maxAttempts = challenge.maxAttempts ?? otpMaxAttempts;
    attemptsLeft = challenge.attemptsLeft;
    expired = challenge.attemptsLeft <= 0;
    dead = false;
    return true;
  }

  Duration _sinceSeen() {
    final seen = _seenAt;
    return seen == null ? Duration.zero : _clock.deviceNow().difference(seen);
  }

  /// Sisa cooldown kirim ulang: `resend_available_at` menurut jam server, dibatasi cooldown PRD sejak challenge
  /// terlihat (jam perangkat yang tertinggal tidak mengunci tombol lebih lama), ditambah RATE_LIMITED terakhir.
  Duration resendWait(OtpChallenge challenge) {
    var wait = challenge.resendAvailableAt.difference(_clock.now());
    final bound = otpResendCooldown - _sinceSeen();
    if (wait > bound) wait = bound;
    final limited = _rateLimitedUntil;
    if (limited != null) {
      final limitedLeft = limited.difference(_clock.deviceNow());
      if (limitedLeft > wait) wait = limitedLeft;
    }
    return wait.isNegative ? Duration.zero : wait;
  }

  /// Kode dianggap kedaluwarsa bila server sudah menyatakannya (OTP_EXPIRED, percobaan habis), bila jam server
  /// diketahui dan `expires_at` terlewati, atau bila [otpValidity] sudah lewat sejak challenge terlihat. Selama jam
  /// server belum diketahui, keputusan lain diserahkan ke server (kotak dan tombol tetap aktif).
  bool codeExpired(OtpChallenge challenge) {
    if (expired) return true;
    if (_sinceSeen() >= otpValidity) return true;
    return _clock.isSynced && !_clock.now().isBefore(challenge.expiresAt);
  }

  /// Kirim ulang ditolak RATE_LIMITED: tombol terkunci selama [wait].
  void rateLimited(Duration wait) => _rateLimitedUntil = _clock.deviceNow().add(wait);

  /// Kirim ulang berhasil: batas sebelumnya tidak berlaku lagi.
  void clearRateLimit() => _rateLimitedUntil = null;

  /// Kode salah (400 VALIDATION_ERROR): sisa percobaan dari server, atau dikurangi satu bila pesan tidak memuatnya.
  void wrongCode(ApiException error) {
    final left = attemptsLeftFrom(error) ?? math.max(0, attemptsLeft - 1);
    attemptsLeft = left;
    if (left <= 0) expired = true;
  }
}

/// Isi layar OTP (prototipe layar 1): judul, keterangan email tujuan dan masa berlaku, enam kotak (ketik, tempel,
/// isi otomatis), "Sisa percobaan n dari 5" dan baris "Tidak menerima kode?" dengan hitung mundur kirim ulang.
class OtpEntrySection extends StatelessWidget {
  const OtpEntrySection({
    super.key,
    required this.controller,
    required this.description,
    required this.attemptsLeft,
    required this.maxAttempts,
    required this.expired,
    required this.enabled,
    required this.resendWait,
    required this.resending,
    required this.onResend,
    this.title = 'Masukkan kode verifikasi',
    this.codeError,
    this.onChanged,
    this.onCompleted,
  });

  final TextEditingController controller;
  final String title;

  /// Keterangan di bawah judul (email tujuan, masa berlaku).
  final InlineSpan description;
  final int attemptsLeft;
  final int maxAttempts;
  final bool expired;

  /// Kotak dapat diisi (tidak sedang memeriksa dan kode masih berlaku).
  final bool enabled;
  final Duration resendWait;
  final bool resending;

  /// Null bila challenge tidak dapat diperbarui lagi.
  final VoidCallback? onResend;

  /// Galat yang menyangkut kode itu sendiri (salah, kedaluwarsa); kotak menjadi merah.
  final String? codeError;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onCompleted;

  @override
  Widget build(BuildContext context) {
    final waiting = resendWait > Duration.zero;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: Text(title, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w600, height: 1.25)),
        ),
        const SizedBox(height: KapdhSpace.s2),
        Text.rich(
          description,
          style: const TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhColors.textMuted),
        ),
        const SizedBox(height: KapdhSpace.s5),
        const ExcludeSemantics(
          child: Text(
            'Kode OTP',
            style: TextStyle(fontSize: KapdhFontSize.label, fontWeight: FontWeight.w500),
          ),
        ),
        const SizedBox(height: 10),
        OtpBoxes(
          controller: controller,
          autofocus: true,
          enabled: enabled,
          errorText: codeError,
          onChanged: onChanged,
          onCompleted: onCompleted,
        ),
        const SizedBox(height: 10),
        // Diumumkan pembaca layar saat berubah (sisa percobaan setelah kode salah, kode kedaluwarsa; N-11).
        Semantics(
          liveRegion: true,
          container: true,
          child: Text(
            expired ? 'Kode tidak berlaku lagi. Minta kode baru.' : 'Sisa percobaan: $attemptsLeft dari $maxAttempts',
            style: TextStyle(
              fontSize: KapdhFontSize.caption,
              color: expired ? KapdhColors.danger : KapdhColors.textMuted,
            ),
          ),
        ),
        const SizedBox(height: KapdhSpace.s5),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: KapdhSpace.s1),
          decoration: BoxDecoration(color: KapdhColors.green50, borderRadius: BorderRadius.circular(KapdhRadius.md)),
          child: Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const Padding(
                padding: EdgeInsets.symmetric(vertical: KapdhSpace.s2),
                child: Text('Tidak menerima kode?', style: TextStyle(fontSize: 13)),
              ),
              TextButton(
                key: const ValueKey('otp-resend'),
                onPressed: waiting || resending ? null : onResend,
                style: TextButton.styleFrom(
                  textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                  disabledForegroundColor: KapdhColors.textMuted,
                  minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
                ),
                child: Text(
                  resending
                      ? 'Mengirim...'
                      : (waiting ? 'Kirim ulang dalam ${formatCountdown(resendWait)}' : 'Kirim ulang'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Keadaan memuat challenge dari tautan `?challenge=<id>` lewat POST /auth/otp/status (kontrak C1, AC F16-4).
enum ChallengeLinkPhase {
  /// Tidak ada tautan yang sedang dimuat.
  idle,

  /// Membaca keadaan challenge.
  loading,

  /// Gagal sementara (jaringan, server, batas IP); dapat dicoba lagi.
  failed,

  /// Challenge sudah dipakai, diganti, tidak dikenal, atau tujuannya bukan untuk layar ini (410; tidak dibedakan).
  gone,
}

/// Tampilan layar OTP selama tautan challenge dimuat, gagal dimuat, atau tidak berlaku lagi.
class ChallengeLinkStatusView extends StatelessWidget {
  const ChallengeLinkStatusView({
    super.key,
    required this.phase,
    required this.goneTitle,
    required this.goneMessage,
    required this.goneActionLabel,
    required this.onGoneAction,
    required this.onRetry,
    this.error,
  });

  final ChallengeLinkPhase phase;
  final ApiException? error;
  final String goneTitle;
  final String goneMessage;
  final String goneActionLabel;
  final VoidCallback onGoneAction;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    switch (phase) {
      case ChallengeLinkPhase.loading:
      case ChallengeLinkPhase.idle:
        return const LoadingSkeleton(lines: 4, semanticsLabel: 'Memeriksa kode verifikasi');
      case ChallengeLinkPhase.failed:
        final failure = error;
        return failure == null
            ? ErrorState(title: 'Terjadi kesalahan', message: 'Coba lagi beberapa saat lagi.', onRetry: onRetry)
            : ErrorState.fromException(failure, onRetry: onRetry);
      case ChallengeLinkPhase.gone:
        return EmptyState(
          icon: KapdhIcons.linkOff,
          title: goneTitle,
          message: goneMessage,
          actionLabel: goneActionLabel,
          onAction: onGoneAction,
        );
    }
  }
}
