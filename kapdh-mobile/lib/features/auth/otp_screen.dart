import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/deep_link/deep_links.dart';
import '../../core/session/repositories.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import 'auth_flow.dart';
import 'auth_flow_repository.dart';
import 'auth_widgets.dart';
import 'email_correction_sheet.dart';
import 'otp_challenge.dart';
import 'registration_draft.dart';

export 'otp_challenge.dart' show attemptsLeftFrom, otpMaxAttempts, otpResendCooldown, otpValidity;

/// Langkah 2 pendaftaran: verifikasi OTP email (prototipe layar 1; AC F01-2, F01-3). Enam kotak (ketik, tempel,
/// isi otomatis), sisa percobaan dari jawaban server, kirim ulang mengikuti cooldown dan RATE_LIMITED, serta
/// tawaran challenge baru saat kode kedaluwarsa/habis percobaan. Setelah berhasil, sesi terbit dan router
/// melanjutkan ke Biaya KTA (rute status unverified).
///
/// - "Salah email? Ubah alamat email" mengoreksi email akun pending_otp lewat POST /auth/email-correction; kode
///   `email_change` dikirim ke email baru (PRD 2.2).
/// - Hasil verifikasi yang tidak diketahui (respons hilang) lalu 410 pada pengulangan: klien memanggil POST
///   /auth/login dengan kredensial di memori, bukan meminta kode baru (kontrak C1 verifyOtp, AC F01-4).
/// - Dibuka dengan `?challenge=<id>` (challenge dipulihkan): keadaan dibaca lewat POST /auth/otp/status yang
///   hanya-baca, tanpa mengirim kode baru.
class OtpScreen extends ConsumerStatefulWidget {
  const OtpScreen({super.key});

