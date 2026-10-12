import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../support/widget_harness.dart';

void main() {
  group('StatusStyles: setiap keluarga status punya label + ikon (PRD 4.5)', () {
    test('keanggotaan memakai label katalog bersama; expired = KTA Kedaluwarsa', () {
      for (final status in EffectiveStatus.values) {
        final style = StatusStyles.membership(status);
        expect(style.label, membershipLabel(status));
        expect(style.label, isNotEmpty);
      }
      expect(StatusStyles.membership(EffectiveStatus.expired).label, 'KTA Kedaluwarsa');
      expect(StatusStyles.membership(EffectiveStatus.unverified).label, 'KTA Tidak Aktif');
      expect(StatusStyles.membership(EffectiveStatus.verified).foreground, KapdhColors.success);
      expect(KapdhMembershipStatus.expired.label, 'KTA Kedaluwarsa', reason: 'token tersinkron dengan design-tokens');
    });

    test('kartu, pembayaran, tiket, event dan penghapusan', () {
      expect(StatusStyles.card(MemberCardStatus.active).label, 'KTA Aktif');
      expect(StatusStyles.card(MemberCardStatus.inactive).label, 'KTA Tidak Aktif');
      expect(StatusStyles.card(MemberCardStatus.expired).label, 'KTA Kedaluwarsa');
      expect(StatusStyles.payment(PaymentStatus.pending).label, 'Menunggu Pembayaran');
      expect(StatusStyles.payment(PaymentStatus.pending, proofSubmitted: true).label, 'Menunggu Verifikasi');
      expect(StatusStyles.payment(PaymentStatus.rejected).label, 'Perlu Perbaikan');
      expect(StatusStyles.payment(PaymentStatus.rejected, correctable: false).label, 'Ditolak');
      expect(StatusStyles.payment(PaymentStatus.paid).label, 'Lunas');
      expect(StatusStyles.ticket(TicketBadgeStatus.fromValue('paid')).label, 'Terkonfirmasi');
      expect(StatusStyles.ticket(TicketBadgeStatus.fromValue('baru')), StatusStyles.ticket(TicketBadgeStatus.unknown));
      expect(StatusStyles.event(EventBadgeStatus.fromValue('open')).label, 'Pendaftaran Dibuka');
      expect(StatusStyles.event(EventBadgeStatus.fromValue('closed')).label, 'Pendaftaran Ditutup');
      expect(StatusStyles.deletion(AccountDeletionStatus.processing).label, 'Sedang Diproses');
      expect(StatusStyles.offline.label, 'Offline');
      final all = [
        ...MemberCardStatus.values.map(StatusStyles.card),
        ...PaymentStatus.values.map(StatusStyles.payment),
        ...TicketBadgeStatus.values.map(StatusStyles.ticket),
        ...EventBadgeStatus.values.map(StatusStyles.event),
        ...AccountDeletionStatus.values.map(StatusStyles.deletion),
      ];
      expect(all.every((s) => s.label.isNotEmpty), isTrue);
    });
  });

  testWidgets('StatusBadge menampilkan ikon dan label; diumumkan sebagai status', (tester) async {
    await pumpDesign(tester, StatusBadge(StatusStyles.card(MemberCardStatus.active)));
    expect(find.byIcon(Icons.check_circle), findsOneWidget);
    expect(find.textContaining('KTA Aktif'), findsOneWidget);
    expect(find.bySemanticsLabel('Status: KTA Aktif'), findsOneWidget);
  });

  testWidgets('StatusHero (prototipe layar 4): ikon 72 px, badge, judul dan keterangan', (tester) async {
    await pumpDesign(
      tester,
      StatusHero(
        status: StatusStyles.payment(PaymentStatus.pending, proofSubmitted: true),
        icon: Icons.hourglass_top,
        title: 'Bukti pembayaran sedang diperiksa',
        message: 'Pengurus akan mencocokkan transfer Anda.',
      ),
    );
    expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
    expect(find.bySemanticsLabel('Status: Menunggu Verifikasi'), findsOneWidget);
    expect(find.text('Pengurus akan mencocokkan transfer Anda.'), findsOneWidget);
  });

  testWidgets('SummaryCard: baris, total dan nada penolakan (prototipe layar 2, 5)', (tester) async {
    await pumpDesign(
      tester,
      const Column(
        children: [
          SummaryCard(
            title: 'Rincian iuran pendaftaran',
            labelMuted: false,
            rows: [SummaryRow('Register alumni baru', 'Rp50.000'), SummaryRow('Pembuatan KTA', 'Rp10.000')],
            total: SummaryRow('Total', 'Rp60.000'),
            footnote: 'Masa aktif 12 bulan sejak iuran diverifikasi.',
          ),
          SummaryCard(title: 'Catatan dari pengurus', tone: SummaryCardTone.danger, body: 'Foto bukti buram.'),
        ],
      ),
    );
    expect(find.text('Rp60.000'), findsOneWidget);
    expect(find.text('Foto bukti buram.'), findsOneWidget);
    final title = tester.widget<Text>(find.text('Catatan dari pengurus'));
    expect(title.style?.color, KapdhColors.danger);
  });

  testWidgets('Timeline (prototipe layar 4): penanda per keadaan dan label semantik', (tester) async {
    await pumpDesign(
      tester,
      const Timeline(
        entries: [
          TimelineEntry(
            title: 'Menunggu verifikasi pengurus',
            subtitle: 'Sedang berlangsung',
            state: TimelineState.current,
          ),
          TimelineEntry(title: 'Bukti transfer dikirim', subtitle: '12 Okt 2026, 14.20 WIB'),
          TimelineEntry(title: 'Ditolak', state: TimelineState.failed),
          TimelineEntry(title: 'Lunas', state: TimelineState.upcoming),
        ],
      ),
    );
    expect(find.byIcon(Icons.check), findsOneWidget);
    expect(find.byIcon(Icons.close), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('Bukti transfer dikirim, selesai')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('Menunggu verifikasi pengurus, sedang berlangsung')), findsOneWidget);
  });

  testWidgets('OfflineBanner (prototipe layar 7): waktu sinkronisasi WIB dan tombol coba lagi', (tester) async {
    var retried = false;
    await pumpDesign(
      tester,
      OfflineBanner(syncedAt: DateTime.utc(2026, 10, 11, 13, 14), onRetry: () => retried = true),
      scaffold: false,
    );
    expect(find.textContaining('Tersinkron 11 Okt 2026, 20.14 WIB'), findsOneWidget);
    await tester.tap(find.text('Coba lagi'));
    expect(retried, isTrue);
  });

  testWidgets('InfoBox: tiga nada dengan ikon', (tester) async {
    await pumpDesign(
      tester,
      const Column(
        children: [
          InfoBox(message: 'Kartu offline berlaku 7 hari.'),
          InfoBox(message: 'Peringatan', tone: InfoBoxTone.warning),
          InfoBox(message: 'Galat', tone: InfoBoxTone.danger, title: 'Gagal'),
        ],
      ),
    );
    expect(find.byIcon(Icons.info_outline), findsOneWidget);
    expect(find.byIcon(Icons.warning_amber_rounded), findsOneWidget);
    expect(find.byIcon(Icons.error_outline), findsOneWidget);
    expect(find.text('Gagal'), findsOneWidget);
  });
}
