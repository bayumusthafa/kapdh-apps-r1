import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../support/a11y.dart';
import '../support/fakes.dart';
import '../support/test_images.dart';
import '../support/widget_harness.dart';

void main() {
  group('KtaCard (prototipe layar 6, 7; guideline hal. 6)', () {
    testWidgets('aktif: QR dari URL server, nomor, kode angkatan, kota dan masa berlaku', (tester) async {
      final card = cardOf(expiresAt: DateTime.utc(2027, 10, 12, 18));
      await pumpDesign(tester, KtaCard(data: KtaCardData.fromMemberCard(card)));

      expect(find.byType(QrImageView), findsOneWidget);
      expect(find.text('Ahmad Islam'), findsOneWidget);
      expect(find.text('Angkatan 29 | Guru Bahasa Arab'), findsOneWidget);
      expect(find.text('KAPDH 29'), findsOneWidget);
      expect(find.text('29.01.01.7'), findsOneWidget);
      expect(find.text('Pekanbaru'), findsOneWidget);
      expect(find.text('Berlaku sampai 13/10/2027'), findsOneWidget);
      expect(find.text('AI'), findsOneWidget);
      expect(
        find.bySemanticsLabel(RegExp(r'^Kartu Tanda Anggota\. Ahmad Islam.*Nomor anggota 29\.01\.01\.7')),
        findsOneWidget,
      );
    });

    testWidgets('tidak aktif: kotak QR tertutup dan "belum aktif"', (tester) async {
      final card = cardOf(status: 'inactive', withQr: false);
      await pumpDesign(tester, KtaCard(data: KtaCardData.fromMemberCard(card)));
      expect(find.byType(QrImageView), findsNothing);
      expect(find.text('QR muncul setelah KTA aktif'), findsOneWidget);
      expect(find.text('Berlaku sampai: belum aktif'), findsOneWidget);
      // Gembok emas 34 px (prototipe layar 6), bukan ikon QR.
      final lock = tester.widget<Icon>(
        find.descendant(of: find.byKey(const ValueKey('kta-qr-placeholder')), matching: find.byType(Icon)),
      );
      expect(lock.icon, Icons.lock_outline);
      expect(lock.size, 34);
      expect(lock.color, KapdhColors.accent);
    });

    testWidgets('offline dengan token QR kedaluwarsa: QR tidak ditampilkan', (tester) async {
      final card = cardOf(expiresAt: DateTime.utc(2027, 10, 12));
      await pumpDesign(tester, KtaCard(data: KtaCardData.fromMemberCard(card, qrUsable: false)));
      expect(find.byType(QrImageView), findsNothing);
      expect(find.text('Sinkronkan untuk memperbarui QR'), findsOneWidget);
    });

    testWidgets('kedaluwarsa: tanpa QR, ajakan perpanjang di kotak QR', (tester) async {
      final card = cardOf(status: 'expired', expiresAt: DateTime.utc(2026, 9, 1), withQr: false);
      await pumpDesign(tester, KtaCard(data: KtaCardData.fromMemberCard(card)));
      expect(find.text('QR aktif kembali setelah perpanjangan'), findsOneWidget);
      expect(find.text('Berakhir 01/09/2026'), findsOneWidget);
    });

    testWidgets('teks 200 % tanpa meluap', (tester) async {
      await pumpDesign(tester, KtaCard(data: KtaCardData.fromMemberCard(cardOf())), textScale: 2);
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets('KtaMiniCard (prototipe layar 2)', (tester) async {
    await pumpDesign(
      tester,
      KtaMiniCard(
        fullName: 'Ahmad Islam',
        subtitle: 'Angkatan 29 | Lulus 2025',
        memberNumber: '29.01.01.7',
        status: StatusStyles.card(MemberCardStatus.inactive),
      ),
    );
    expect(find.text('29.01.01.7'), findsOneWidget);
    expect(find.bySemanticsLabel('Status: KTA Tidak Aktif'), findsOneWidget);
  });

  testWidgets('StatusActionCard: aksi berdampingan, bertumpuk pada teks 200 %', (tester) async {
    var paid = 0;
    final widget = StatusActionCard(
      status: StatusStyles.card(MemberCardStatus.inactive),
      message: 'Selesaikan iuran pendaftaran untuk mengaktifkan KTA dan fitur alumni.',
      actionLabel: 'Bayar',
      onAction: () => paid++,
    );
    await pumpDesign(tester, widget);
    // Teks normal: aksi di kanan keterangan (prototipe layar 6).
    expect(tester.getTopLeft(find.text('Bayar')).dx, greaterThan(tester.getTopRight(find.byType(StatusBadge)).dx));
    await tester.tap(find.text('Bayar'));
    expect(paid, 1);

    await pumpDesign(tester, widget, textScale: 2);
    expect(tester.takeException(), isNull);
    expect(tester.getTopLeft(find.text('Bayar')).dy, greaterThan(tester.getBottomLeft(find.byType(StatusBadge)).dy));
  });

  group('UploadTile (prototipe layar 3)', () {
    testWidgets('kosong: ajakan memilih dan dapat diketuk', (tester) async {
      var picks = 0;
      await pumpDesign(tester, UploadTile(onPick: () => picks++));
      expect(find.text('Pilih bukti transfer'), findsOneWidget);
      await tester.tap(find.text('Pilih'));
      expect(picks, 1);
    });

    testWidgets('terpilih: nama, ukuran dan "Ganti"', (tester) async {
      await pumpDesign(tester, UploadTile(fileName: 'bukti-transfer.jpg', fileSizeBytes: 1258291, onPick: () {}));
      expect(find.text('bukti-transfer.jpg'), findsOneWidget);
      expect(find.text('1,2 MB'), findsOneWidget);
      expect(find.text('Ganti'), findsOneWidget);
      expect(find.byIcon(Icons.image_outlined), findsOneWidget);
    });

    testWidgets('garis putus-putus hijau terlihat di atas isian tile (prototipe layar 3)', (tester) async {
      final key = GlobalKey();
      await pumpDesign(
        tester,
        RepaintBoundary(
          key: key,
          child: SizedBox(width: 300, child: UploadTile(onPick: () {})),
        ),
      );
      final paint = tester.widget<CustomPaint>(
        find.descendant(of: find.byType(UploadTile), matching: find.byType(CustomPaint)).first,
      );
      expect(paint.foregroundPainter, isA<DashedBorderPainter>());
      expect(paint.painter, isNull);

      final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = (await tester.runAsync(() => boundary.toImage()))!;
      final bytes = (await tester.runAsync(() => image.toByteData(format: ui.ImageByteFormat.rawRgba)))!;
      bool isBorder(int x, int y) {
        final i = (y * image.width + x) * 4;
        // Garis primer #1A4B17 (gelap); isian green50 #F1F8F0 (terang).
        return bytes.getUint8(i) < 160 && bytes.getUint8(i + 1) < 200 && bytes.getUint8(i + 2) < 160;
      }

      var top = 0;
      var gaps = 0;
      for (var x = 20; x < image.width - 20; x++) {
        if (isBorder(x, 0)) {
          top++;
        } else {
          gaps++;
        }
      }
      expect(top, greaterThan(50), reason: 'garis tepi atas terlihat');
      expect(gaps, greaterThan(20), reason: 'garis putus-putus, bukan garis penuh');
      var left = 0;
      for (var y = 20; y < image.height - 20; y++) {
        if (isBorder(0, y)) left++;
      }
      expect(left, greaterThan(10), reason: 'garis tepi kiri terlihat');
      image.dispose();
    });

    testWidgets('mengunggah dan galat FILE_INVALID', (tester) async {
      await pumpDesign(
        tester,
        Column(
          children: [
            UploadTile(fileName: 'bukti.pdf', isPdf: true, progress: 0.4, onPick: () {}),
            UploadTile(fileName: 'besar.png', errorText: 'Berkas lebih dari 5 MB.', onPick: () {}),
          ],
        ),
      );
      expect(find.text('Mengunggah 40%'), findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsOneWidget);
      expect(find.text('Berkas lebih dari 5 MB.'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline), findsOneWidget);
    });
  });

  testWidgets('MethodRadioCard: pilihan eksklusif, detail dan salin hanya saat terpilih', (tester) async {
    var selected = 0;
    var copied = 0;
    await pumpDesign(
      tester,
      Column(
        children: [
          MethodRadioCard(
            title: 'Bank Syariah Indonesia',
            accountNumber: '7123456789',
            accountHolder: 'KAPDH',
            selected: true,
            onSelected: () {},
            onCopy: () => copied++,
          ),
          MethodRadioCard(
            title: 'E-wallet',
            accountNumber: '0812',
            selected: false,
            hint: 'Ketuk untuk melihat nomor tujuan',
            onSelected: () => selected++,
          ),
        ],
      ),
    );
    expect(find.text('7123456789'), findsOneWidget);
    expect(find.text('a.n. KAPDH'), findsOneWidget);
    expect(find.text('0812'), findsNothing);
    expect(find.text('Ketuk untuk melihat nomor tujuan'), findsOneWidget);
    await tester.tap(find.text('E-wallet'));
    expect(selected, 1);
    await tester.tap(find.bySemanticsLabel('Salin nomor rekening Bank Syariah Indonesia'));
    expect(copied, 1);
    final semantics = tester.getSemantics(find.text('Bank Syariah Indonesia'));
    expect(semantics.label, contains('nomor 7123456789'));
  });

  testWidgets('MethodRadioCard QRIS (ADR-026): NMID dan merchant berlabel, tanpa Salin', (tester) async {
    await pumpDesign(
      tester,
      const MethodRadioCard(
        title: 'QRIS',
        accountNumber: 'ID1020200012345',
        accountHolder: 'KAPDH Pusat',
        accountNumberLabel: 'NMID',
        accountHolderLabel: 'Merchant',
        selected: true,
        onSelected: null,
      ),
    );
    expect(find.text('NMID: ID1020200012345'), findsOneWidget);
    expect(find.text('Merchant: KAPDH Pusat'), findsOneWidget);
    expect(find.text('a.n. KAPDH Pusat'), findsNothing);
    expect(find.text('Salin'), findsNothing);
    expect(find.bySemanticsLabel('QRIS, NMID ID1020200012345, merchant KAPDH Pusat'), findsOneWidget);
  });

  group('QrisImageCard dan QrisImageViewer (ADR-026)', () {
    tearDown(() {
      PaintingBinding.instance.imageCache
        ..clear()
        ..clearLiveImages();
    });

    testWidgets('gambar tajam tidak dipotong (maks. 280 lp), label pembaca layar; ketuk gambar atau "Perbesar QRIS" '
        'membuka penampil putih dengan petunjuk pindai, "Tutup" menutupnya', (tester) async {
      await pumpDesign(tester, QrisImageCard(image: MemoryImage(onePixelPng), merchantName: 'KAPDH Pusat'));

      final image = tester.widget<Image>(find.descendant(of: find.byType(QrisImageCard), matching: find.byType(Image)));
      expect(image.fit, BoxFit.contain);
      expect(image.filterQuality, FilterQuality.none);
      expect(image.isAntiAlias, isFalse);
      expect(tester.getSize(find.byKey(const ValueKey('qris-image'))), const Size(280, 280));
      expect(find.bySemanticsLabel('Kode QRIS KAPDH Pusat, ketuk untuk memperbesar'), findsOneWidget);
      expect(tester.getSize(find.byKey(const ValueKey('qris-enlarge'))).height, greaterThanOrEqualTo(48));

      await tester.tap(find.byKey(const ValueKey('qris-image')));
      await tester.pumpAndSettle();
      expect(find.byType(QrisImageViewer), findsOneWidget);
      expect(tester.widget<Dialog>(find.byType(Dialog)).backgroundColor, KapdhColors.surface);
      expect(find.text('QRIS KAPDH Pusat'), findsOneWidget);
      expect(find.text(QrisImageViewer.scanHint), findsOneWidget);
      expect(find.byType(InteractiveViewer), findsOneWidget);
      final full = tester.widget<Image>(
        find.descendant(of: find.byType(QrisImageViewer), matching: find.byType(Image)),
      );
      expect(full.filterQuality, FilterQuality.none);
      expect(full.isAntiAlias, isFalse);
      await tester.tap(find.text('Tutup'));
      await tester.pumpAndSettle();
      expect(find.byType(QrisImageViewer), findsNothing);

      await tester.tap(find.text('Perbesar QRIS'));
      await tester.pumpAndSettle();
      expect(find.byType(QrisImageViewer), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('qris-viewer-close')));
      await tester.pumpAndSettle();
      expect(find.byType(QrisImageViewer), findsNothing);
    });

    testWidgets('gagal dimuat: tempat kosong berpesan tanpa "Perbesar QRIS"; "Muat ulang" memuat lagi', (tester) async {
      final loads = <String>[];
      await pumpDesign(
        tester,
        QrisImageCard(
          image: FlakyImage('https://api.test/files/public/qr-kartu', loads: loads),
          merchantName: 'KAPDH Pusat',
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Gambar QRIS belum dapat dimuat'), findsOneWidget);
      expect(find.byKey(const ValueKey('qris-enlarge')), findsNothing);
      expect(loads, hasLength(1));

      await tester.tap(find.byKey(const ValueKey('qris-retry')));
      await tester.pumpAndSettle();
      expect(loads, hasLength(2));
      expect(find.text('Gambar QRIS belum dapat dimuat'), findsNothing);
      expect(find.byKey(const ValueKey('qris-enlarge')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('penampil yang gagal memuat menampilkan pesan dan dapat memuat ulang', (tester) async {
      final loads = <String>[];
      await pumpDesign(
        tester,
        QrisImageViewer(
          image: FlakyImage('https://api.test/files/public/qr-penampil', loads: loads),
          merchantName: 'KAPDH Pusat',
        ),
        scaffold: false,
      );
      await tester.pumpAndSettle();
      expect(find.text('Gambar QRIS belum dapat dimuat'), findsOneWidget);
      expect(find.text(QrisImageViewer.scanHint), findsOneWidget);
      await expectMeetsAccessibilityGuidelines(tester);

      await tester.tap(find.byKey(const ValueKey('qris-retry')));
      await tester.pumpAndSettle();
      expect(loads, hasLength(2));
      expect(find.text('Gambar QRIS belum dapat dimuat'), findsNothing);
      expect(find.byType(InteractiveViewer), findsOneWidget);
    });

    testWidgets('pedoman aksesibilitas otomatis pada kartu dan penampil', (tester) async {
      await pumpDesign(tester, QrisImageCard(image: MemoryImage(onePixelPng), merchantName: 'KAPDH Pusat'));
      await expectMeetsAccessibilityGuidelines(tester);
      await tester.tap(find.text('Perbesar QRIS'));
      await tester.pumpAndSettle();
      await expectMeetsAccessibilityGuidelines(tester);
    });

    testWidgets('teks 200 % tanpa meluap pada kartu, tempat kosong galat dan penampil', (tester) async {
      await pumpDesign(
        tester,
        Column(
          children: [
            QrisImageCard(image: MemoryImage(onePixelPng), merchantName: 'KAPDH Pusat'),
            QrisImageCard(
              image: FlakyImage('https://api.test/files/public/qr-200', loads: <String>[]),
              merchantName: 'KAPDH Pusat',
            ),
          ],
        ),
        textScale: 2,
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('Gambar QRIS belum dapat dimuat'), findsOneWidget);

      await tester.tap(find.text('Perbesar QRIS'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text(QrisImageViewer.scanHint), findsOneWidget);
    });
  });

  testWidgets('AmountCopyBox: nominal Rupiah dan salin digit ke clipboard', (tester) async {
    String? clipboard;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') clipboard = (call.arguments as Map)['text'] as String?;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));

    await pumpDesign(tester, const AmountCopyBox(amount: '60000.00'));
    expect(find.text('Rp60.000'), findsOneWidget);
    await tester.tap(find.text('Salin'));
    await tester.pump();
    expect(clipboard, '60000');
    expect(find.text('Nominal disalin'), findsOneWidget);
  });
}
