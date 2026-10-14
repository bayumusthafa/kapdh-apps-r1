import 'package:flutter/widgets.dart' show ObjectKey;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_mobile/app/app.dart';
import 'package:kapdh_mobile/app/router.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';
import 'package:kapdh_mobile/core/ui/external_links.dart';

import 'fakes.dart';
import 'widget_harness.dart';

/// Aplikasi lengkap untuk uji layar: router, redirect, gerbang dan sesi asli; HTTP lewat [FakeHttpAdapter].
class AppHarness {
  AppHarness._(this.container, this.adapter, this.clock, this.launched);

  final ProviderContainer container;
  final FakeHttpAdapter adapter;
  final TestClock clock;

  /// Tautan luar yang dibuka (toko aplikasi, email, WhatsApp).
  final List<Uri> launched;

  GoRouter get router => container.read(routerProvider);

  /// Lokasi halaman teratas (termasuk rute yang di-push).
  String get location => router.state.uri.toString();
}

/// Token sesi tersimpan (pengguna pernah login di perangkat ini).
StoredTokens savedTokens() => StoredTokens(
  accessToken: 'access-1',
  accessExpiresAt: testNow.add(const Duration(minutes: 10)),
  refreshToken: 'refresh-1',
);

/// Menjalankan [KapdhApp] mulai dari splash sampai tenang. [tokens] diisi bila sesi tersimpan.
Future<AppHarness> pumpApp(
  WidgetTester tester, {
  required FakeHandler handler,
  StoredTokens? tokens,
  SecureStore? store,
  TestClock? clock,
  double textScale = 1,
  List<Override> overrides = const [],
  Future<void> Function(ProviderContainer container)? beforeStart,
  bool settle = true,
}) async {
  usePhoneSize(tester);
  if (textScale != 1) {
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  }
  final adapter = FakeHttpAdapter(handler);
  final testClock = clock ?? TestClock();
  final launched = <Uri>[];
  final container = makeContainer(
    adapter: adapter,
    store: store ?? MemorySecureStore(),
    clock: testClock,
    overrides: [
      externalLinkLauncherProvider.overrideWithValue((uri) async {
        launched.add(uri);
        return true;
      }),
      ...overrides,
    ],
  );
  if (tokens != null) await container.read(tokenStoreProvider).save(tokens);
  if (beforeStart != null) await beforeStart(container);
  // Kunci per container: pumpApp berulang dalam satu uji memasang pohon dan scope baru. Tanpa kunci Flutter hanya
  // memperbarui scope lama sehingga container baru tidak mendapat vsync Flutter dan penghapusan provider autoDispose
  // saat pohon dibongkar memakai Timer yang tertinggal sesudah uji selesai.
  await tester.pumpWidget(
    UncontrolledProviderScope(
      key: ObjectKey(container),
      container: container,
      child: const KapdhApp(enableSessionServices: false),
    ),
  );
  if (settle) await _settle(tester);
  return AppHarness._(container, adapter, testClock, launched);
}

/// Versi persetujuan registrasi bawaan uji (`LegalConsentVersions.policy_version`, kontrak C4).
const testPolicyVersion = 'privacy:2;terms:1';

/// Penangan HTTP umum: konfigurasi publik normal dan halaman legal terbit (GET /public/pages beserta `consent`,
/// GET /public/pages/{slug}); sisanya dari [routes].
FakeHandler apiRoutes(Map<String, FakeHandler> routes, {Map<String, Object?>? config}) => (options) {
  final handler = routes[options.path];
  if (handler != null) return handler(options);
  if (options.path == '/public/config') return FakeResponse.json(200, config ?? publicConfigJson());
  if (options.path == '/public/pages') return FakeResponse.json(200, publicPageListJson());
  if (options.path.startsWith('/public/pages/')) {
    final slug = options.path.substring('/public/pages/'.length);
    return FakeResponse.json(200, {
      'slug': slug,
      'title': slug,
      'body_html': '<p>$slug</p>',
      'version': '1',
      'published_at': testNow.toIso8601String(),
      'legal_document': switch (slug) {
        'kebijakan-privasi' => 'privacy',
        'ketentuan' => 'terms',
        'ketentuan-komunitas' => 'community',
        _ => null,
      },
    });
  }
  return FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ditemukan (uji): ${options.path}'));
};

/// `PublicPageList` (GET /public/pages): halaman legal terbit dan `consent`. [policyVersion] null = salah satu
/// dokumen legal belum terbit sehingga pendaftaran belum dibuka.
Map<String, Object?> publicPageListJson({String? policyVersion = testPolicyVersion}) => {
  'items': [
    {
      'slug': 'kebijakan-privasi',
      'title': 'Kebijakan Privasi',
      'version': '2',
      'published_at': testNow.toIso8601String(),
      'legal_document': 'privacy',
    },
    if (policyVersion != null)
      {
        'slug': 'ketentuan',
        'title': 'Ketentuan Layanan',
        'version': '1',
        'published_at': testNow.toIso8601String(),
        'legal_document': 'terms',
      },
  ],
  'consent': {
    'policy_version': policyVersion,
    'privacy_version': '2',
    'terms_version': policyVersion == null ? null : '1',
  },
};

/// Menunggu animasi, request HTTP palsu dan timer nol-durasi selesai (pumpAndSettle saja dapat menyisakan timer dio
/// yang dibuat pada frame terakhir).
Future<void> settle(WidgetTester tester) => _settle(tester);

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pumpAndSettle();
    await tester.pump(const Duration(milliseconds: 20));
  }
}

/// Menggulir sampai [finder] terlihat.
Future<void> scrollTo(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await settle(tester);
}

/// Menggulir sampai [finder] terlihat lalu mengetuknya.
Future<void> scrollAndTap(WidgetTester tester, Finder finder) async {
  await scrollTo(tester, finder);
  await tester.tap(finder);
}
