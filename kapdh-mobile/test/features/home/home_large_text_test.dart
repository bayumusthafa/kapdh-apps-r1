// N-11 teks besar di ponsel sempit: Beranda aktif lengkap (akses cepat, banner tautan luar, pengingat perpanjang,
// event, berita), feed kosong, galat tanpa cache, dan Beranda terkunci pada layar 320 dan 360 dp dengan skala teks
// 130 % dan 200 %. Ukuran layar dipasang sebelum frame pertama (pumpMemberApp size): overflow RenderFlex hanya
// dilaporkan sekali per objek render, jadi mengecilkan layar sesudah pump dapat menyembunyikannya.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/design/design.dart' show KapdhButton;
import 'package:kapdh_mobile/features/home/shared/content_widgets.dart' show HomeSectionTitle;

import '../../support/fakes.dart';
import 'content_fixtures.dart';
import 'feature_harness.dart';

const _widths = [320.0, 360.0];
const _scales = [1.3, 2.0];

const _externalTitle = 'Donasi Pembangunan Asrama Pondok';
const _eventTitles = ['Camping Alumni KAPDH di Bumi Perkemahan Cibubur', 'Kajian Rutin'];
const _postTitles = [
  'Halal Bihalal Alumni 2026 di Aula Pondok Pesantren',
  'Pengumuman Iuran Tahunan Anggota',
  'Silaturahmi',
];

/// Beranda anggota expiring (semua bagian Beranda aktif plus pengingat perpanjang) dengan judul panjang.
Map<String, Object?> _fullHome() => homeJson(
  status: 'expiring',
  expiresAt: DateTime.utc(2026, 11, 1, 5),
  banners: [
    bannerJson(title: _externalTitle, type: 'url', route: null, url: 'https://example.org'),
    bannerJson(id: 'banner-2', title: 'Reuni Akbar Alumni Darel Hikmah 2026'),
  ],
  events: [
    homeEventJson(title: _eventTitles[0]),
    homeEventJson(id: 'event-2', title: _eventTitles[1], price: '0.00', registrationState: 'closed'),
  ],
  posts: [
    for (final (index, title) in _postTitles.indexed)
      postSummaryJson(id: 'post-$index', slug: 'berita-$index', title: title),
  ],
);

/// [inner] seluruhnya di dalam [outer] (toleransi pembulatan subpiksel).
bool _inside(Rect outer, Rect inner) =>
    inner.left >= outer.left - 0.01 &&
    inner.top >= outer.top - 0.01 &&
    inner.right <= outer.right + 0.01 &&
    inner.bottom <= outer.bottom + 0.01;

