import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/core/app_gate/app_gate.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/features/auth/auth_flow.dart';
import 'package:kapdh_mobile/features/auth/register_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';

Finder fieldOf(String key) => find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(TextFormField));
Finder get submit => find.byKey(const ValueKey('register-submit'));

Future<AppHarness> openRegister(WidgetTester tester, FakeHandler handler, {double textScale = 1}) async {
  final app = await pumpApp(tester, handler: handler, textScale: textScale);
  app.router.go('/register');
  await settle(tester);
  return app;
}

Future<void> choose(WidgetTester tester, String key, String item) async {
  await scrollAndTap(tester, find.byKey(ValueKey(key)));
  await settle(tester);
  await tester.tap(find.text(item).last);
  await settle(tester);
}

Future<void> fillForm(WidgetTester tester, {String email = 'ahmad.islam@email.com'}) async {
  await tester.enterText(fieldOf('register-name'), 'Ahmad Islam');
  await choose(tester, 'register-gender', 'Laki-laki');
  await scrollTo(tester, fieldOf('register-email'));
  await tester.enterText(fieldOf('register-email'), email);
  await scrollTo(tester, fieldOf('register-password'));
  await tester.enterText(fieldOf('register-password'), 'Rahasia#123');
  await tester.pump();
  await choose(tester, 'register-cohort', 'Angkatan 29 (lulus 2025)');
  await choose(tester, 'register-class-in', 'Kelas 1 (1 MTs)');
  await choose(tester, 'register-class-out', 'Kelas 6 (3 Aliyah)');
  await scrollAndTap(tester, find.byKey(const ValueKey('register-consent')));
  await settle(tester);
}

