import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../format/formatters.dart';
import '../session/session_controller.dart';
import '../ui/app_keys.dart';
import '../ui/reauth_dialog.dart';

/// Tindak lanjut otomatis setelah galat ditampilkan.
enum ErrorFollowUp {
  none,

  /// Tawarkan "Coba lagi" (galat jaringan/server).
  retry,

  /// Tawarkan "Muat ulang" data terbaru (konflik versi/status, PRD 4.5).
  reload,

  /// Muat ulang GET /me lalu router mengarahkan ulang (MEMBERSHIP_REQUIRED, ACCOUNT_SUSPENDED).
  refreshStatus,

  /// Minta sandi untuk token reautentikasi (REAUTH_REQUIRED).
  reauthenticate,
}

/// Cara menampilkan satu galat; hasil murni dari katalog galat terbangkit (PRD 5.2) sehingga dapat diuji.
@immutable
sealed class ErrorPresentation {
  const ErrorPresentation({required this.message, this.followUp = ErrorFollowUp.none});

  final String message;
  final ErrorFollowUp followUp;
}

/// Snackbar dengan aksi opsional dan hitung mundur ([countdown], dari retry_after_seconds / Retry-After).
final class SnackbarPresentation extends ErrorPresentation {
  const SnackbarPresentation({required super.message, super.followUp, this.actionLabel, this.countdown});

  final String? actionLabel;
  final Duration? countdown;
}

/// Dialog untuk galat yang perlu dibaca dengan tenang (aturan berkas, kuota habis, reservasi berakhir).
final class DialogPresentation extends ErrorPresentation {
  const DialogPresentation({required this.title, required super.message, super.followUp});

  final String title;
}

/// Ditangani global oleh gerbang aplikasi/router (MAINTENANCE, UPGRADE_REQUIRED, sesi berakhir): tidak ada UI lokal.
final class SilentPresentation extends ErrorPresentation {
  const SilentPresentation({required super.message, super.followUp});
}

/// Aturan berkas yang ditampilkan untuk FILE_INVALID (N-10, PRD 4.5).
const String fileRulesText =
    'Gunakan foto JPG/PNG maksimal 5 MB atau PDF maksimal 10 MB. Maksimal 10 unggahan berhasil '
    'per jenis dalam 24 jam.';

/// Pemetaan murni ErrorUiAction (katalog terbangkit) ke presentasi UI seragam (PRD 4.5, 5.2).
///
/// [canRetry]/[canReload]/[canReauthenticate] menandai apakah pemanggil menyediakan tindakan tersebut.
ErrorPresentation presentationFor(
  ApiException error, {
  bool canRetry = false,
  bool canReload = false,
  bool canReauthenticate = false,
}) {
  final message = error.message;
  switch (error.ui.action) {
    case ErrorUiAction.showMaintenance:
    case ErrorUiAction.forceUpdate:
    case ErrorUiAction.goToLogin:
      // Gerbang aplikasi (sinyal 503/426) dan koordinator refresh (UNAUTHENTICATED) sudah mengarahkan router.
      return SilentPresentation(message: message);
    case ErrorUiAction.refreshStatus:
    case ErrorUiAction.goToRestricted:
      return SnackbarPresentation(message: message, followUp: ErrorFollowUp.refreshStatus);
    case ErrorUiAction.reauthenticate:
      return SnackbarPresentation(
        message: message,
        followUp: canReauthenticate ? ErrorFollowUp.reauthenticate : ErrorFollowUp.none,
      );
    case ErrorUiAction.showCountdown:
      return SnackbarPresentation(message: message, countdown: error.retryAfter);
    case ErrorUiAction.showFileRules:
      return DialogPresentation(title: 'Berkas tidak dapat diterima', message: '$message\n\n$fileRulesText');
    case ErrorUiAction.showSoldOut:
      return DialogPresentation(
        title: 'Kuota penuh',
        message: message,
        followUp: canReload ? ErrorFollowUp.reload : ErrorFollowUp.none,
      );
    case ErrorUiAction.showReservationExpired:
      return DialogPresentation(
        title: 'Reservasi berakhir',
        message: message,
        followUp: canReload ? ErrorFollowUp.reload : ErrorFollowUp.none,
      );
    case ErrorUiAction.showAlreadyCheckedIn:
      return DialogPresentation(title: 'Sudah check-in', message: message);
    case ErrorUiAction.reloadLatest:
      return SnackbarPresentation(
        message: message,
        followUp: canReload ? ErrorFollowUp.reload : ErrorFollowUp.none,
        actionLabel: canReload ? 'Muat ulang' : null,
      );
    case ErrorUiAction.showOffline:
    case ErrorUiAction.showRetry:
      return SnackbarPresentation(
        message: message,
        followUp: canRetry ? ErrorFollowUp.retry : ErrorFollowUp.none,
        actionLabel: canRetry ? 'Coba lagi' : null,
      );
    case ErrorUiAction.showFieldErrors:
    case ErrorUiAction.goToMfa:
    case ErrorUiAction.showForbidden:
    case ErrorUiAction.offerNewOtp:
    case ErrorUiAction.showNotFound:
      return SnackbarPresentation(message: message);
  }
}

