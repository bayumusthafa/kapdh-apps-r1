import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/features/legal/legal_page_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../account/account_fixtures.dart';

Map<String, Object?> _page({String slug = 'kebijakan-privasi', String body = '<p>Isi kebijakan.</p>'}) => {
  'slug': slug,
  'title': 'Kebijakan Privasi',
  'body_html': body,
  'version': '3',
  'published_at': iso(DateTime.utc(2026, 10, 1, 3)),
  'legal_document': 'privacy',
};

void main() {
  Future<AppHarness> openLegal(WidgetTester tester, FakeHandler page, {double textScale = 1}) async {
    final app = await pumpApp(
      tester,
      textScale: textScale,
      handler: apiRoutes({'/public/pages/kebijakan-privasi': page}),
    );
    app.router.push('/legal/kebijakan-privasi');
    await settle(tester);
    return app;
  }

  testWidgets('F-08: versi tayang dirender tanpa login (judul, versi, tanggal terbit, isi)', (tester) async {
    final app = await openLegal(
      tester,
      (_) => FakeResponse.json(200, _page(body: '<h2>Data yang kami simpan</h2><p>Kami tidak menyimpan NIK.</p>')),
    );
    expect(app.location, '/legal/kebijakan-privasi');
    expect(find.text('Kebijakan Privasi'), findsWidgets);
    expect(find.text('Versi 3 · diterbitkan 1 Okt 2026'), findsOneWidget);
    expect(find.text('Data yang kami simpan', findRichText: true), findsOneWidget);
    expect(find.text('Kami tidak menyimpan NIK.', findRichText: true), findsOneWidget);
  });

  testWidgets('halaman belum terbit (404) menjelaskan dan menampilkan kontak bantuan', (tester) async {
    await openLegal(tester, (_) => FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ditemukan.')));
    expect(find.text('Halaman belum tersedia'), findsOneWidget);
    expect(find.text('Butuh bantuan?'), findsOneWidget);
  });

  testWidgets('PRD 4.5: jaringan putus dibedakan dari tidak ditemukan dan dapat dicoba lagi', (tester) async {
    var calls = 0;
    await openLegal(tester, (_) {
      calls++;
      return calls == 1 ? FakeResponse.network() : FakeResponse.json(200, _page());
    });
    expect(find.text('Tidak ada koneksi'), findsOneWidget);
    await tester.tap(find.text('Coba lagi'));
    await settle(tester);
    expect(find.text('Isi kebijakan.', findRichText: true), findsOneWidget);
  });

  testWidgets('tautan https di isi halaman dibuka di aplikasi luar', (tester) async {
    final app = await openLegal(
      tester,
      (_) => FakeResponse.json(
        200,
        _page(body: '<p>Lihat <a href="https://kapdh.or.id/kontak" data-external="true">kontak resmi</a>.</p>'),
      ),
    );
    await tester.tapOnText(find.textRange.ofSubstring('kontak resmi'));
    await settle(tester);
    expect(app.launched, [Uri.parse('https://kapdh.or.id/kontak')]);
  });

  test('N-09: hanya https berhost dan mailto yang boleh dibuka', () {
    expect(legalExternalLink('https://kapdh.or.id/a'), Uri.parse('https://kapdh.or.id/a'));
    expect(legalExternalLink('mailto:bantuan@kapdh.or.id'), isNotNull);
    expect(legalExternalLink('javascript:alert(1)'), isNull);
    expect(legalExternalLink('http://kapdh.or.id'), isNull);
    expect(legalExternalLink('intent://scan#Intent;end'), isNull);
    expect(legalExternalLink('/legal/ketentuan'), isNull);
  });

  testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
    await openLegal(tester, (_) => FakeResponse.json(200, _page()), textScale: 2);
    expect(tester.takeException(), isNull);
  });
}
