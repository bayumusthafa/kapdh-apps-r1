import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/redirect.dart' show homeFor;
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
import 'otp_challenge.dart';

/// Lupa Password langkah 2 (F-02, AC F02-4, F16-4): kode `password_reset` ditukar `reset_token` sekali pakai lewat
/// POST /auth/password/forgot/verify, lalu layar Password Baru.
///
/// - Salinan non-enumerasi (PRD 2.5): layar tidak pernah menyatakan email terdaftar; challenge pengganti untuk email
///   yang tidak terdaftar berperilaku sama (kode selalu salah sampai percobaan habis).
/// - Tautan email reset dari pengurus `/forgot/otp?challenge=<id>` (AC F16-4): keadaan challenge dibaca lewat
///   POST /auth/otp/status yang hanya-baca, sehingga kode yang baru diterima tidak diganti dan batas kirim tidak
///   terpakai. Kirim ulang hanya bila pengguna menekan "Kirim ulang".
///   Selama tautan dimuat, gagal dimuat atau tidak berlaku, keadaannya yang ditampilkan walau challenge pemulihan
///   lain masih di memori, agar kode dari email pengurus tidak diketik ke challenge lama yang sudah dibatalkan.
/// - Tautan dibuka saat anggota masih masuk di perangkat ini: reset dari pengurus mencabut seluruh sesinya, jadi
///   layar menjelaskannya dan menawarkan keluar lalu melanjutkan dengan tautan yang sama (AC F16-4, PRD 4.5).
/// - Respons verifikasi hilang lalu 410: kode sudah terpakai; pengguna memulai ulang lupa password (kontrak C1).
class ForgotOtpScreen extends ConsumerStatefulWidget {
  const ForgotOtpScreen({super.key});

  @override
  ConsumerState<ForgotOtpScreen> createState() => _ForgotOtpScreenState();
}

class _ForgotOtpScreenState extends ConsumerState<ForgotOtpScreen> {
  final _code = TextEditingController();
  late final OtpChallengeTracker _tracker = OtpChallengeTracker(ref.read(serverClockProvider));
  Timer? _ticker;
  bool _verifying = false;
  bool _resending = false;
  String? _codeError;
  String? _error;

  /// Percobaan verifikasi terakhir berakhir tanpa jawaban pasti; kode mungkin sudah dikonsumsi (kontrak C1).
  bool _verifyOutcomeUnknown = false;

  /// Kode mungkin sudah terpakai oleh verifikasi yang jawabannya hilang: alur dimulai ulang dari email.
  bool _consumedUnknown = false;
  DateTime? _verifyBlockedUntil;

  /// Challenge terakhir yang ditampilkan; tetap dipakai selama transisi ke layar Password Baru.
  OtpChallenge? _shown;
  bool _handedOff = false;

  String? _handledLink;
  ChallengeLinkPhase _linkPhase = ChallengeLinkPhase.idle;
  ApiException? _linkError;

  /// Tautan diterima saat masih ada sesi: dibaca setelah pengguna keluar (atau sesinya dicabut server).
  bool _linkAwaitsSignOut = false;
  bool _signingOut = false;

  @override
  void initState() {
    super.initState();
    final challenge = ref.read(sessionProvider).challenge;
    if (challenge?.purpose == OtpPurpose.passwordReset) _tracker.sync(challenge!);
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
    final session = ref.read(sessionProvider);
    if (session.hasSession) {
      // Challenge tidak dapat disimpan selama ada sesi; status dibaca setelah keluar.
      _linkAwaitsSignOut = true;
      return;
    }
    _linkAwaitsSignOut = false;
    if (session.challenge?.challengeId != link) unawaited(_loadLink(link));
  }

  /// Sesi berakhir (pengguna keluar, atau sesi dicabut reset pengurus): tautan yang menunggu dibaca sekarang.
  void _onSessionChanged(bool hasSession) {
    final link = _handledLink;
    if (hasSession || !_linkAwaitsSignOut || link == null) return;
    _linkAwaitsSignOut = false;
    if (ref.read(sessionProvider).challenge?.challengeId != link) unawaited(_loadLink(link));
  }

  /// Keluar dari perangkat ini lalu melanjutkan tautan pemulihan (AC F16-4). Data privat lokal dihapus logout.
  Future<void> _signOutAndContinue() async {
    if (_signingOut) return;
    setState(() => _signingOut = true);
    try {
      await ref.read(sessionProvider.notifier).logout();
    } finally {
      if (mounted) setState(() => _signingOut = false);
    }
  }

  void _goHome() => context.go(homeFor(ref.read(sessionProvider).effectiveStatus ?? EffectiveStatus.unknown));