final errorPresenterProvider = Provider<ErrorPresenter>(ErrorPresenter.new);

/// Penyaji galat global: snackbar, dialog dan tindak lanjut rute sesuai katalog (PRD 5.2 "satu katalog
/// penanganan galat"). Layar formulir tetap menampilkan field_errors di field masing-masing.
class ErrorPresenter {
  ErrorPresenter(this._ref);

  final Ref _ref;

  ScaffoldMessengerState? get _messenger => _ref.read(scaffoldMessengerKeyProvider).currentState;
  BuildContext? get _navigatorContext => _ref.read(rootNavigatorKeyProvider).currentContext;

  /// Menampilkan [error]. [onRetry] untuk galat jaringan/server, [onReload] untuk konflik versi/status,
  /// [onReauthenticated] menerima token X-Reauth-Token setelah pengguna mengonfirmasi sandi.
  Future<ErrorPresentation> present(
    ApiException error, {
    VoidCallback? onRetry,
    VoidCallback? onReload,
    ValueChanged<String>? onReauthenticated,
  }) async {
    if (error.isCancelled) return SilentPresentation(message: error.message);
    final presentation = presentationFor(
      error,
      canRetry: onRetry != null,
      canReload: onReload != null,
      canReauthenticate: onReauthenticated != null,
    );
    if (presentation.followUp == ErrorFollowUp.refreshStatus) {
      unawaited(_ref.read(sessionProvider.notifier).refreshQuietly());
    }
    switch (presentation) {
      case SilentPresentation():
        break;
      case SnackbarPresentation(:final message, :final actionLabel, :final countdown, :final followUp):
        if (followUp == ErrorFollowUp.reauthenticate && onReauthenticated != null) {
          final token = await requestReauthToken(reason: message);
          if (token != null) onReauthenticated(token);
          break;
        }
        final action = switch (followUp) {
          ErrorFollowUp.retry => onRetry,
          ErrorFollowUp.reload => onReload,
          _ => null,
        };
        _messenger
          ?..hideCurrentSnackBar()
          ..showSnackBar(
            SnackBar(
              content: countdown != null
                  ? CountdownMessage(message: message, until: DateTime.now().add(countdown))
                  : Text(message),
              duration: countdown != null && countdown > const Duration(seconds: 4)
                  ? (countdown > const Duration(seconds: 30) ? const Duration(seconds: 30) : countdown)
                  : const Duration(seconds: 4),
              action: actionLabel != null && action != null
                  ? SnackBarAction(label: actionLabel, onPressed: action)
                  : null,
            ),
          );
      case DialogPresentation(:final title, :final message, :final followUp):
        final context = _navigatorContext;
        if (context == null || !context.mounted) break;
        await showDialog<void>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: Text(title),
            content: Text(message),
            actions: [
              if (followUp == ErrorFollowUp.reload && onReload != null)
                TextButton(
                  onPressed: () {
                    Navigator.of(dialogContext).pop();
                    onReload();
                  },
                  child: const Text('Muat ulang'),
                ),
              TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Tutup')),
            ],
          ),
        );
    }
    return presentation;
  }

  /// Meminta sandi untuk POST /auth/reauth (tindakan sensitif, ARCHITECTURE §4.3). Null bila dibatalkan.
  Future<String?> requestReauthToken({String? reason}) async {
    final context = _navigatorContext;
    if (context == null || !context.mounted) return null;
    return showReauthDialog(context, reason: reason);
  }
}

/// Pesan dengan hitung mundur `m:ss` untuk RATE_LIMITED (ErrorUiAction.showCountdown).
class CountdownMessage extends StatefulWidget {
  const CountdownMessage({super.key, required this.message, required this.until});

  final String message;
  final DateTime until;

  @override
  State<CountdownMessage> createState() => _CountdownMessageState();
}

class _CountdownMessageState extends State<CountdownMessage> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() {});
      if (!DateTime.now().isBefore(widget.until)) _timer?.cancel();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final remaining = widget.until.difference(DateTime.now());
    final suffix = remaining > Duration.zero
        ? ' Coba lagi dalam ${formatCountdown(remaining)}.'
        : ' Silakan coba lagi.';
    return Text('${widget.message}$suffix');
  }
}