void main() {
  testWidgets('Data Diri tanpa Nomor KTP; pratinjau tahun akademik; kirim membuat challenge OTP (AC F01-1)', (
    tester,
  ) async {
    final app = await openRegister(
      tester,
      apiRoutes({'/auth/register': (_) => FakeResponse.json(201, otpChallengeJson())}),
    );
    expect(find.text('Daftar Alumni'), findsOneWidget);
    expect(find.bySemanticsLabel('Langkah 1 dari 4: Data Diri'), findsOneWidget);
    expect(find.textContaining('KTP'), findsNothing);

    await fillForm(tester);
    expect(find.text('Perhitungan Tahun Akademik'), findsOneWidget);
    expect(find.text('2019'), findsOneWidget);
    expect(find.text('2025'), findsNWidgets(2));

    await scrollAndTap(tester, submit);
    await settle(tester);

    final request = app.adapter.requestsTo('/auth/register').single;
    expect(request.headers['Idempotency-Key'], isA<String>());
    expect(request.data, {
      'full_name': 'Ahmad Islam',
      'gender': 'male',
      'email': 'ahmad.islam@email.com',
      'password': 'Rahasia#123',
      'cohort': 29,
      'class_in': 1,
      'class_out': 6,
      // Nilai kanonis dari server (`consent.policy_version`), dikirim apa adanya (F-01, kontrak C4).
      'accept_policy_version': testPolicyVersion,
    });
    expect(app.location, '/register/otp');
    expect(app.container.read(sessionProvider).challenge?.challengeId, 'challenge-1');
  });

  testWidgets('kebijakan diperbarui saat mengisi (409 VERSION_CONFLICT): versi dimuat ulang, setujui kembali', (
    tester,
  ) async {
    var policy = testPolicyVersion;
    final app = await openRegister(
      tester,
      apiRoutes({
        '/public/pages': (_) => FakeResponse.json(200, publicPageListJson(policyVersion: policy)),
        '/auth/register': (options) {
          final sent = (options.data as Map)['accept_policy_version'];
          if (sent != policy) {
            return FakeResponse.json(
              409,
              errorJson('VERSION_CONFLICT', 'Versi kebijakan sudah berubah.', current: {'policy_version': policy}),
            );
          }
          return FakeResponse.json(201, otpChallengeJson());
        },
      }),
    );
    await fillForm(tester);
    policy = 'privacy:3;terms:1';
    await scrollAndTap(tester, submit);
    await settle(tester);

    await scrollTo(tester, find.textContaining('baru saja diperbarui'));
    expect(find.textContaining('Baca ulang lalu setujui kembali'), findsOneWidget);
    expect(app.location, '/register');
    // Persetujuan direset: kirim lagi tanpa mencentang ditolak lokal.
    await scrollAndTap(tester, submit);
    await settle(tester);
    expect(app.adapter.requestsTo('/auth/register'), hasLength(1));

    await scrollAndTap(tester, find.byKey(const ValueKey('register-consent')));
    await settle(tester);
    await scrollAndTap(tester, submit);
    await settle(tester);
    expect(app.adapter.requestsTo('/auth/register').last.data, containsPair('accept_policy_version', policy));
    expect(app.location, '/register/otp');
  });

  testWidgets('dokumen legal belum terbit (policy_version null): pendaftaran belum dibuka', (tester) async {
    final app = await openRegister(
      tester,
      apiRoutes({'/public/pages': (_) => FakeResponse.json(200, publicPageListJson(policyVersion: null))}),
    );
    await scrollTo(tester, find.text(registrationClosedMessage));
    expect(find.text(registrationClosedMessage), findsOneWidget);
    await fillForm(tester);
    await scrollAndTap(tester, submit);
    await settle(tester);
    expect(app.adapter.requestsTo('/auth/register'), isEmpty);
    expect(find.text(registrationClosedMessage), findsNWidgets(2));
  });

  testWidgets('jaringan putus lalu kirim ulang memakai Idempotency-Key yang sama (AC F01-4)', (tester) async {
    var attempts = 0;
    final app = await openRegister(
      tester,
      apiRoutes({
        '/auth/register': (_) => ++attempts == 1 ? FakeResponse.network() : FakeResponse.json(201, otpChallengeJson()),
      }),
    );
    await fillForm(tester);
    await scrollAndTap(tester, submit);
    await settle(tester);
    expect(find.textContaining('Tidak dapat terhubung'), findsOneWidget);
    expect(find.text('Ahmad Islam'), findsOneWidget, reason: 'isian tetap tersimpan setelah gagal jaringan (PRD 4.5)');

    await scrollAndTap(tester, submit);
    await settle(tester);

    final keys = app.adapter.requestsTo('/auth/register').map((r) => r.headers['Idempotency-Key']).toList();
    expect(keys, hasLength(2));
    expect(keys.first, keys.last);
    expect(app.location, '/register/otp');
  });

  testWidgets('email terdaftar: galat server di field email', (tester) async {
    await openRegister(
      tester,
      apiRoutes({
        '/auth/register': (_) => FakeResponse.json(
          409,
          errorJson(
            'VALIDATION_ERROR',
            'Periksa isian.',
            fieldErrors: {
              'email': ['Email sudah terdaftar'],
            },
          ),
        ),
      }),
    );
    await fillForm(tester);
    await scrollAndTap(tester, submit);
    await settle(tester);
    await scrollTo(tester, find.text('Email sudah terdaftar'));
    expect(find.text('Email sudah terdaftar'), findsOneWidget);
  });

  testWidgets('validasi lokal dan persetujuan wajib sebelum mengirim', (tester) async {
    final app = await openRegister(tester, apiRoutes({}));
    await scrollAndTap(tester, submit);
    await settle(tester);
    expect(app.adapter.requestsTo('/auth/register'), isEmpty);
    expect(find.text('Setujui Kebijakan Privasi dan Ketentuan untuk melanjutkan.'), findsOneWidget);
    await scrollTo(tester, find.text('Isi nama lengkap'));
    expect(find.text('Isi nama lengkap'), findsOneWidget);
  });

  testWidgets('versi kebijakan gagal dimuat: peringatan dengan coba lagi', (tester) async {
    await openRegister(tester, apiRoutes({'/public/pages': (_) => FakeResponse.network()}));
    await scrollTo(tester, find.text('Versi kebijakan belum dapat dimuat. Periksa koneksi Anda.'));
    expect(find.text('Versi kebijakan belum dapat dimuat. Periksa koneksi Anda.'), findsOneWidget);
  });

  testWidgets('penghitung sandi menunjukkan kemajuan menuju minimum 8 (guideline hal. 5 "0/8" merah)', (tester) async {
    await openRegister(tester, apiRoutes({}));
    await scrollTo(tester, fieldOf('register-password'));
    Color counterColor(String text) => tester.widget<Text>(find.text(text)).style!.color!;

    expect(find.text('0/8'), findsOneWidget);
    expect(counterColor('0/8'), KapdhColors.danger);
    await tester.enterText(fieldOf('register-password'), 'Kapdh');
    await tester.pump();
    expect(find.text('5/8'), findsOneWidget);
    await tester.enterText(fieldOf('register-password'), 'Kapdh#2026');
    await tester.pump();
    expect(find.text('8/8'), findsOneWidget);
    expect(counterColor('8/8'), KapdhColors.textMuted);
    expect(find.textContaining('/72'), findsNothing, reason: 'batas 72 byte baru tampil saat mendekatinya');
  });

  testWidgets('teks 200 % tanpa meluap', (tester) async {
    await openRegister(tester, apiRoutes({}), textScale: 2);
    expect(tester.takeException(), isNull);
    await scrollTo(tester, submit);
    expect(tester.takeException(), isNull);
  });

  group('Idempotency-Key per payload (PRD 4.3, AC F01-4)', () {
    testWidgets('AC F01-4: payload berubah membuat key baru; payload sama memakai key yang sama', (tester) async {
      final app = await openRegister(tester, apiRoutes({'/auth/register': (_) => FakeResponse.network()}));
      await fillForm(tester);
      await scrollAndTap(tester, submit);
      await settle(tester);
      await scrollAndTap(tester, submit);
      await settle(tester);

      await scrollTo(tester, fieldOf('register-email'));
      await tester.enterText(fieldOf('register-email'), 'ahmad.lain@email.com');
      // Field yang fokus menggulir dirinya kembali ke layar; lepaskan fokus sebelum mengetuk tombol.
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      await scrollAndTap(tester, submit);
      await settle(tester);

      final keys = app.adapter.requestsTo('/auth/register').map((r) => r.headers['Idempotency-Key']).toList();
      expect(keys, hasLength(3));
      expect(keys[0], keys[1], reason: 'payload sama setelah jaringan putus');
      expect(
        keys[2],
        isNot(keys[0]),
        reason: 'payload berbeda tidak boleh memakai key lama (409 IDEMPOTENCY_CONFLICT)',
      );
    });

    testWidgets('AC F01-4: key tersimpan di secure storage dan dipakai lagi setelah aplikasi dimulai ulang', (
      tester,
    ) async {
      final store = MemorySecureStore();
      final first = await pumpApp(
        tester,
        store: store,
        handler: apiRoutes({'/auth/register': (_) => FakeResponse.network()}),
      );
      first.router.go('/register');
      await settle(tester);
      await fillForm(tester);
      await scrollAndTap(tester, submit);
      await settle(tester);
      final firstKey = first.adapter.requestsTo('/auth/register').single.headers['Idempotency-Key'];

      // Aplikasi ditutup lalu dibuka lagi dengan penyimpanan perangkat yang sama.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      final second = await pumpApp(
        tester,
        store: store,
        handler: apiRoutes({'/auth/register': (_) => FakeResponse.json(201, otpChallengeJson())}),
      );
      second.router.go('/register');
      await settle(tester);
      await fillForm(tester);
      await scrollAndTap(tester, submit);
      await settle(tester);
      expect(second.adapter.requestsTo('/auth/register').single.headers['Idempotency-Key'], firstKey);
      expect(second.location, '/register/otp');
      // Hasil pasti: key dilepas, dan sandi tidak pernah ditulis ke penyimpanan perangkat.
      expect(store.values.values.any((v) => v.contains('Rahasia#123')), isFalse);
      expect(second.container.read(activationCredentialsProvider)?.email, 'ahmad.islam@email.com');
    });
  });

  group('persetujuan legal (F-01, N-15)', () {
    testWidgets('F-01: tautan baca membuka halaman legal dan versi yang disetujui ditampilkan', (tester) async {
      final app = await openRegister(tester, apiRoutes({}));
      await scrollTo(tester, find.byKey(const ValueKey('register-read-privacy')));
      expect(find.text('Versi yang disetujui: Kebijakan Privasi versi 2 · Ketentuan versi 1'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('register-read-privacy')));
      await settle(tester);
      expect(app.location, '/legal/kebijakan-privasi');
      app.router.pop();
      await settle(tester);

      await scrollAndTap(tester, find.byKey(const ValueKey('register-read-terms')));
      await settle(tester);
      expect(app.location, '/legal/ketentuan');
      app.router.pop();
      await settle(tester);
      expect(app.location, '/register');
    });

    testWidgets('F-01: versi terbit di /public/config berubah: persetujuan dimuat ulang dan centang dilepas', (
      tester,
    ) async {
      var privacy = '2';
      final app = await openRegister(
        tester,
        apiRoutes({
          '/public/config': (_) => FakeResponse.json(200, {
            ...publicConfigJson(),
            'legal': {'privacy_version': privacy, 'terms_version': '1', 'community_version': '1'},
          }),
          '/public/pages': (_) => FakeResponse.json(200, {
            ...publicPageListJson(policyVersion: 'privacy:$privacy;terms:1'),
            'consent': {'policy_version': 'privacy:$privacy;terms:1', 'privacy_version': privacy, 'terms_version': '1'},
          }),
          '/auth/register': (_) => FakeResponse.json(201, otpChallengeJson()),
        }),
      );
      await fillForm(tester);
      expect(tester.widget<CheckboxListTile>(find.byKey(const ValueKey('register-consent'))).value, isTrue);

      // Pengurus menerbitkan Kebijakan Privasi versi 3; gerbang aplikasi membaca ulang /public/config.
      privacy = '3';
      final checking = app.container.read(appGateProvider.notifier).check();
      await settle(tester);
      await checking;
      await settle(tester);

      expect(tester.widget<CheckboxListTile>(find.byKey(const ValueKey('register-consent'))).value, isFalse);
      await scrollTo(tester, find.text(policyChangedMessage));
      expect(find.text(policyChangedMessage), findsOneWidget);
      expect(find.text('Versi yang disetujui: Kebijakan Privasi versi 3 · Ketentuan versi 1'), findsOneWidget);

      await scrollAndTap(tester, submit);
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/register'), isEmpty, reason: 'versi baru belum disetujui');

      await scrollAndTap(tester, find.byKey(const ValueKey('register-consent')));
      await settle(tester);
      await scrollAndTap(tester, submit);
      await settle(tester);
      expect(
        app.adapter.requestsTo('/auth/register').single.data,
        containsPair('accept_policy_version', 'privacy:3;terms:1'),
      );
    });

    testWidgets('centang nonaktif selama versi persetujuan belum dimuat', (tester) async {
      await openRegister(tester, apiRoutes({'/public/pages': (_) => FakeResponse.network()}));
      await scrollTo(tester, find.byKey(const ValueKey('register-consent')));
      expect(tester.widget<CheckboxListTile>(find.byKey(const ValueKey('register-consent'))).onChanged, isNull);
    });
  });
}