  @override
  void dispose() {
    _ticker?.cancel();
    _code.dispose();
    super.dispose();
  }

  DateTime _deviceNow() => ref.read(serverClockProvider).deviceNow();

  /// Membaca challenge dari tautan email tanpa mengirim kode baru (POST /auth/otp/status, AC F16-4).
  Future<void> _loadLink(String challengeId) async {
    setState(() {
      _linkPhase = ChallengeLinkPhase.loading;
      _linkError = null;
    });
    try {
      final challenge = await ref.read(authFlowRepositoryProvider).challengeStatus(challengeId);
      if (!mounted) return;
      if (challenge.purpose != OtpPurpose.passwordReset) {
        setState(() => _linkPhase = ChallengeLinkPhase.gone);
        return;
      }
      ref.read(sessionProvider.notifier)
        ..clearFlow()
        ..setChallenge(challenge);
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
    if (challenge == null || challenge.purpose != OtpPurpose.passwordReset) return;
    if (_verifying || _code.text.length != 6 || _tracker.codeExpired(challenge) || _tracker.dead) return;
    if (_verifyBlocked) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _verifying = true;
      _codeError = null;
      _error = null;
    });
    try {
      final grant = await ref
          .read(authFlowRepositoryProvider)
          .verifyPasswordReset(challengeId: challenge.challengeId, code: _code.text);
      if (!mounted) return;
      _verifyOutcomeUnknown = false;
      _handedOff = true;
      final router = GoRouter.of(context);
      // reset_token hanya di memori (kontrak C1 PasswordResetGrant); batas berlakunya untuk layar Password Baru.
      ref.read(resetGrantExpiryProvider.notifier).set(grant.expiresAt);
      ref.read(sessionProvider.notifier).setResetToken(grant.resetToken);
      router.go(AppRoutes.forgotReset);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _applyVerifyError(error));
    } finally {
      if (mounted) setState(() => _verifying = false);
    }
  }

  void _applyVerifyError(ApiException error) {
    if (isUnknownOutcome(error)) {
      _verifyOutcomeUnknown = true;
      _error = error.isNetwork
          ? 'Koneksi terputus sebelum hasil verifikasi diterima. Periksa koneksi lalu ketuk Verifikasi lagi.'
          : 'Hasil verifikasi belum diketahui. Ketuk Verifikasi lagi untuk memeriksa.';
      return;
    }
    if (error.code == ErrorCode.otpExpired && _verifyOutcomeUnknown) {
      // Kode sudah dikonsumsi oleh percobaan yang jawabannya hilang; reset_token-nya tidak pernah diterima dan
      // kedaluwarsa sendiri. Pemulihan dimulai ulang dengan challenge baru (kontrak C1).
      _tracker
        ..expired = true
        ..dead = true;
      _consumedUnknown = true;
      _codeError = null;
      return;
    }
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

  Future<void> _resend() async {
    final challenge = ref.read(sessionProvider).challenge;
    if (challenge == null || _resending || _tracker.resendWait(challenge) > Duration.zero) return;
    setState(() {
      _resending = true;
      _codeError = null;
      _error = null;
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
      )?.showSnackBar(const SnackBar(content: Text('Kode baru dikirim bila email terdaftar dan aktif.')));
    } on ApiException catch (error) {
      if (!mounted) return;
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

  /// Kembali ke langkah email untuk meminta kode baru (email terakhir diisi otomatis).
  void _restart() {
    context.go(AppRoutes.forgot);
    ref.read(sessionProvider.notifier).clearFlow();
  }

  void _onChallengeChanged(OtpChallenge? next) {
    if (next == null || next.purpose != OtpPurpose.passwordReset || !_tracker.sync(next)) return;
    setState(() {
      _codeError = null;
      _code.clear();
      _consumedUnknown = false;
      _verifyOutcomeUnknown = false;
    });
  }

  Widget _scaffold({required Widget body, Widget? bottomBar, VoidCallback? onBack}) => BrandSheetScaffold(
    bottomBar: bottomBar,
    body: SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AuthSheetTitle(title: 'Lupa Password', onBack: onBack ?? () => context.go(AppRoutes.forgot)),
          const SizedBox(height: KapdhSpace.s4),
          const RecoveryStepper(current: 1),
          const SizedBox(height: KapdhSpace.s6),
          body,
        ],
      ),
    ),
  );

  /// Tautan pemulihan diterima saat anggota masih masuk (AC F16-4).
  Widget _signedInNotice() => _scaffold(
    onBack: _goHome,
    body: AuthResultPanel(
      icon: KapdhIcons.lockReset,
      iconColor: context.kc.primary,
      title: 'Tautan pemulihan password',
      message:
          'Tautan ini untuk membuat password baru, tetapi Anda masih masuk di perangkat ini. Keluar dahulu untuk '
          'melanjutkan. Bila password Anda direset pengurus, sesi di perangkat ini sudah dicabut sehingga Anda tetap '
          'perlu masuk kembali dengan password baru.',
      actions: [
        KapdhButton(
          key: const ValueKey('forgot-link-signout'),
          label: 'Keluar dan lanjutkan',
          busyLabel: 'Keluar...',
          busy: _signingOut,
          onPressed: _signOutAndContinue,
        ),
        KapdhButton.outlined(
          key: const ValueKey('forgot-link-home'),
          label: 'Kembali ke beranda',
          onPressed: _signingOut ? null : _goHome,
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    ref
      ..listen(sessionProvider.select((s) => s.challenge), (_, next) => _onChallengeChanged(next))
      ..listen(sessionProvider.select((s) => s.hasSession), (_, next) => _onSessionChanged(next));
    if (ref.watch(sessionProvider.select((s) => s.hasSession))) return _signedInNotice();
    final candidate = ref.watch(sessionProvider.select((s) => s.challenge));
    var challenge = candidate?.purpose == OtpPurpose.passwordReset ? candidate : null;
    if (challenge != null) {
      if (_tracker.sync(challenge)) _codeError = null;
      _shown = challenge;
    } else if (_handedOff) {
      challenge = _shown;
    }

    // Keadaan tautan diutamakan atas challenge lain di memori: kode dari email pengurus milik challenge tautan.
    if (challenge == null || _linkPhase != ChallengeLinkPhase.idle) {
      return _scaffold(
        body: ChallengeLinkStatusView(
          phase: _handledLink == null ? ChallengeLinkPhase.gone : _linkPhase,
          error: _linkError,
          goneTitle: _handledLink == null ? 'Kode pemulihan belum tersedia' : 'Tautan pemulihan tidak berlaku',
          goneMessage: _handledLink == null
              ? 'Minta kode pemulihan dari layar Lupa Password.'
              : 'Kode pada tautan ini sudah dipakai, diganti kode yang lebih baru, atau tidak berlaku lagi. Minta '
                    'kode pemulihan baru dari layar Lupa Password.',
          goneActionLabel: 'Minta kode baru',
          onGoneAction: _restart,
          onRetry: () => _loadLink(_handledLink!),
        ),
      );
    }

    final wait = _tracker.resendWait(challenge);
    final expired = _tracker.codeExpired(challenge);
    final canVerify = !expired && !_verifying && !_tracker.dead && !_verifyBlocked && _code.text.length == 6;
    final typed = ref.watch(authEmailHintProvider);
    // Email yang diketik sendiri boleh ditampilkan; dari tautan hanya email tersamar dari server.
    final email = _handledLink == null && typed.isNotEmpty ? typed : challenge.emailMasked;

    return _scaffold(
      bottomBar: KapdhButton(
        key: const ValueKey('otp-submit'),
        label: 'Verifikasi',
        busyLabel: 'Memeriksa...',
        busy: _verifying,
        onPressed: canVerify ? _verify : null,
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          OtpEntrySection(
            controller: _code,
            title: 'Masukkan kode pemulihan',
            // Non-enumerasi (PRD 2.5): tidak menyatakan email terdaftar.
            description: TextSpan(
              children: [
                const TextSpan(text: 'Bila akun dengan email '),
                TextSpan(
                  text: email,
                  style: TextStyle(fontWeight: FontWeight.w600, color: context.kc.text),
                ),
                const TextSpan(
                  text: ' terdaftar dan aktif, kode 6 digit sudah dikirim ke email tersebut. Kode berlaku 10 menit.',
                ),
              ],
            ),
            attemptsLeft: _tracker.attemptsLeft,
            maxAttempts: _tracker.maxAttempts,
            expired: expired,
            enabled: !expired && !_verifying && !_tracker.dead,
            codeError: _codeError,
            resendWait: wait,
            resending: _resending,
            onResend: _tracker.dead || _verifying ? null : _resend,
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
          if (_consumedUnknown) ...[
            const SizedBox(height: KapdhSpace.s3),
            Semantics(
              liveRegion: true,
              child: const InfoBox(
                tone: InfoBoxTone.warning,
                title: 'Kode sudah terpakai',
                message:
                    'Kode ini kemungkinan sudah terpakai saat koneksi terputus. Minta kode pemulihan baru untuk '
                    'melanjutkan.',
              ),
            ),
          ],
          if (_tracker.dead) ...[
            const SizedBox(height: KapdhSpace.s3),
            KapdhButton.outlined(key: const ValueKey('otp-restart'), label: 'Minta kode baru', onPressed: _restart),
          ],
        ],
      ),
    );
  }
}
