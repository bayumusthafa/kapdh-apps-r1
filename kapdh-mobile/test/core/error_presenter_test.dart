import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/app/theme/kapdh_theme.dart';
import 'package:kapdh_mobile/core/api/error_presenter.dart';
import 'package:kapdh_mobile/core/ui/app_keys.dart';

import '../support/fakes.dart';

ApiException err(String code, {int status = 400, int? retryAfter}) =>
    apiError(status, code, 'Pesan $code', retryAfterSeconds: retryAfter);

void main() {
  group('presentationFor: katalog galat terbangkit → UI seragam (PRD 5.2)', () {
    test('maintenance, wajib update dan sesi berakhir ditangani global (tanpa UI lokal)', () {
      expect(presentationFor(err('MAINTENANCE', status: 503)), isA<SilentPresentation>());
      expect(presentationFor(err('UPGRADE_REQUIRED', status: 426)), isA<SilentPresentation>());
      expect(presentationFor(err('UNAUTHENTICATED', status: 401)), isA<SilentPresentation>());
    });

    test('MEMBERSHIP_REQUIRED dan ACCOUNT_SUSPENDED memuat ulang status lalu router mengarahkan ulang', () {
      expect(presentationFor(err('MEMBERSHIP_REQUIRED', status: 403)).followUp, ErrorFollowUp.refreshStatus);
      expect(presentationFor(err('ACCOUNT_SUSPENDED', status: 403)).followUp, ErrorFollowUp.refreshStatus);
    });

    test('RATE_LIMITED membawa hitung mundur dari retry_after_seconds', () {
      final p = presentationFor(err('RATE_LIMITED', status: 429, retryAfter: 42)) as SnackbarPresentation;
      expect(p.countdown, const Duration(seconds: 42));
    });

    test('konflik versi/status menawarkan muat ulang bila pemanggil menyediakannya (PRD 4.5)', () {
      for (final code in [
        'VERSION_CONFLICT',
        'PAYMENT_STATE_CONFLICT',
        'PROOF_VERSION_CONFLICT',
        'IDEMPOTENCY_CONFLICT',
      ]) {
        final withReload = presentationFor(err(code, status: 409), canReload: true) as SnackbarPresentation;
        expect(withReload.followUp, ErrorFollowUp.reload, reason: code);
        expect(withReload.actionLabel, 'Muat ulang');
        expect((presentationFor(err(code, status: 409)) as SnackbarPresentation).actionLabel, isNull);
      }
    });

    test('jaringan dan galat server menawarkan coba lagi', () {
      final offline = presentationFor(networkError(), canRetry: true) as SnackbarPresentation;
      expect(offline.followUp, ErrorFollowUp.retry);
      expect(offline.message, contains('Tidak dapat terhubung'));
      final server = presentationFor(err('INTERNAL_ERROR', status: 500), canRetry: true) as SnackbarPresentation;
      expect(server.actionLabel, 'Coba lagi');
    });

    test('FILE_INVALID menampilkan aturan tipe dan ukuran berkas (N-10)', () {
      final p = presentationFor(err('FILE_INVALID', status: 422)) as DialogPresentation;
      expect(p.message, contains('5 MB'));
      expect(p.message, contains('10 MB'));
    });

    test('kuota penuh, reservasi berakhir dan sudah check-in memakai dialog', () {
      expect(presentationFor(err('EVENT_SOLD_OUT', status: 409)), isA<DialogPresentation>());
      expect(presentationFor(err('RESERVATION_EXPIRED', status: 410)), isA<DialogPresentation>());
      expect(presentationFor(err('TICKET_ALREADY_CHECKED_IN', status: 409)), isA<DialogPresentation>());
    });

    test('REAUTH_REQUIRED meminta sandi hanya bila pemanggil dapat memakai token', () {
      expect(presentationFor(err('REAUTH_REQUIRED', status: 403)).followUp, ErrorFollowUp.none);
      expect(
        presentationFor(err('REAUTH_REQUIRED', status: 403), canReauthenticate: true).followUp,
        ErrorFollowUp.reauthenticate,
      );
    });

    test('setiap ErrorCode memiliki presentasi', () {
      for (final code in ErrorCode.values.where((c) => c != ErrorCode.unknown)) {
        expect(() => presentationFor(err(code.value)), returnsNormally, reason: code.value);
      }
    });
  });

  group('ErrorPresenter.present', () {
    Future<(ProviderContainer, ErrorPresenter)> pumpHost(WidgetTester tester) async {
      final container = makeContainer();
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: KapdhTheme.light(),
            scaffoldMessengerKey: container.read(scaffoldMessengerKeyProvider),
            navigatorKey: container.read(rootNavigatorKeyProvider),
            home: const Scaffold(body: SizedBox()),
          ),
        ),
      );
      return (container, container.read(errorPresenterProvider));
    }

    testWidgets('snackbar dengan aksi coba lagi', (tester) async {
      final (_, presenter) = await pumpHost(tester);
      var retried = 0;
      await presenter.present(networkError(), onRetry: () => retried++);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 750));

      expect(find.textContaining('Tidak dapat terhubung'), findsOneWidget);
      await tester.tap(find.text('Coba lagi'));
      expect(retried, 1);
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('RATE_LIMITED menampilkan hitung mundur', (tester) async {
      final (_, presenter) = await pumpHost(tester);
      await presenter.present(err('RATE_LIMITED', status: 429, retryAfter: 42));
      await tester.pump();
      expect(find.textContaining(RegExp(r'Coba lagi dalam 0:4[12]')), findsOneWidget);
      await tester.pump(const Duration(seconds: 31));
    });

    testWidgets('FILE_INVALID membuka dialog aturan berkas', (tester) async {
      final (_, presenter) = await pumpHost(tester);
      final shown = presenter.present(err('FILE_INVALID', status: 413));
      await tester.pumpAndSettle();
      expect(find.text('Berkas tidak dapat diterima'), findsOneWidget);
      await tester.tap(find.text('Tutup'));
      await tester.pumpAndSettle();
      expect(await shown, isA<DialogPresentation>());
    });
  });
}
