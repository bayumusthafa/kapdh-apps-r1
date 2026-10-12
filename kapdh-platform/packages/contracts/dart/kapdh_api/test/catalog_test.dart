// Uji katalog terbangkit dari @kapdh/shared: perilaku UI per kode galat (PRD 5.2, 4.5) dan rute awal per
// effective_status (PRD 2.2).
import 'package:kapdh_api/kapdh_api.dart';
import 'package:test/test.dart';

void main() {
  group('errorUiFor', () {
    test('setiap ErrorCode kontrak memiliki perilaku dan pesan cadangan', () {
      for (final code in ErrorCode.values) {
        final ui = errorUiFor(code);
        expect(ui.fallbackMessage, isNotEmpty, reason: code.name);
      }
    });

    test('pemetaan aksi sesuai ARCHITECTURE §4.4', () {
      expect(errorUiFor(ErrorCode.membershipRequired).action, ErrorUiAction.refreshStatus);
      expect(errorUiFor(ErrorCode.reauthRequired).action, ErrorUiAction.reauthenticate);
      expect(errorUiFor(ErrorCode.upgradeRequired).action, ErrorUiAction.forceUpdate);
      expect(errorUiFor(ErrorCode.notFound).action, ErrorUiAction.showNotFound);
      expect(errorUiFor(ErrorCode.accountSuspended).action, ErrorUiAction.goToRestricted);
      expect(errorUiFor(ErrorCode.unauthenticated).action, ErrorUiAction.goToLogin);
      expect(errorUiFor(ErrorCode.unknown), clientErrorUi(ClientErrorCode.unknown));
      expect(clientErrorUi(ClientErrorCode.network).action, ErrorUiAction.showOffline);
    });
  });

  group('routeForStatus (PRD 2.2)', () {
    test('rute awal dan path go_router per status', () {
      expect(routeForStatus(EffectiveStatus.pendingOtp), MemberRoute.verifyOtp);
      expect(routeForStatus(EffectiveStatus.unverified)?.path, '/onboarding/fees');
      expect(routeForStatus(EffectiveStatus.verified), MemberRoute.home);
      expect(routeForStatus(EffectiveStatus.expiring), MemberRoute.home);
      expect(routeForStatus(EffectiveStatus.expired), MemberRoute.renewal);
      expect(routeForStatus(EffectiveStatus.suspended), MemberRoute.restricted);
      expect(routeForStatus(EffectiveStatus.disabled), MemberRoute.deletionStatus);
      expect(routeForStatus(EffectiveStatus.deletionPending)?.path, '/deletion-status');
    });

    test('status yang belum dikenal tidak menebak akses', () {
      expect(routeForStatus(EffectiveStatus.unknown), isNull);
      expect(membershipLabel(EffectiveStatus.unknown), 'Status Tidak Dikenal');
      expect(membershipLabel(EffectiveStatus.expiring), 'Segera Berakhir');
    });
  });
}
