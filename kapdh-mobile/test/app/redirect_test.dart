import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/app/redirect.dart';
import 'package:kapdh_mobile/core/app_gate/app_gate.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';

import '../support/fakes.dart';

SessionState authed(String status) => SessionState.authenticated(meOf(status: status), syncedAt: testNow);

String? go(SessionState session, String location, {GateStatus gate = GateStatus.ok}) =>
    resolveRedirect(RedirectState(gate: gate, session: session), Uri.parse(location));

/// Path perwakilan setiap kelompok rute ARCHITECTURE §8.4.
const representative = <String, RouteGroup>{
  '/home': RouteGroup.home,
  '/news': RouteGroup.news,
  '/news/silaturahmi-akbar': RouteGroup.news,
  '/events': RouteGroup.events,
  '/events/ev-1': RouteGroup.eventDetail,
  '/tickets': RouteGroup.tickets,
  '/tickets/tk-1': RouteGroup.tickets,
  '/kta': RouteGroup.kta,
  '/renewal': RouteGroup.renewal,
  '/network': RouteGroup.network,
  '/network/members/user-2': RouteGroup.network,
  '/chat/room-1': RouteGroup.chat,
  '/chat/room-1/info': RouteGroup.chat,
  '/chat/new-group': RouteGroup.chat,
  '/chat/invitations': RouteGroup.chat,
  '/notifications': RouteGroup.notifications,
  '/payments': RouteGroup.payments,
  '/payments/new/registration': RouteGroup.payments,
  '/payments/pay-1': RouteGroup.payments,
  '/onboarding/fees': RouteGroup.onboarding,
  '/account': RouteGroup.account,
  '/account/profile': RouteGroup.account,
  '/account/privacy': RouteGroup.account,
  '/account/notifications': RouteGroup.account,
  '/account/sessions': RouteGroup.account,
  '/account/password': RouteGroup.account,
  '/account/blocked': RouteGroup.accountCommunity,
  '/account/reports': RouteGroup.accountReports,
  '/account/delete': RouteGroup.accountDelete,
  '/restricted': RouteGroup.restricted,
  '/deletion-status': RouteGroup.deletionStatus,
  '/legal/ketentuan': RouteGroup.legal,
};

const memberBase = {
  RouteGroup.home,
  RouteGroup.news,
  RouteGroup.kta,
  RouteGroup.payments,
  RouteGroup.notifications,
  RouteGroup.account,
  RouteGroup.accountReports,
  RouteGroup.accountDelete,
  RouteGroup.legal,
};

/// Matriks yang diharapkan (PRD 2.2), ditulis ulang terpisah dari implementasi.
final expectedAllowed = <String, Set<RouteGroup>>{
  'pending_otp': {RouteGroup.registerOtp, RouteGroup.legal},
  'unverified': {...memberBase, RouteGroup.onboarding},
  'verified': {
    ...memberBase,
    RouteGroup.events,
    RouteGroup.eventDetail,
    RouteGroup.tickets,
    RouteGroup.network,
    RouteGroup.chat,
    RouteGroup.renewal,
    RouteGroup.accountCommunity,
  },
  'expiring': {
    ...memberBase,
    RouteGroup.events,
    RouteGroup.eventDetail,
    RouteGroup.tickets,
    RouteGroup.network,
    RouteGroup.chat,
    RouteGroup.renewal,
    RouteGroup.accountCommunity,
  },
  'expired': {...memberBase, RouteGroup.renewal, RouteGroup.tickets, RouteGroup.eventDetail},
  'suspended': {RouteGroup.restricted, RouteGroup.accountReports, RouteGroup.accountDelete, RouteGroup.legal},
  'disabled': {RouteGroup.deletionStatus, RouteGroup.legal},
  'deletion_pending': {RouteGroup.deletionStatus, RouteGroup.legal},
};

const homes = {
  'pending_otp': '/register/otp',
  'unverified': '/onboarding/fees',
  'verified': '/home',
  'expiring': '/home',
  'expired': '/renewal',
  'suspended': '/restricted',
  'disabled': '/deletion-status',
  'deletion_pending': '/deletion-status',
};