void main() {
  for (final width in _widths) {
    for (final scale in _scales) {
      group('N-11 layar ${width.toInt()} dp, teks ${(scale * 100).round()} %', () {
        final size = Size(width, 780);

        /// [finder] terlihat utuh selebar layar (tidak terdorong keluar tepi kanan).
        void expectOnScreen(WidgetTester tester, Finder finder, String what) {
          expect(finder, findsOneWidget, reason: what);
          final rect = tester.getRect(finder);
          expect(rect.left >= -0.01 && rect.right <= width + 0.01, isTrue, reason: '$what di dalam layar: $rect');
        }

        testWidgets('Beranda aktif lengkap tanpa meluap; akses cepat, banner, judul bagian, event dan berita terbaca', (
          tester,
        ) async {
          await pumpMemberApp(
            tester,
            status: 'expiring',
            size: size,
            textScale: scale,
            routes: {'/home': (_) => FakeResponse.json(200, _fullHome())},
          );
          expect(tester.takeException(), isNull);
          expectOnScreen(tester, find.text('Ahmad Islam'), 'nama di kepala');

          // Akses cepat: label tiap ubin di dalam ubinnya, ubin tetap target sentuh 48.
          for (final (key, label) in [
            ('quick-messages', 'Pesan'),
            ('quick-notifications', 'Notifikasi'),
            ('quick-tickets', 'Tiket Saya'),
            ('quick-news', 'Berita'),
          ]) {
            final tile = tester.getRect(find.byKey(ValueKey(key)));
            final text = find.descendant(of: find.byKey(ValueKey(key)), matching: find.text(label));
            expectOnScreen(tester, text, 'label akses cepat "$label"');
            expect(_inside(tile, tester.getRect(text)), isTrue, reason: '"$label" di dalam ubinnya');
            expect(tile.width, greaterThanOrEqualTo(KapdhSize.touchTargetMin));
            expect(tile.height, greaterThanOrEqualTo(KapdhSize.touchTargetMin));
          }

          // Banner tautan luar: judul dan penanda utuh di dalam ubin; judul tidak dihimpit penanda sampai lebih sempit
          // darinya (judul tetap terbaca).
          final banner = find.bySemanticsLabel('Banner 1 dari 2: $_externalTitle');
          final tile = tester.getRect(banner);
          final title = tester.getRect(find.text(_externalTitle));
          final pill = tester.getRect(find.text('Tautan luar'));
          expect(_inside(tile, title), isTrue, reason: 'judul banner di dalam ubin: $title, ubin $tile');
          expect(_inside(tile, pill), isTrue, reason: '"Tautan luar" di dalam ubin: $pill, ubin $tile');
          expect(title.width, greaterThanOrEqualTo(pill.width), reason: 'judul banner tidak dihimpit penanda');
          expect(tester.getSemantics(banner).hint, 'membuka tautan luar');

          await scrollUntil(tester, find.text('Masa aktif KTA segera berakhir'));
          expectOnScreen(tester, find.widgetWithText(FilledButton, 'Perpanjang'), 'tombol Perpanjang');

          for (final (section, titles) in [('Event Mendatang', _eventTitles), ('Berita Terbaru', _postTitles)]) {
            await scrollUntil(tester, find.text(section));
            expect(tester.takeException(), isNull);
            final heading = tester.getRect(find.text(section));
            expect(heading.right, lessThanOrEqualTo(width - KapdhSpace.s5 + 0.01), reason: '"$section" utuh');
            final action = find.descendant(
              of: find.ancestor(of: find.text(section), matching: find.byType(HomeSectionTitle)),
              matching: find.widgetWithText(TextButton, 'Lihat semua'),
            );
            final rect = tester.getRect(action);
            expect(rect.width, greaterThanOrEqualTo(KapdhSize.touchTargetMin));
            expect(rect.height, greaterThanOrEqualTo(KapdhSize.touchTargetMin));
            expect(rect.right, lessThanOrEqualTo(width - KapdhSpace.s5 + 0.01), reason: '"Lihat semua" di dalam layar');
            for (final item in titles) {
              await scrollUntil(tester, find.text(item));
              expect(tester.takeException(), isNull);
              expectOnScreen(tester, find.text(item), '"$item"');
            }
          }
        });

        // Keadaan kosong dan galat tanpa cache: tombol KapdhButton outlined di bawah pesan (label membungkus, N-11).
        for (final (kind, message, action) in [
          ('feed kosong', 'Belum ada kabar terbaru', 'Muat ulang'),
          ('galat tanpa cache', 'Tidak ada koneksi', 'Coba lagi'),
        ]) {
          testWidgets('Beranda $kind tanpa meluap; pesan dan tombol "$action" terbaca', (tester) async {
            await pumpMemberApp(
              tester,
              size: size,
              textScale: scale,
              routes: {
                '/home': (_) =>
                    kind == 'feed kosong' ? FakeResponse.json(200, emptyHomeJson()) : FakeResponse.network(),
              },
            );
            expect(tester.takeException(), isNull);
            expectOnScreen(tester, find.text(message), 'pesan $kind');
            await tester.ensureVisible(find.text(action));
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
            expectOnScreen(tester, find.text(action), 'label "$action"');
            final button = tester.getRect(find.ancestor(of: find.text(action), matching: find.byType(KapdhButton)));
            expect(_inside(button, tester.getRect(find.text(action))), isTrue, reason: '"$action" di dalam tombolnya');
            expect(button.left >= -0.01 && button.right <= width + 0.01, isTrue, reason: 'tombol di dalam layar');
            expect(button.width, greaterThanOrEqualTo(KapdhSize.touchTargetMin));
            expect(button.height, greaterThanOrEqualTo(KapdhSize.touchTargetMin));
          });
        }

        for (final (status, heading, action) in [
          ('unverified', 'KTA Anda belum aktif', 'Selesaikan Iuran Pendaftaran'),
          ('expired', 'Masa keanggotaan berakhir', 'Perpanjang Keanggotaan'),
        ]) {
          testWidgets('Beranda terkunci $status tanpa meluap; status, ajakan dan akses cepat terbaca', (tester) async {
            await pumpMemberApp(tester, status: status, location: '/home', push: false, size: size, textScale: scale);
            expect(tester.takeException(), isNull);
            expectOnScreen(tester, find.text(heading), 'judul status');
            expectOnScreen(tester, find.text(action), 'tombol ajakan');
            for (final key in ['quick-kta', 'quick-notifications', if (status == 'expired') 'quick-tickets']) {
              await scrollUntil(tester, find.byKey(ValueKey(key)));
              expect(tester.takeException(), isNull);
              expectOnScreen(tester, find.byKey(ValueKey(key)), 'akses cepat $key');
            }
          });
        }
      });
    }
  }

  group('Teks 100 %: keterangan banner tetap tata letak v2', () {
    // Keterangan v2: Positioned kiri s3, kanan 52 (s3 + ruang titik halaman), bawah s3; Row rata bawah berisi judul
    // Expanded, jarak s2, lalu penanda.
    const captionRight = 52.0;
    for (final width in [320.0, 390.0]) {
      testWidgets('layar ${width.toInt()} dp: penanda "Tautan luar" di samping kanan judul', (tester) async {
        await pumpMemberApp(
          tester,
          status: 'expiring',
          size: Size(width, 780),
          routes: {'/home': (_) => FakeResponse.json(200, _fullHome())},
        );
        expect(tester.takeException(), isNull);
        final tile = tester.getRect(find.bySemanticsLabel('Banner 1 dari 2: $_externalTitle'));
        final title = tester.getRect(find.text(_externalTitle));
        final pill = tester.getRect(
          find.ancestor(of: find.text('Tautan luar'), matching: find.byType(Container)).first,
        );
        expect(title.left, closeTo(tile.left + KapdhSpace.s3, 0.01));
        expect(pill.left, closeTo(title.right + KapdhSpace.s2, 0.01));
        expect(pill.right, closeTo(tile.right - captionRight, 0.01));
        expect(title.bottom, closeTo(tile.bottom - KapdhSpace.s3, 0.01));
        expect(pill.bottom, closeTo(tile.bottom - KapdhSpace.s3, 0.01));
        // Banner tanpa penanda: judul selebar keterangan.
        final plainTile = tester.getRect(find.bySemanticsLabel(RegExp('^Banner 2 dari 2')));
        final plainTitle = tester.getRect(find.text('Reuni Akbar Alumni Darel Hikmah 2026'));
        expect(plainTitle.left, closeTo(plainTile.left + KapdhSpace.s3, 0.01));
        expect(plainTitle.right, closeTo(plainTile.right - captionRight, 0.01));
        expect(plainTitle.bottom, closeTo(plainTile.bottom - KapdhSpace.s3, 0.01));
      });
    }
  });
}
