import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../support/fakes.dart';
import '../support/widget_harness.dart';

void main() {
  group('EmptyState, ErrorState, LoadingSkeleton (N-03)', () {
    testWidgets('kosong dengan tindakan', (tester) async {
      var acted = 0;
      await pumpDesign(
        tester,
        EmptyState(
          title: 'Belum ada notifikasi',
          message: 'Kabar resmi muncul di sini.',
          actionLabel: 'Muat ulang',
          onAction: () => acted++,
        ),
        scaffold: false,
      );
      expect(find.text('Belum ada notifikasi'), findsOneWidget);
      await tester.tap(find.text('Muat ulang'));
      expect(acted, 1);
    });

    testWidgets('galat jaringan dibedakan dari tidak ditemukan; tidak ditemukan tanpa coba lagi', (tester) async {
      await pumpDesign(tester, ErrorState.fromException(networkError(), onRetry: () {}), scaffold: false);
      expect(find.text('Tidak ada koneksi'), findsOneWidget);
      expect(find.text('Coba lagi'), findsOneWidget);

      await pumpDesign(
        tester,
        ErrorState.fromException(apiError(404, 'NOT_FOUND', 'Berita tidak ditemukan.'), onRetry: () {}),
        scaffold: false,
      );
      expect(find.text('Data tidak ditemukan'), findsOneWidget);
      expect(find.text('Coba lagi'), findsNothing);
      expect(find.text('Kode bantuan: req-uji-1'), findsOneWidget);
    });

    testWidgets('kerangka pemuatan diumumkan "Memuat"', (tester) async {
      await pumpDesign(tester, const LoadingSkeleton(), scaffold: false);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.bySemanticsLabel('Memuat'), findsOneWidget);
    });
  });

  testWidgets('AppScaffold: app bar putih, judul tengah, kembali ke lokasi cadangan bila tidak ada riwayat', (
    tester,
  ) async {
    usePhoneSize(tester);
    final router = GoRouter(
      initialLocation: '/detail',
      routes: [
        GoRoute(path: '/', builder: (_, _) => const Text('beranda')),
        GoRoute(
          path: '/detail',
          builder: (_, _) => AppScaffold(
            title: 'Kartu Tanda Anggota',
            banner: OfflineBanner(syncedAt: testNow),
            body: const Text('isi'),
          ),
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    expect(find.text('Kartu Tanda Anggota'), findsOneWidget);
    expect(find.textContaining('Offline'), findsOneWidget);
    // Panah kiri di app bar (prototipe layar 6, 7; guideline hal. 6).
    expect(find.byIcon(KapdhIcons.arrowBack), findsOneWidget);
    expect(find.byIcon(KapdhIcons.chevronLeft), findsNothing);
    await tester.tap(find.byTooltip('Kembali'));
    await tester.pumpAndSettle();
    expect(find.text('beranda'), findsOneWidget);
  });

  testWidgets('AppScaffold: panah kembali menghormati PopScope halaman seperti tombol kembali sistem (PRD 4.5)', (
    tester,
  ) async {
    usePhoneSize(tester);
    var guarded = true;
    var asked = 0;
    StateSetter? setFormState;
    final router = GoRouter(
      routes: [
        GoRoute(path: '/', builder: (_, _) => const Text('beranda')),
        GoRoute(
          path: '/form',
          builder: (_, _) => StatefulBuilder(
            builder: (context, setState) {
              setFormState = setState;
              return PopScope(
                canPop: !guarded,
                onPopInvokedWithResult: (didPop, _) {
                  if (!didPop) asked++;
                },
                child: const AppScaffold(title: 'Formulir', body: Text('isi')),
              );
            },
          ),
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    router.go('/');
    await tester.pumpAndSettle();
    final pushed = router.push<void>('/form');
    await tester.pumpAndSettle();

    // Isian belum disimpan: PopScope menahan dan diberi tahu (dialog "Buang perubahan?" di layar nyata).
    await tester.tap(find.byTooltip('Kembali'));
    await tester.pumpAndSettle();
    expect(asked, 1);
    expect(find.text('Formulir'), findsOneWidget);

    // Setelah formulir bersih, panah kembali menutup halaman.
    setFormState!(() => guarded = false);
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Kembali'));
    await tester.pumpAndSettle();
    await pushed;
    expect(find.text('beranda'), findsOneWidget);
  });

  testWidgets('AppBannerScope: pita global di bawah app bar; pita milik layar menggantikannya (tanpa pita ganda)', (
    tester,
  ) async {
    usePhoneSize(tester);
    Widget app(Widget screen) => MaterialApp(
      builder: (context, child) => AppBannerScope(banner: const MaintenanceBanner(), child: child!),
      home: screen,
    );
    await tester.pumpWidget(app(const AppScaffold(title: 'Tiket', showBack: false, body: Text('isi'))));
    expect(find.byType(MaintenanceBanner), findsOneWidget);
    expect(find.textContaining('Perubahan data ditunda sementara.', findRichText: true), findsOneWidget);
    expect(
      tester.getTopLeft(find.byType(MaintenanceBanner)).dy,
      closeTo(tester.getBottomLeft(find.byType(AppBar)).dy, 1),
    );

    await tester.pumpWidget(
      app(
        AppScaffold(
          title: 'KTA',
          showBack: false,
          banner: OfflineBanner(syncedAt: testNow),
          body: const Text('isi'),
        ),
      ),
    );
    expect(find.byType(MaintenanceBanner), findsNothing);
    expect(find.byType(OfflineBanner), findsOneWidget);

    await tester.pumpWidget(
      app(const AppScaffold(title: 'Tanpa pita', showBack: false, showGlobalBanner: false, body: Text('isi'))),
    );
    expect(find.byType(MaintenanceBanner), findsNothing);
  });

  testWidgets('BrandSheetScaffold dan GreetingHeader (prototipe layar 4)', (tester) async {
    await pumpDesign(
      tester,
      const BrandSheetScaffold(
        header: GreetingHeader(name: 'Ahmad Islam'),
        body: Text('isi lembar'),
        bottomBar: Text('aksi bawah'),
      ),
      scaffold: false,
    );
    expect(find.text("Assalamu'alaikum,"), findsOneWidget);
    expect(find.text('Ahmad Islam'), findsOneWidget);
    expect(find.bySemanticsLabel('Logo KAPDH'), findsOneWidget);
    expect(find.text('aksi bawah'), findsOneWidget);
    expect(find.byType(CustomPaint), findsWidgets);
  });

  testWidgets('BrandHeader bermotif (guideline hal. 5)', (tester) async {
    await pumpDesign(tester, const BrandHeader(child: Text('Selamat')), scaffold: false);
    final paints = tester.widgetList<CustomPaint>(find.byType(CustomPaint));
    expect(paints.any((p) => p.painter is BrandPatternPainter), isTrue);
  });

  testWidgets('SectionHeader dan SupportContactCard', (tester) async {
    String? emailed;
    String? whatsapp;
    await pumpDesign(
      tester,
      Column(
        children: [
          SectionHeader(title: 'Riwayat', actionLabel: 'Lihat semua', onAction: () {}),
          SupportContactCard(
            email: null,
            whatsapp: '0812-3456-7890',
            onEmail: (v) => emailed = v,
            onWhatsApp: (v) => whatsapp = v,
          ),
        ],
      ),
    );
    expect(find.text('Lihat semua'), findsOneWidget);
    await tester.tap(find.text(SupportContactCard.fallbackEmail));
    await tester.tap(find.text('0812-3456-7890'));
    expect(emailed, 'bantuan@kapdh.or.id');
    expect(whatsapp, '0812-3456-7890');
  });

  testWidgets('UnderConstructionScreen jelas bertanda "Sedang dibangun"', (tester) async {
    await pumpDesign(
      tester,
      const UnderConstructionScreen(
        title: 'Beranda',
        feature: 'F-08',
        description: 'Banner dan berita.',
        showBack: false,
      ),
      scaffold: false,
    );
    expect(find.text('Sedang dibangun'), findsOneWidget);
    expect(find.text('Beranda (F-08)'), findsOneWidget);
    expect(find.byTooltip('Kembali'), findsNothing);
  });
}