void main() {
  group('routeGroupOf', () {
    test('setiap rute ARCHITECTURE §8.4 masuk kelompok yang benar', () {
      for (final MapEntry(key: path, value: group) in representative.entries) {
        expect(routeGroupOf(path), group, reason: path);
      }
      expect(routeGroupOf('/splash'), RouteGroup.splash);
      expect(routeGroupOf('/update-required'), RouteGroup.updateRequired);
      expect(routeGroupOf('/maintenance'), RouteGroup.maintenance);
      expect(routeGroupOf('/login'), RouteGroup.login);
      expect(routeGroupOf('/register'), RouteGroup.register);
      expect(routeGroupOf('/register/otp'), RouteGroup.registerOtp);
      expect(routeGroupOf('/forgot'), RouteGroup.forgot);
      expect(routeGroupOf('/forgot/otp'), RouteGroup.forgotOtp);
      expect(routeGroupOf('/forgot/reset'), RouteGroup.forgotReset);
    });

    test('path tak dikenal dan bentuk menyimpang menjadi unknown', () {
      for (final path in [
        '/',
        '',
        '/chat',
        '/kta/extra',
        '/legal',
        '/legal/a/b',
        '/register/x',
        '/admin',
        '/onboarding',
      ]) {
        expect(routeGroupOf(path), RouteGroup.unknown, reason: path);
      }
    });
  });

  group('matriks PRD 2.2 per effective_status (gerbang ok)', () {
    for (final MapEntry(key: status, value: allowed) in expectedAllowed.entries) {
      test('$status: rute yang diizinkan terbuka, lainnya ke ${homes[status]}', () {
        final session = authed(status);
        for (final MapEntry(key: path, value: group) in representative.entries) {
          final result = go(session, path);
          if (allowed.contains(group)) {
            expect(result, isNull, reason: '$status boleh membuka $path');
          } else {
            expect(result, homes[status], reason: '$status tidak boleh membuka $path');
          }
        }
      });
    }

    test('rute awal mengikuti katalog bersama routeForStatus', () {
      for (final MapEntry(key: status, value: home) in homes.entries) {
        expect(homeFor(EffectiveStatus.fromJson(status)), home);
        expect(go(authed(status), '/splash'), home, reason: status);
        expect(go(authed(status), '/login'), home, reason: status);
      }
    });

    test('expired tetap melihat tiket yang sudah lunas, tetapi tidak event/direktori/chat (PRD 2.2)', () {
      final expired = authed('expired');
      expect(go(expired, '/tickets/tk-1'), isNull);
      // Detail event yang pernah dipesan (kontrak C5 getEvent `nonsuspended`; server menolak event lain).
      expect(go(expired, '/events/ev-1'), isNull);
      expect(go(expired, '/events'), '/renewal');
      expect(go(expired, '/network'), '/renewal');
      expect(go(expired, '/chat/room-1'), '/renewal');
      // Riwayat laporan sendiri tetap terbuka (member_access any); daftar blokir hanya anggota aktif.
      expect(go(expired, '/account/reports'), isNull);
      expect(go(expired, '/account/blocked'), '/renewal');
    });

    test('unverified tidak membuka KTA aktif lewat rute komunitas, tetapi melihat KTA berlabel Tidak Aktif', () {
      final unverified = authed('unverified');
      expect(go(unverified, '/kta'), isNull);
      expect(go(unverified, '/events/ev-1'), '/onboarding/fees');
      expect(go(unverified, '/network/members/user-2'), '/onboarding/fees');
    });

    test('suspended hanya portal pembatasan, legal, laporan/banding sendiri dan hapus akun', () {
      final suspended = authed('suspended');
      expect(go(suspended, '/kta'), '/restricted');
      // moderation.yaml listMyReports/getMyReport member_access any: hasil banding tampil di Laporan Saya.
      expect(go(suspended, '/account/reports'), isNull);
      expect(go(suspended, '/account/blocked'), '/restricted');
      expect(go(suspended, '/payments/new/renewal'), '/restricted');
      expect(go(suspended, '/account/delete'), isNull);
      expect(go(suspended, '/legal/ketentuan-komunitas'), isNull);
    });

    test('status baru yang belum dikenal aplikasi diarahkan ke wajib update', () {
      final session = SessionState.authenticated(
        Me.fromJson({...meJson(), 'effective_status': 'status_baru'}),
        syncedAt: testNow,
      );
      expect(go(session, '/home'), '/update-required');
      expect(go(session, '/update-required'), isNull);
      expect(go(session, '/legal/bantuan'), isNull);
    });

    test('isRouteAllowed: legal selalu boleh', () {
      for (final status in EffectiveStatus.values) {
        expect(isRouteAllowed(status, RouteGroup.legal), isTrue);
      }
    });
  });

  group('legal terbuka untuk semua keadaan', () {
    test('anonim, sesi dimuat, gerbang memeriksa, maintenance dan wajib update', () {
      const legal = '/legal/kebijakan-privasi';
      expect(go(const SessionState.anonymous(), legal), isNull);
      expect(go(const SessionState.unknown(), legal), isNull);
      for (final gate in GateStatus.values) {
        expect(go(const SessionState.anonymous(), legal, gate: gate), isNull, reason: gate.name);
      }
    });
  });

  group('gerbang aplikasi (PRD 4.5)', () {
    test('saat memeriksa semua rute menunggu di splash dengan tujuan tertunda', () {
      expect(go(authed('verified'), '/payments/pay-1', gate: GateStatus.checking), '/splash?from=%2Fpayments%2Fpay-1');
      expect(go(const SessionState.unknown(), '/splash', gate: GateStatus.checking), isNull);
      expect(go(const SessionState.anonymous(), '/login', gate: GateStatus.checking), '/splash');
    });

    test('wajib update menutup semua rute kecuali layar update dan legal', () {
      expect(go(authed('verified'), '/home', gate: GateStatus.updateRequired), '/update-required?from=%2Fhome');
      expect(go(const SessionState.anonymous(), '/login', gate: GateStatus.updateRequired), '/update-required');
      expect(go(authed('verified'), '/update-required', gate: GateStatus.updateRequired), isNull);
    });

    group('maintenance: mode baca terkendali (PRD 4.5 "menolak mutasi, read-only terkontrol")', () {
      const m = GateStatus.maintenance;

      test('rute baca yang diizinkan status tetap terbuka', () {
        for (final path in [
          '/home',
          '/news/silaturahmi-akbar',
          '/kta',
          '/tickets/tk-1',
          '/payments',
          '/payments/pay-1',
          '/notifications',
          '/account',
          '/account/profile',
          '/events/ev-1',
          '/network',
          '/chat/room-1',
        ]) {
          expect(go(authed('verified'), path, gate: m), isNull, reason: path);
        }
        expect(go(authed('expired'), '/tickets/tk-1', gate: m), isNull);
        expect(go(authed('unverified'), '/kta', gate: m), isNull);
        expect(go(authed('unverified'), '/onboarding/fees', gate: m), isNull);
        expect(go(authed('suspended'), '/restricted', gate: m), isNull);
        expect(go(authed('disabled'), '/deletion-status', gate: m), isNull);
        final offline = SessionState.offlineLastKnown(meOf(status: 'verified'), syncedAt: testNow);
        expect(go(offline, '/kta', gate: m), isNull);
      });

      test('alur khusus mutasi diarahkan ke layar maintenance dengan tujuan tertunda', () {
        for (final path in [
          '/payments/new/registration',
          '/payments/new/renewal',
          '/account/delete',
          '/account/password',
          '/chat/new-group',
        ]) {
          expect(
            go(authed('verified'), path, gate: m),
            Uri(path: '/maintenance', queryParameters: {'from': path}).toString(),
            reason: path,
          );
        }
        expect(isMutationOnlyRoute('/payments/pay-1'), isFalse);
        expect(isMutationOnlyRoute('/login'), isTrue);
      });

      test(
        'AC F07-2, PRD 4.5: anggota expired tetap mendapat mode baca: Perpanjang KTA (masa berakhir, iuran, riwayat) '
        'terbuka, pembuatan instruksi perpanjangan tetap ditunda',
        () {
          expect(isMutationOnlyRoute('/renewal'), isFalse);
          expect(go(authed('expired'), '/renewal', gate: m), isNull);
          expect(go(authed('expired'), '/kta', gate: m), isNull);
          expect(go(authed('expired'), '/payments', gate: m), isNull);
          expect(
            go(authed('expired'), '/payments/new/renewal', gate: m),
            '/maintenance?from=%2Fpayments%2Fnew%2Frenewal',
          );
          final state = RedirectState(gate: m, session: authed('expired'));
          expect(readOnlyLanding(state, Uri.parse('/maintenance')), '/renewal');
          expect(readOnlyLanding(state, Uri.parse('/maintenance?from=%2Fpayments%2Fnew%2Frenewal')), '/renewal');
        },
      );

      test('matriks status tetap berlaku: rute yang ditolak status tidak dibuka', () {
        expect(go(authed('suspended'), '/kta', gate: m), '/maintenance?from=%2Fkta');
        expect(go(authed('unverified'), '/network', gate: m), '/maintenance?from=%2Fnetwork');
        expect(go(authed('pending_otp'), '/register/otp', gate: m), '/maintenance');
      });

      test('anonim dan layar auth: login ditolak server, jadi layar maintenance', () {
        expect(go(const SessionState.anonymous(), '/kta', gate: m), '/maintenance?from=%2Fkta');
        expect(go(const SessionState.anonymous(), '/login', gate: m), '/maintenance');
        expect(go(const SessionState.anonymous(), '/splash', gate: m), '/maintenance');
      });

      test('sesi dipulihkan di splash (GET /me), lalu layar maintenance menjelaskan sebelum mode baca', () {
        expect(go(const SessionState.unknown(), '/splash?from=%2Fkta', gate: m), isNull);
        expect(go(authed('verified'), '/splash?from=%2Fkta', gate: m), '/maintenance?from=%2Fkta');
        expect(go(authed('verified'), '/maintenance', gate: m), isNull);
      });

      test('tujuan tombol "Lanjut dalam mode baca"', () {
        RedirectState state(SessionState session) => RedirectState(gate: m, session: session);
        expect(
          readOnlyLanding(state(authed('verified')), Uri.parse('/maintenance?from=%2Ftickets%2Ftk-1')),
          '/tickets/tk-1',
        );
        expect(
          readOnlyLanding(state(authed('verified')), Uri.parse('/maintenance?from=%2Faccount%2Fpassword')),
          '/home',
        );
        expect(readOnlyLanding(state(authed('expired')), Uri.parse('/maintenance')), '/renewal');
        expect(readOnlyLanding(state(authed('verified')), Uri.parse('/maintenance')), '/home');
        expect(readOnlyLanding(state(authed('unverified')), Uri.parse('/maintenance')), '/onboarding/fees');
        expect(readOnlyLanding(state(authed('suspended')), Uri.parse('/maintenance')), '/restricted');
        expect(readOnlyLanding(state(authed('pending_otp')), Uri.parse('/maintenance')), isNull);
        expect(readOnlyLanding(state(const SessionState.anonymous()), Uri.parse('/maintenance')), isNull);
      });
    });

    test('gerbang pulih: keluar dari layar sistem ke tujuan tertunda bila diizinkan', () {
      expect(go(authed('verified'), '/maintenance?from=%2Fkta'), '/kta');
      expect(go(authed('verified'), '/update-required'), '/home');
      expect(go(authed('unverified'), '/maintenance?from=%2Fnetwork'), '/onboarding/fees');
      expect(go(const SessionState.anonymous(), '/maintenance?from=%2Fkta'), '/login?from=%2Fkta');
    });

    test('gerbang tidak tersedia (offline) tidak memblokir', () {
      expect(go(authed('verified'), '/home', gate: GateStatus.unavailable), isNull);
    });
  });

  group('sesi dimuat dan anonim', () {
    test('sesi belum diketahui menahan rute di splash dan menyimpan deep link (AC F13-3)', () {
      expect(go(const SessionState.unknown(), '/payments/pay-1'), '/splash?from=%2Fpayments%2Fpay-1');
      expect(go(const SessionState.unknown(), '/news/berita?ref=push'), '/splash?from=%2Fnews%2Fberita%3Fref%3Dpush');
      expect(go(const SessionState.unknown(), '/splash'), isNull);
      expect(go(const SessionState.unknown(), '/login?from=%2Fkta'), '/splash?from=%2Fkta');
      expect(go(const SessionState.unknown(issue: SessionIssue.offline), '/home'), '/splash?from=%2Fhome');
    });

    test('anonim hanya layar auth publik; rute terlindungi ke login dengan from', () {
      const anon = SessionState.anonymous();
      expect(go(anon, '/login'), isNull);
      expect(go(anon, '/register'), isNull);
      expect(go(anon, '/forgot'), isNull);
      expect(go(anon, '/home'), '/login?from=%2Fhome');
      expect(go(anon, '/payments/pay-1'), '/login?from=%2Fpayments%2Fpay-1');
      expect(go(anon, '/restricted'), '/login?from=%2Frestricted');
      expect(go(anon, '/'), '/login');
      expect(go(anon, '/splash?from=%2Fkta'), '/login?from=%2Fkta');
      expect(go(anon, '/splash'), '/login');
    });

    test('OTP dan pemulihan butuh challenge/token yang sesuai tujuan', () {
      expect(go(const SessionState.anonymous(), '/register/otp'), '/login');
      expect(go(SessionState.anonymous(challenge: challengeOf()), '/register/otp'), isNull);
      expect(
        go(SessionState.anonymous(challenge: challengeOf(purpose: OtpPurpose.passwordReset)), '/register/otp'),
        '/login',
      );
      expect(go(const SessionState.anonymous(), '/forgot/otp'), '/forgot');
      expect(
        go(SessionState.anonymous(challenge: challengeOf(purpose: OtpPurpose.passwordReset)), '/forgot/otp'),
        isNull,
      );
      expect(go(const SessionState.anonymous(), '/forgot/reset'), '/forgot');
      expect(go(const SessionState.anonymous(resetToken: 'reset-1'), '/forgot/reset'), isNull);
    });
  });

  group('tujuan tertunda ?from=', () {
    test('setelah login dibuka bila status mengizinkan', () {
      expect(go(authed('verified'), '/login?from=%2Fpayments%2Fpay-1'), '/payments/pay-1');
      expect(go(authed('verified'), '/splash?from=%2Fnews%2Fberita%3Fref%3Dpush'), '/news/berita?ref=push');
      expect(go(authed('expired'), '/splash?from=%2Ftickets%2Ftk-1'), '/tickets/tk-1');
    });

    test('tujuan yang tidak diizinkan status (perubahan hak) diganti rute awal status (AC F13-3)', () {
      expect(go(authed('unverified'), '/splash?from=%2Fnetwork'), '/onboarding/fees');
      expect(go(authed('suspended'), '/login?from=%2Fkta'), '/restricted');
    });

    test('tujuan luar aplikasi, rute auth/sistem atau path tak dikenal diabaikan', () {
      for (final from in [
        'https://evil.example/home',
        '//evil.example/home',
        '/login',
        '/splash',
        '/maintenance',
        '/x/y',
        '/../home',
      ]) {
        final location = Uri(path: '/splash', queryParameters: {'from': from}).toString();
        expect(go(authed('verified'), location), '/home', reason: from);
      }
    });

    test('tujuan tertunda menerima bentuk deep link kapdh:// dan https App Links', () {
      expect(
        go(authed('verified'), '/splash?from=${Uri.encodeComponent('kapdh://app/payments/pay-1')}'),
        '/payments/pay-1',
      );
      expect(go(authed('verified'), '/app/payments/pay-1'), '/payments/pay-1');
      expect(go(authed('verified'), '/app'), '/');
    });
  });

  group('sesi offline (snapshot /me)', () {
    test('memakai status snapshot dan tidak keluar ke login', () {
      final offline = SessionState.offlineLastKnown(meOf(status: 'verified'), syncedAt: testNow);
      expect(go(offline, '/kta'), isNull);
      expect(go(offline, '/login'), '/home');
      final offlineExpired = SessionState.offlineLastKnown(meOf(status: 'expired'), syncedAt: testNow);
      expect(go(offlineExpired, '/events'), '/renewal');
    });
  });

  test('pending_otp dengan sesi hanya ke OTP', () {
    final pending = authed('pending_otp');
    expect(go(pending, '/home'), '/register/otp');
    expect(go(pending, '/register/otp'), isNull);
  });

  test('isLocationAllowed untuk mengunci tab', () {
    final state = RedirectState(gate: GateStatus.ok, session: authed('unverified'));
    expect(isLocationAllowed(state, '/home'), isTrue);
    expect(isLocationAllowed(state, '/events'), isFalse);
    expect(isLocationAllowed(state, '/network'), isFalse);
    expect(isLocationAllowed(state, '/kta'), isTrue);
    expect(isLocationAllowed(state, '/account'), isTrue);
  });
}
