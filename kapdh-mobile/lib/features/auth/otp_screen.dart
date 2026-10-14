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
import '../status/deletion_portal.dart';
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
///   `email_change` dikirim ke email baru (PRD 2.2). Request dijalankan layar ini, sehingga hasilnya tidak hilang
///   walau lembar koreksi tertutup selama request berjalan.
/// - Hasil verifikasi atau koreksi email yang tidak diketahui (respons hilang) lalu 410 pada request berikutnya:
///   klien memanggil POST /auth/login dengan kredensial di memori (email baru dari koreksi lebih dulu), bukan
///   meminta kode baru (kontrak C1 verifyOtp, AC F01-4, PRD 4.5).
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

  /// Koreksi email sedang dikirim (lembar boleh sudah tertutup); verifikasi dan kirim ulang menunggu hasilnya karena
  /// koreksi yang berhasil membatalkan challenge yang sedang tampil.
  bool _correcting = false;

  /// Galat yang menyangkut kode (salah, kedaluwarsa); kotak menjadi merah.
  String? _codeError;

  /// Galat lain (jaringan, batas, server); ditampilkan di bawah kotak.
  String? _error;

  /// Keterangan netral (mis. kode terbaru setelah pemeriksaan status).
  String? _notice;

  /// Percobaan verifikasi terakhir berakhir tanpa jawaban pasti (kontrak C1): kode mungkin sudah dikonsumsi.
  bool _verifyOutcomeUnknown = false;

  /// Koreksi email yang jawabannya hilang (terbaru di akhir). Server mungkin sudah mengganti email akun dan
  /// membatalkan challenge yang tampil, sehingga 410 berikutnya diperiksa lewat login dengan email baru itu dan sandi
  /// yang baru diketik (hanya memori, kontrak C1 correctPendingEmail, PRD 4.5).
  final List<ActivationCredentials> _unknownCorrections = [];

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

  /// Ada request (verifikasi atau koreksi email) yang hasilnya belum diketahui.
  bool get _outcomeUnknown => _verifyOutcomeUnknown || _unknownCorrections.isNotEmpty;

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

  bool get _busy => _verifying || _recovering || _correcting;

  Future<void> _verify() async {
    final challenge = ref.read(sessionProvider).challenge;
    if (challenge == null || _busy || _code.text.length != 6) return;
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
      _unknownCorrections.clear();
      // Kontrak C1: `session` wajib pada respons verifikasi aktivasi.
      ref.read(registrationDraftProvider.notifier).clear();
      await ref.read(sessionProvider.notifier).establishSession(response.session);
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.otpExpired && _outcomeUnknown) {
        setState(() => _verifying = false);
        await _recoverAndReport();
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

  /// Kredensial untuk memeriksa status akun: email baru dari koreksi yang jawabannya hilang (terbaru lebih dulu),
  /// lalu email akun dari langkah Data Diri/login. Email yang sama hanya dicoba sekali.
  List<ActivationCredentials> _recoveryCandidates() {
    final seen = <String>{};
    return [
      ..._unknownCorrections.reversed,
      ?ref.read(activationCredentialsProvider),
    ].where((candidate) => seen.add(candidate.email.toLowerCase())).toList();
  }

  /// Pemulihan hasil yang tidak diketahui (kontrak C1 verifyOtp; koreksi email PRD 2.2): login dengan kredensial di
  /// memori. `next: home` = aktivasi sudah berhasil dan sesi baru terbit; `next: verify_otp` = akun belum aktif dan
  /// challenge aktivasi terkini (termasuk `email_change` dari koreksi yang jawabannya hilang) dipakai untuk
  /// melanjutkan. 401 untuk satu email berarti email itu bukan email akun, sehingga kandidat berikutnya dicoba. Tanpa
  /// kredensial yang cocok, pengguna diminta masuk sendiri.
  ///
  /// Mengembalikan galat sementara (jaringan, server) bila pemeriksaan sendiri belum berhasil; keadaan dipertahankan
  /// sehingga ketukan berikutnya mengulang pemeriksaan. Null bila pemeriksaan selesai.
  Future<ApiException?> _recoverAfterUnknownOutcome() async {
    final candidates = _recoveryCandidates();
    if (candidates.isEmpty) {
      setState(() {
        _tracker.dead = true;
        _needsSignIn = true;
        _codeError = null;
        _error = null;
        _notice =
            'Verifikasi sebelumnya mungkin sudah berhasil. Masuk dengan email dan password Anda untuk memeriksa '
            'status akun.';
      });
      return null;
    }
    setState(() {
      _recovering = true;
      _codeError = null;
      _error = null;
      _notice = null;
    });
    try {
      ApiException? rejected;
      for (final candidate in candidates) {
        final LoginResult result;
        try {
          result = await ref.read(sessionProvider.notifier).login(email: candidate.email, password: candidate.password);
        } on ApiException catch (error) {
          if (!mounted) return null;
          if (error.code == ErrorCode.unauthenticated) {
            rejected = error;
            continue;
          }
          if (isUnknownOutcome(error)) return error;
          // Jawaban pasti lain (mis. cooldown login 429): pengguna melanjutkan dari layar masuk.
          setState(() {
            _tracker.dead = true;
            _needsSignIn = true;
            _error = error.message;
          });
          return null;
        }
        if (!mounted) return null;
        _applyRecoveredLogin(result, candidate);
        return null;
      }
      // Tidak satu pun kredensial di memori cocok lagi dengan akun.
      setState(() {
        _unknownCorrections.clear();
        _tracker.dead = true;
        _needsSignIn = true;
        _error = rejected?.message;
      });
      return null;
    } finally {
      if (mounted) setState(() => _recovering = false);
    }
  }

  /// [_recoverAfterUnknownOutcome] dari tombol layar ini: galat sementara ditampilkan di bawah kotak.
  Future<void> _recoverAndReport() async {
    final pending = await _recoverAfterUnknownOutcome();
    if (pending != null && mounted) setState(() => _error = pending.message);
  }

  void _applyRecoveredLogin(LoginResult result, ActivationCredentials account) {
    final corrected = _unknownCorrections.contains(account);
    _unknownCorrections.clear();
    _verifyOutcomeUnknown = false;
    switch (result.outcome) {
      case LoginOutcome.signedIn:
        // Aktivasi sudah berhasil; router melanjutkan ke Biaya KTA.
        ref.read(registrationDraftProvider.notifier).clear();
      case LoginOutcome.verifyOtp:
        // SessionController menyimpan challenge aktivasi terkini dari respons login; layar menyelaraskan diri.
        _rememberAccountEmail(account);
        setState(() {
          _code.clear();
          _notice = corrected
              ? 'Email sudah diubah ke ${account.email}. Masukkan kode yang dikirim ke email tersebut.'
              : 'Akun belum aktif. Masukkan kode terbaru yang dikirim ke email Anda.';
        });
      case LoginOutcome.deletionPending || LoginOutcome.accountDisabled:
        // Sama dengan layar masuk: tanpa sesi (kontrak C1), status akun ditampilkan portal status penghapusan yang
        // bekerja tanpa sesi, dengan nomor permintaan dan perkiraan selesai dari jawaban login ini (PRD 2.2, F-14).
        // Pengguna tidak diminta memasukkan sandi lagi; sandi dilepas dari memori.
        ref.read(deletionPortalProvider.notifier).showLoginResult(result, email: account.email);
        ref.read(activationCredentialsProvider.notifier).clear();
        // Bila pengguna beralih ke layar masuk dari portal, emailnya tetap terisi.
        ref.read(authEmailHintProvider.notifier).set(account.email);
        context.go(AppRoutes.deletionStatus);
        ref.read(sessionProvider.notifier).clearFlow();
    }
  }

  /// Email akun yang berlaku sekarang: kredensial pemulihan (memori), isian login dan draf pendaftaran.
  void _rememberAccountEmail(ActivationCredentials account) {
    ref.read(activationCredentialsProvider.notifier).remember(email: account.email, password: account.password);
    ref.read(authEmailHintProvider.notifier).set(account.email);
    final draft = ref.read(registrationDraftProvider);
    if (draft != null && draft.email != account.email) {
      ref.read(registrationDraftProvider.notifier).save(draft.copyWith(email: account.email));
    }
  }

  Future<void> _resend() async {
    final challenge = ref.read(sessionProvider).challenge;
    if (challenge == null || _resending || _busy || _tracker.resendWait(challenge) > Duration.zero) return;
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
      _showSnack('Kode baru dikirim ke ${next.emailMasked}.');
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.otpExpired && _outcomeUnknown) {
        // Akun mungkin sudah aktif, atau emailnya sudah diganti, oleh request yang jawabannya hilang (kontrak C1).
        setState(() => _resending = false);
        await _recoverAndReport();
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

  Future<void> _openEmailCorrection() async {
    final credentials = ref.read(activationCredentialsProvider);
    final draft = ref.read(registrationDraftProvider);
    await showEmailCorrectionSheet(
      context,
      onSubmit: _submitCorrection,
      currentEmail: credentials?.email ?? draft?.email,
    );
  }

  /// Mengirim koreksi email untuk challenge aktivasi yang tampil (POST /auth/email-correction, PRD 2.2). Dipanggil
  /// lembar koreksi, tetapi hasilnya diterapkan di sini walau lembar sudah tertutup. Null bila alur koreksi selesai
  /// (lembar ditutup); selain itu tanggapan yang ditampilkan lembar.
  Future<EmailCorrectionFeedback?> _submitCorrection({required String newEmail, required String password}) async {
    final challenge = ref.read(sessionProvider).challenge;
    if (!mounted || challenge == null || !isActivationPurpose(challenge.purpose) || _busy) return null;
    setState(() {
      _correcting = true;
      _codeError = null;
      _error = null;
      _notice = null;
    });
    try {
      final next = await ref
          .read(authFlowRepositoryProvider)
          .correctEmail(challengeId: challenge.challengeId, password: password, newEmail: newEmail);
      if (!mounted) return null;
      _unknownCorrections.clear();
      _verifyOutcomeUnknown = false;
      ref.read(sessionProvider.notifier).setChallenge(next);
      // Sandi sudah dibuktikan benar oleh server; hanya memori untuk pemulihan hasil verifikasi (kontrak C1).
      _rememberAccountEmail(ActivationCredentials(email: newEmail, password: password));
      setState(() {
        _tracker
          ..sync(next)
          ..clearRateLimit();
        _code.clear();
      });
      _showSnack('Email diubah. Kode baru dikirim ke ${next.emailMasked}.');
      return null;
    } on ApiException catch (error) {
      if (!mounted) return null;
      if (isUnknownOutcome(error)) {
        final attempt = ActivationCredentials(email: newEmail, password: password);
        _unknownCorrections
          ..remove(attempt)
          ..add(attempt);
        // Bila koreksi ternyata berlaku, login berikutnya memakai email baru ini.
        ref.read(authEmailHintProvider.notifier).set(newEmail);
        return EmailCorrectionFeedback(
          message: error.isNetwork
              ? 'Koneksi terputus sebelum hasil diterima; email mungkin sudah diubah. Periksa koneksi lalu ketuk '
                    'Kirim lagi untuk memeriksa.'
              : 'Hasil perubahan email belum diketahui. Ketuk Kirim lagi untuk memeriksa.',
        );
      }
      if (error.code == ErrorCode.otpExpired) {
        if (_outcomeUnknown) {
          setState(() => _correcting = false);
          final pending = await _recoverAfterUnknownOutcome();
          return pending == null ? null : EmailCorrectionFeedback(message: pending.message);
        }
        // Challenge tidak dikenal/sudah dipakai atau akun tidak lagi pending_otp: alur dimulai ulang.
        setState(() {
          _tracker
            ..expired = true
            ..dead = true;
          _codeError = error.message;
        });
        return null;
      }
      return EmailCorrectionFeedback.fromError(error);
    } finally {
      if (mounted) setState(() => _correcting = false);
    }
  }

  void _showSnack(String message) => ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(message)));

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
    // Koreksi yang jawabannya hilang dan belum terbantah: email barunya yang kemungkinan besar berlaku.
    final email = _unknownCorrections.isNotEmpty
        ? _unknownCorrections.last.email
        : ref.read(activationCredentialsProvider)?.email;
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
    final busy = _busy;
    final canVerify = !expired && !busy && !_tracker.dead && !_verifyBlocked && _code.text.length == 6;
    // Email lengkap yang diketik pengguna sendiri boleh ditampilkan (kontrak C1 OtpChallenge.email_masked).
    final email = credentials?.email ?? challenge.emailMasked;

    return _scaffold(
      bottomBar: KapdhButton(
        key: const ValueKey('otp-submit'),
        label: 'Verifikasi',
        busyLabel: _recovering ? 'Memeriksa status akun...' : 'Memeriksa...',
        busy: _verifying || _recovering,
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
                onPressed: busy ? null : _openEmailCorrection,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