  @override
  ConsumerState<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends ConsumerState<OtpScreen> {
  final _code = TextEditingController();
  late final OtpChallengeTracker _tracker = OtpChallengeTracker(ref.read(serverClockProvider));
  Timer? _ticker;
  bool _verifying = false;
  bool _resending = false;
  bool _recovering = false;

  /// Galat yang menyangkut kode (salah, kedaluwarsa); kotak menjadi merah.
  String? _codeError;

  /// Galat lain (jaringan, batas, server); ditampilkan di bawah kotak.
  String? _error;

  /// Keterangan netral (mis. kode terbaru setelah pemeriksaan status).
  String? _notice;

  /// Percobaan verifikasi terakhir berakhir tanpa jawaban pasti (kontrak C1): kode mungkin sudah dikonsumsi.
  bool _verifyOutcomeUnknown = false;

  /// Status akun hanya dapat diperiksa dengan masuk ulang (kredensial tidak ada di memori atau ditolak).
  bool _needsSignIn = false;

  /// Verifikasi ditolak RATE_LIMITED sampai waktu ini (jam perangkat).
  DateTime? _verifyBlockedUntil;

  String? _handledLink;
  ChallengeLinkPhase _linkPhase = ChallengeLinkPhase.idle;
  ApiException? _linkError;

  @override
  void initState() {
    super.initState();
    final challenge = ref.read(sessionProvider).challenge;
    if (challenge != null && isActivationPurpose(challenge.purpose)) _tracker.sync(challenge);
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final link = DeepLinks.challengeId(GoRouterState.of(context).uri);
    if (link == null || link == _handledLink) return;
    _handledLink = link;
    if (ref.read(sessionProvider).challenge?.challengeId != link) unawaited(_loadLink(link));
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _code.dispose();
    super.dispose();
  }

  DateTime _deviceNow() => ref.read(serverClockProvider).deviceNow();

  /// Membaca challenge dari tautan tanpa mengirim kode baru (POST /auth/otp/status, kontrak C1).
  Future<void> _loadLink(String challengeId) async {
    setState(() {
      _linkPhase = ChallengeLinkPhase.loading;
      _linkError = null;
    });
    try {
      final challenge = await ref.read(authFlowRepositoryProvider).challengeStatus(challengeId);
      if (!mounted) return;
      if (!isActivationPurpose(challenge.purpose)) {
        setState(() => _linkPhase = ChallengeLinkPhase.gone);
        return;
      }
      ref.read(sessionProvider.notifier).setChallenge(challenge);
      setState(() => _linkPhase = ChallengeLinkPhase.idle);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _linkPhase = error.code == ErrorCode.otpExpired ? ChallengeLinkPhase.gone : ChallengeLinkPhase.failed;
        _linkError = error;
      });
    }
  }

  bool get _verifyBlocked {
    final until = _verifyBlockedUntil;
    return until != null && until.isAfter(_deviceNow());
  }

  Future<void> _verify() async {
    final challenge = ref.read(sessionProvider).challenge;
    if (challenge == null || _verifying || _recovering || _code.text.length != 6) return;
    if (_tracker.codeExpired(challenge) || _verifyBlocked || _tracker.dead) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _verifying = true;
      _codeError = null;
      _error = null;
      _notice = null;
    });
    try {
      final response = await ref
          .read(authRepositoryProvider)
          .verifyOtp(challengeId: challenge.challengeId, code: _code.text);
      _verifyOutcomeUnknown = false;
      // Kontrak C1: `session` wajib pada respons verifikasi aktivasi.
      ref.read(registrationDraftProvider.notifier).clear();
      await ref.read(sessionProvider.notifier).establishSession(response.session);
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.otpExpired && _verifyOutcomeUnknown) {
        setState(() => _verifying = false);
        await _recoverAfterUnknownOutcome();
        return;
      }
      setState(() => _applyVerifyError(error));
    } finally {
      if (mounted) setState(() => _verifying = false);
    }
  }

  void _applyVerifyError(ApiException error) {
    if (isUnknownOutcome(error)) {
      // Kode dipertahankan agar "Verifikasi" dapat diketuk lagi; 410 berikutnya diperiksa lewat login (kontrak C1).
      _verifyOutcomeUnknown = true;
      _error = error.isNetwork
          ? 'Koneksi terputus sebelum hasil verifikasi diterima. Periksa koneksi lalu ketuk Verifikasi lagi.'
          : 'Hasil verifikasi belum diketahui. Ketuk Verifikasi lagi untuk memeriksa.';
      return;
    }
    // Jawaban pasti selain 410: percobaan sebelumnya tidak mengaktifkan akun.
    _verifyOutcomeUnknown = false;
    switch (error.code) {
      case ErrorCode.otpExpired:
        _tracker.expired = true;
        _codeError = error.message;
      case ErrorCode.validationError:
        _tracker.wrongCode(error);
        _codeError = error.fieldErrors['code']?.join(' ') ?? error.message;
        _code.clear();
      case ErrorCode.rateLimited:
        final wait = error.retryAfter;
        if (wait != null) _verifyBlockedUntil = _deviceNow().add(wait);
        _error = error.message;
      default:
        _error = error.message;
    }
  }

  /// Pemulihan hasil verifikasi yang tidak diketahui (kontrak C1 verifyOtp): login dengan kredensial di memori.
  /// `next: home` = aktivasi sudah berhasil dan sesi baru terbit; `next: verify_otp` = akun belum aktif dan challenge
  /// aktivasi terkini dipakai untuk melanjutkan. Tanpa kredensial di memori, pengguna diminta masuk.
  Future<void> _recoverAfterUnknownOutcome() async {
    final credentials = ref.read(activationCredentialsProvider);
    if (credentials == null) {
      setState(() {
        _tracker.dead = true;
        _needsSignIn = true;
        _codeError = null;
        _error = null;
        _notice =
            'Verifikasi sebelumnya mungkin sudah berhasil. Masuk dengan email dan password Anda untuk memeriksa '
            'status akun.';
      });
      return;
    }
    setState(() {
      _recovering = true;
      _codeError = null;
      _error = null;
      _notice = null;
    });
    try {
      final result = await ref
          .read(sessionProvider.notifier)
          .login(email: credentials.email, password: credentials.password);
      if (!mounted) return;
      switch (result.outcome) {
        case LoginOutcome.signedIn:
          // Aktivasi sudah berhasil; router melanjutkan ke Biaya KTA.
          ref.read(registrationDraftProvider.notifier).clear();
        case LoginOutcome.verifyOtp:
          // SessionController menyimpan challenge aktivasi terkini dari respons login; layar menyelaraskan diri.
          setState(() {
            _verifyOutcomeUnknown = false;
            _code.clear();
            _notice = 'Akun belum aktif. Masukkan kode terbaru yang dikirim ke email Anda.';
          });
        case LoginOutcome.deletionPending || LoginOutcome.accountDisabled:
          ref
              .read(loginNoticeProvider.notifier)
              .show(const LoginNotice(message: 'Status akun berubah. Masuk kembali untuk melihat statusnya.'));
          ref.read(authEmailHintProvider.notifier).set(credentials.email);
          context.go(AppRoutes.login);
          ref.read(sessionProvider.notifier).clearFlow();
      }
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        if (isUnknownOutcome(error)) {
          // Pemeriksaan sendiri belum berhasil; ketukan Verifikasi berikutnya mengulang pemeriksaan.
          _error = error.message;
        } else {
          _tracker.dead = true;
          _needsSignIn = true;
          _error = error.message;
        }
      });
    } finally {
      if (mounted) setState(() => _recovering = false);
    }
  }

  Future<void> _resend() async {
    final challenge = ref.read(sessionProvider).challenge;
    if (challenge == null || _resending || _tracker.resendWait(challenge) > Duration.zero) return;
    setState(() {
      _resending = true;
      _codeError = null;
      _error = null;
      _notice = null;
    });
    try {
      final next = await ref.read(authRepositoryProvider).resendOtp(challenge.challengeId);
      ref.read(sessionProvider.notifier).setChallenge(next);
      if (!mounted) return;
      setState(() {
        _tracker
          ..sync(next)
          ..clearRateLimit();
        _code.clear();
      });
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text('Kode baru dikirim ke ${next.emailMasked}.')));
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.otpExpired && _verifyOutcomeUnknown) {
        // Akun mungkin sudah aktif oleh verifikasi yang jawabannya hilang (kontrak C1).
        setState(() => _resending = false);
        await _recoverAfterUnknownOutcome();
        return;
      }
      setState(() {
        switch (error.code) {
          case ErrorCode.otpExpired:
            _tracker
              ..expired = true
              ..dead = true;
            _codeError = error.message;
          case ErrorCode.rateLimited:
            final wait = error.retryAfter;
            if (wait != null) _tracker.rateLimited(wait);
            _error = error.message;
          default:
            _error = error.message;
        }
      });
    } finally {
      if (mounted) setState(() => _resending = false);
    }
  }

  Future<void> _correctEmail(OtpChallenge current) async {
    final credentials = ref.read(activationCredentialsProvider);
    final draft = ref.read(registrationDraftProvider);
    final result = await showEmailCorrectionSheet(
      context,
      challengeId: current.challengeId,
      currentEmail: credentials?.email ?? draft?.email,
    );
    if (!mounted || result == null) return;
    switch (result) {
      case EmailCorrected(:final challenge, :final newEmail, :final password):
        ref.read(sessionProvider.notifier).setChallenge(challenge);
        ref.read(activationCredentialsProvider.notifier).remember(email: newEmail, password: password);
        ref.read(authEmailHintProvider.notifier).set(newEmail);
        if (draft != null) ref.read(registrationDraftProvider.notifier).save(draft.copyWith(email: newEmail));
        setState(() {
          _tracker
            ..sync(challenge)
            ..clearRateLimit();
          _verifyOutcomeUnknown = false;
          _code.clear();
          _codeError = null;
          _error = null;
          _notice = null;
        });
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(SnackBar(content: Text('Email diubah. Kode baru dikirim ke ${challenge.emailMasked}.')));
      case EmailCorrectionChallengeGone(:final message):
        setState(() {
          _tracker
            ..expired = true
            ..dead = true;
          _codeError = message;
        });
    }
  }

  void _back() {
    final draft = ref.read(registrationDraftProvider);
    if (draft != null) {
      context.go(AppRoutes.register);
    } else {
      context.go(AppRoutes.login);
      ref.read(sessionProvider.notifier).clearFlow();
    }
  }

  void _restart() {
    final toRegister = ref.read(registrationDraftProvider) != null && !_needsSignIn;
    final email = ref.read(activationCredentialsProvider)?.email;
    if (email != null) ref.read(authEmailHintProvider.notifier).set(email);
    context.go(toRegister ? AppRoutes.register : AppRoutes.login);
    ref.read(sessionProvider.notifier).clearFlow();
  }

  Widget _scaffold({required Widget body, Widget? bottomBar}) => BrandSheetScaffold(
    bottomBar: bottomBar,
    body: SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AuthSheetTitle(title: 'Daftar Alumni', onBack: _back),
          const SizedBox(height: KapdhSpace.s4),
          const RegisterStepper(current: 1),
          const SizedBox(height: KapdhSpace.s6),
          body,
        ],
      ),
    ),
  );

  /// Challenge aktivasi baru (kirim ulang, koreksi email, login pemulihan, tautan): percobaan dan kotak diatur ulang.
  void _onChallengeChanged(OtpChallenge? next) {
    if (next == null || !isActivationPurpose(next.purpose) || !_tracker.sync(next)) return;
    setState(() {
      _codeError = null;
      _code.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(sessionProvider.select((s) => s.challenge), (_, next) => _onChallengeChanged(next));
    final session = ref.watch(sessionProvider);
    final candidate = session.challenge;
    final challenge = candidate != null && isActivationPurpose(candidate.purpose) ? candidate : null;
    // Cadangan: biasanya sudah diselaraskan oleh pendengar di atas sebelum build ini.
    if (challenge != null && _tracker.sync(challenge)) _codeError = null;
    final credentials = ref.watch(activationCredentialsProvider);

    if (_linkPhase != ChallengeLinkPhase.idle || (challenge == null && _handledLink != null)) {
      return _scaffold(
        body: ChallengeLinkStatusView(
          phase: _linkPhase,
          error: _linkError,
          goneTitle: 'Kode verifikasi tidak berlaku',
          goneMessage:
              'Kode ini sudah dipakai, diganti kode yang lebih baru, atau akun sudah aktif. Masuk dengan email dan '
              'password Anda untuk melanjutkan.',
          goneActionLabel: 'Ke halaman masuk',
          onGoneAction: _restart,
          onRetry: () => _loadLink(_handledLink!),
        ),
      );
    }

    if (challenge == null) {
      return BrandSheetScaffold(
        body: EmptyState(
          icon: Icons.mark_email_unread_outlined,
          title: 'Kode verifikasi belum tersedia',
          message: 'Masuk kembali dengan email dan password Anda untuk menerima kode verifikasi baru.',
          actionLabel: 'Ke halaman masuk',
          onAction: () =>
              session.hasSession ? ref.read(sessionProvider.notifier).logout() : context.go(AppRoutes.login),
        ),
      );
    }

    final draft = ref.watch(registrationDraftProvider);
    final wait = _tracker.resendWait(challenge);
    final expired = _tracker.codeExpired(challenge);
    final busy = _verifying || _recovering;
    final canVerify = !expired && !busy && !_tracker.dead && !_verifyBlocked && _code.text.length == 6;
    // Email lengkap yang diketik pengguna sendiri boleh ditampilkan (kontrak C1 OtpChallenge.email_masked).
    final email = credentials?.email ?? challenge.emailMasked;

    return _scaffold(
      bottomBar: KapdhButton(
        key: const ValueKey('otp-submit'),
        label: 'Verifikasi',
        busyLabel: _recovering ? 'Memeriksa status akun...' : 'Memeriksa...',
        busy: busy,
        onPressed: canVerify ? _verify : null,
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          OtpEntrySection(
            controller: _code,
            description: TextSpan(
              children: [
                TextSpan(
                  text: challenge.purpose == OtpPurpose.emailChange
                      ? 'Kode 6 digit sudah dikirim ke email baru '
                      : 'Kode 6 digit sudah dikirim ke ',
                ),
                TextSpan(
                  text: email,
                  style: const TextStyle(fontWeight: FontWeight.w600, color: KapdhColors.text),
                ),
                const TextSpan(text: '. Kode berlaku 10 menit.'),
              ],
            ),
            attemptsLeft: _tracker.attemptsLeft,
            maxAttempts: _tracker.maxAttempts,
            expired: expired,
            enabled: !expired && !busy && !_tracker.dead,
            codeError: _codeError,
            resendWait: wait,
            resending: _resending,
            onResend: _tracker.dead || busy ? null : _resend,
            onChanged: (_) => setState(() {
              if (_codeError != null && !expired) _codeError = null;
            }),
            onCompleted: (_) => _verify(),
          ),
          if (_error != null) ...[
            const SizedBox(height: KapdhSpace.s3),
            Semantics(
              liveRegion: true,
              child: InfoBox(tone: InfoBoxTone.danger, message: _error!),
            ),
          ],
          if (_notice != null) ...[
            const SizedBox(height: KapdhSpace.s3),
            Semantics(liveRegion: true, child: InfoBox(message: _notice!)),
          ],
          if (_tracker.dead) ...[
            const SizedBox(height: KapdhSpace.s3),
            KapdhButton.outlined(
              key: const ValueKey('otp-restart'),
              label: _needsSignIn
                  ? 'Masuk untuk memeriksa status'
                  : (draft != null ? 'Mulai ulang pendaftaran' : 'Masuk kembali'),
              onPressed: _restart,
            ),
          ] else ...[
            const SizedBox(height: KapdhSpace.s2),
            Align(
              alignment: Alignment.centerLeft,
              child: KapdhLinkButton(
                key: const ValueKey('otp-change-email'),
                label: 'Salah email? Ubah alamat email',
                onPressed: busy ? null : () => _correctEmail(challenge),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
