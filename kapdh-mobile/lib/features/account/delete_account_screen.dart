import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/reauth_dialog.dart';
import '../../design/design.dart';
import 'widgets/scroll_column.dart';
import '../status/deletion_portal.dart';
import 'account_repository.dart';
import 'widgets/account_section.dart';

/// Umur pakai token reautentikasi di klien; server menolak setelah 10 menit (F-14, ARCHITECTURE §4.3).
const Duration _reauthReuse = Duration(minutes: 9);

/// Hapus akun dari aplikasi (F-14, AC F14-1; N-15, D2). Urutan: pengungkapan retensi dan peringatan pribadi
/// (GET /me/deletion/disclosure) -> konfirmasi eksplisit -> reautentikasi sandi (maksimal 10 menit) -> POST
/// /me/deletion dengan versi pengungkapan yang dibaca. Hasilnya nomor permintaan; sesi dicabut server sehingga token,
/// cache KTA dan data akun di perangkat dihapus dan portal status penghapusan tanpa sesi ditampilkan. Anggota
/// suspended juga dapat menghapus akun (deletion-only, PRD 2.2).
class DeleteAccountScreen extends ConsumerStatefulWidget {
  const DeleteAccountScreen({super.key});

  @override
  ConsumerState<DeleteAccountScreen> createState() => _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends ConsumerState<DeleteAccountScreen> {
  AccountDeletionDisclosure? _disclosure;
  bool _loading = true;
  ApiException? _error;
  bool _understoodData = false;
  bool _understoodWarnings = false;
  bool _submitting = false;

  /// Pengungkapan berubah saat konfirmasi (409 VERSION_CONFLICT): pengguna diminta membaca ulang.
  bool _changed = false;
  String? _reauthToken;
  DateTime? _reauthAt;

  AccountRepository get _repo => ref.read(accountRepositoryProvider);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = _disclosure == null;
      _error = null;
    });
    try {
      final disclosure = await _repo.getDeletionDisclosure();
      if (!mounted) return;
      setState(() {
        _disclosure = disclosure;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  bool _hasWarnings(AccountDeletionDisclosure d) =>
      d.activeTickets.isNotEmpty ||
      d.pendingRefunds.isNotEmpty ||
      d.openPayments.isNotEmpty ||
      d.soleAdminGroupCount > 0 ||
      d.linkedAdminIdentity;

  bool get _canSubmit {
    final d = _disclosure;
    if (d == null || _submitting) return false;
    return _understoodData && (!_hasWarnings(d) || _understoodWarnings);
  }

  Future<String?> _token({bool force = false}) async {
    final now = ref.read(clockProvider)();
    final at = _reauthAt;
    final cached = _reauthToken;
    if (!force && cached != null && at != null && now.difference(at) < _reauthReuse) return cached;
    final token = await showReauthDialog(
      context,
      reason: 'Masukkan password Anda untuk mengonfirmasi penghapusan akun. Konfirmasi berlaku 10 menit.',
    );
    if (token != null) {
      _reauthToken = token;
      _reauthAt = ref.read(clockProvider)();
    }
    return token;
  }

  Future<void> _submit({bool forceReauth = false}) async {
    final disclosure = _disclosure;
    if (disclosure == null || !_canSubmit) return;
    final token = await _token(force: forceReauth);
    if (token == null || !mounted) return;
    setState(() => _submitting = true);
    try {
      final deletion = await _repo.requestDeletion(disclosureVersion: disclosure.version, reauthToken: token);
      if (!mounted) return;
      await _finish(deletion);
    } on ApiException catch (error) {
      if (!mounted) return;
      switch (error.code) {
        case ErrorCode.reauthRequired:
          _reauthToken = null;
          setState(() => _submitting = false);
          if (!forceReauth) await _submit(forceReauth: true);
        case ErrorCode.versionConflict:
          final current = error.current;
          setState(() {
            if (current is Map<String, Object?>) _disclosure = AccountDeletionDisclosure.fromJson(current);
            _changed = true;
            _understoodData = false;
            _understoodWarnings = false;
          });
          if (current is! Map<String, Object?>) unawaited(_load());
        default:
          unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_submit())));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  /// AC F14-1: nomor permintaan ditampilkan, lalu token, cache KTA dan data privat lokal dihapus (sesi sudah dicabut
  /// server) dan portal status penghapusan tanpa sesi dibuka.
  Future<void> _finish(AccountDeletion deletion) async {
    // Diambil sebelum await: layar ini dapat dilepas router begitu sesi berakhir.
    final router = GoRouter.of(context);
    final session = ref.read(sessionProvider.notifier);
    final email = ref.read(sessionProvider).me?.email;
    ref.read(deletionPortalProvider.notifier).showRequested(deletion, email: email);
    // Server sudah mencabut semua sesi dan token push (AC F14-1, F13-5); logout lokal menghapus token, cache KTA,
    // snapshot /me dan key idempotensi, dan PushService menghapus token FCM perangkat.
    await session.logout();
    router.go(AppRoutes.deletionStatus);
  }

  @override
  Widget build(BuildContext context) {
    final suspended = ref.watch(sessionProvider).effectiveStatus == EffectiveStatus.suspended;
    return AppScaffold(
      title: 'Hapus Akun',
      fallbackLocation: suspended ? AppRoutes.restricted : AppRoutes.account,
      body: _body(),
    );
  }

  Widget _body() {
    if (_loading) return const LoadingSkeleton(showCard: false, lines: 8, semanticsLabel: 'Memuat penjelasan');
    final error = _error;
    final d = _disclosure;
    if (error != null || d == null) {
      return ErrorState.fromException(
        error ?? const ApiException(kind: ApiFailureKind.unexpected, operationId: 'getAccountDeletionDisclosure'),
        onRetry: _load,
      );
    }
    final warnings = _hasWarnings(d);
    return ScrollColumn(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s8),
      children: [
        const InfoBox(
          tone: InfoBoxTone.danger,
          title: 'Penghapusan akun bersifat permanen',
          message:
              'Setelah dikonfirmasi, Anda keluar dari semua perangkat dan akun tidak dapat dipakai lagi. KTA, '
              'riwayat chat dan keanggotaan tidak dapat dipulihkan.',
        ),
        if (_changed) ...[
          const SizedBox(height: KapdhSpace.s3),
          Semantics(
            liveRegion: true,
            child: const InfoBox(
              tone: InfoBoxTone.warning,
              key: ValueKey('deletion-disclosure-changed'),
              title: 'Ada perubahan',
              message:
                  'Tiket, refund atau pembayaran Anda baru saja berubah. Baca kembali penjelasan di bawah lalu '
                  'konfirmasi ulang.',
            ),
          ),
        ],
        const SizedBox(height: KapdhSpace.s5),
        AccountSection(
          title: 'DATA YANG DIHAPUS',
          children: [for (final item in d.deletedData) _Bullet(icon: KapdhIcons.deleteOutline, text: item.description)],
        ),
        const SizedBox(height: KapdhSpace.s5),
        AccountSection(
          title: 'DISIMPAN TANPA IDENTITAS',
          footnote:
              'Catatan ini disimpan tanpa nama, email, telepon, foto atau data identitas lain, hanya jumlah, tanggal, '
              'status dan nomor referensi minimum (D2).',
          children: [
            for (final item in d.retainedData) _Bullet(icon: KapdhIcons.inventory2Outlined, text: item.description),
          ],
        ),
        const SizedBox(height: KapdhSpace.s5),
        AccountSection(
          title: 'WAKTU DAN BACKUP',
          children: [
            _Bullet(
              icon: KapdhIcons.schedule,
              text:
                  'Penghapusan selesai paling lambat ${d.estimatedCompletionDays} hari kalender setelah permintaan. '
                  'Anda menerima email nomor permintaan dan email saat selesai.',
            ),
            _Bullet(
              icon: KapdhIcons.backupOutlined,
              text:
                  'Backup harian berotasi ${d.backupRetentionDays} hari untuk pemulihan bencana. Data yang sudah '
                  'dihapus tidak diaktifkan kembali saat backup dipulihkan.',
            ),
          ],
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: KapdhLinkButton(
            key: const ValueKey('deletion-privacy-policy'),
            label: d.privacyPolicyVersion == null
                ? 'Baca kebijakan privasi'
                : 'Baca kebijakan privasi (versi ${d.privacyPolicyVersion})',
            icon: KapdhIcons.privacyTipOutlined,
            onPressed: () => context.push(AppRoutes.legal(d.privacyPolicySlug)),
          ),
        ),
        if (warnings) ...[const SizedBox(height: KapdhSpace.s4), _Warnings(disclosure: d)],
        const SizedBox(height: KapdhSpace.s5),
        CheckboxListTile(
          key: const ValueKey('deletion-confirm-data'),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          value: _understoodData,
          onChanged: _submitting ? null : (v) => setState(() => _understoodData = v ?? false),
          title: const Text(
            'Saya memahami data yang dihapus dan yang disimpan tanpa identitas, dan ingin menghapus akun saya.',
            style: TextStyle(fontSize: 13),
          ),
        ),
        if (warnings)
          CheckboxListTile(
            key: const ValueKey('deletion-confirm-warnings'),
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _understoodWarnings,
            onChanged: _submitting ? null : (v) => setState(() => _understoodWarnings = v ?? false),
            title: const Text(
              'Saya memahami peringatan tiket, refund, pembayaran dan grup di atas.',
              style: TextStyle(fontSize: 13),
            ),
          ),
        const SizedBox(height: KapdhSpace.s4),
        _DangerButton(
          key: const ValueKey('deletion-submit'),
          label: 'Hapus akun saya',
          busy: _submitting,
          onPressed: _canSubmit ? () => unawaited(_submit()) : null,
        ),
        const SizedBox(height: KapdhSpace.s3),
        Text(
          'Anda akan diminta memasukkan password untuk konfirmasi.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
        ),
      ],
    );
  }
}

class _Bullet extends StatelessWidget {
  const _Bullet({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ExcludeSemantics(child: Icon(icon, size: 18, color: context.kc.primary)),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 13, height: 1.5))),
        ],
      ),
    );
  }
}

/// Peringatan pribadi sebelum konfirmasi (PRD 3.9, 4.4, D6; AC F14-5): tiket aktif yang hangus, refund yang belum
/// ditransfer, pembayaran terbuka yang dibatalkan, grup yang admin tunggalnya pengguna, dan identitas pengurus.
class _Warnings extends StatelessWidget {
  const _Warnings({required this.disclosure});

  final AccountDeletionDisclosure disclosure;

  static String _paymentType(AccountDeletionPaymentType type) => switch (type) {
    AccountDeletionPaymentType.registration => 'Iuran pendaftaran',
    AccountDeletionPaymentType.renewal => 'Iuran perpanjangan',
    AccountDeletionPaymentType.ticket => 'Tiket event',
    AccountDeletionPaymentType.unknown => 'Pembayaran',
  };

  static String _ticketStatus(AccountDeletionTicketStatus status) => switch (status) {
    AccountDeletionTicketStatus.awaitingPayment => 'Menunggu pembayaran',
    AccountDeletionTicketStatus.awaitingReview => 'Menunggu verifikasi',
    AccountDeletionTicketStatus.paid => 'Terkonfirmasi',
    AccountDeletionTicketStatus.unknown => 'Aktif',
  };

  static String _refundPolicy(AccountDeletionTicketWarning ticket) {
    switch (ticket.refundPolicy) {
      case AccountDeletionRefundPolicy.fullRefund:
        if (ticket.eventCancelled) {
          return 'Event dibatalkan pengurus sehingga Anda berhak refund penuh. Tunggu sampai refund selesai '
              'sebelum menghapus akun; setelah akun dihapus tiket hangus.';
        }
        final deadline = ticket.selfCancelDeadlineAt;
        final until = deadline == null ? '' : ' paling lambat ${formatDateTime(deadline, zone: ticket.eventTimezone)}';
        return 'Batalkan tiket$until untuk refund penuh sebelum menghapus akun. Setelah akun dihapus tiket hangus '
            'tanpa refund.';
      case AccountDeletionRefundPolicy.noRefund:
        return 'Tiket hangus tanpa refund (tiket gratis atau batas pembatalan H-3 sudah lewat).';
      case AccountDeletionRefundPolicy.caseByCase:
        return 'Akun Anda sedang dibatasi; tiket tidak berlaku dan refund diputuskan pengurus per kasus.';
      case AccountDeletionRefundPolicy.paymentPending:
        return 'Pembayaran tiket belum selesai dan akan dibatalkan. Bila Anda sudah transfer, hubungi bendahara '
            'sebelum menghapus akun.';
      case AccountDeletionRefundPolicy.unknown:
        return 'Hubungi pengurus untuk ketentuan refund tiket ini sebelum menghapus akun.';
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = disclosure;
    final cards = <Widget>[];
    for (final ticket in d.activeTickets) {
      cards.add(
        SummaryCard(
          key: ValueKey('deletion-ticket-${ticket.ticketId}'),
          title: 'Tiket aktif: ${ticket.eventTitle}',
          tone: SummaryCardTone.danger,
          rows: [
            SummaryRow('Jadwal', formatDateTime(ticket.eventStartsAt, zone: ticket.eventTimezone)),
            SummaryRow('Status', _ticketStatus(ticket.status)),
            SummaryRow('Total', formatRupiah(ticket.total), emphasis: true),
          ],
          footnote: _refundPolicy(ticket),
        ),
      );
    }
    for (final refund in d.pendingRefunds) {
      final due = refund.dueAt;
      cards.add(
        SummaryCard(
          key: ValueKey('deletion-refund-${refund.adjustmentId}'),
          title: 'Refund belum ditransfer',
          tone: SummaryCardTone.danger,
          rows: [
            SummaryRow('Untuk', refund.eventTitle ?? _paymentType(refund.paymentType)),
            SummaryRow('Jumlah', formatRupiah(refund.amount), emphasis: true),
            if (due != null) SummaryRow('Tenggat bendahara', formatDateTime(due)),
            SummaryRow('Rekening tujuan', refund.destinationProvided ? 'Sudah diberikan' : 'Belum diberikan'),
          ],
          footnote:
              'Penghapusan tidak menunggu refund. Setelah akun dihapus, bendahara tidak dapat lagi menghubungi Anda '
              'dan data rekening tujuan ikut dihapus. Sebaiknya tunggu sampai refund selesai.',
        ),
      );
    }
    for (final payment in d.openPayments) {
      cards.add(
        SummaryCard(
          key: ValueKey('deletion-payment-${payment.paymentId}'),
          title: 'Pembayaran belum selesai: ${_paymentType(payment.type)}',
          tone: SummaryCardTone.danger,
          rows: [SummaryRow('Jumlah', formatRupiah(payment.amount), emphasis: true)],
          footnote: payment.proofSubmitted
              ? 'Bukti transfer sudah Anda kirim, jadi dana mungkin sudah terkirim. Pembayaran ini dibatalkan saat '
                    'akun dihapus dan dana tidak otomatis dianggap kembali; hubungi bendahara lebih dahulu.'
              : 'Pembayaran ini dibatalkan saat akun dihapus.',
        ),
      );
    }
    if (d.soleAdminGroupCount > 0) {
      cards.add(
        InfoBox(
          tone: InfoBoxTone.warning,
          icon: KapdhIcons.groupsOutlined,
          message:
              'Anda admin tunggal di ${d.soleAdminGroupCount} grup chat. Kewenangan admin dialihkan otomatis ke '
              'anggota aktif atau grup ditutup; penghapusan tidak menunggu respons anggota lain.',
        ),
      );
    }
    if (d.linkedAdminIdentity) {
      cards.add(
        const InfoBox(
          tone: InfoBoxTone.warning,
          icon: KapdhIcons.adminPanelSettingsOutlined,
          message:
              'Akun ini terhubung dengan akun pengurus. Akun pengurus tidak ikut terhapus; pengalihan kewenangan '
              'pengurus dilakukan Super Admin.',
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: Text(
            'Perhatikan sebelum menghapus',
            style: TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600, color: context.kc.danger),
          ),
        ),
        for (final card in cards) ...[const SizedBox(height: KapdhSpace.s3), card],
      ],
    );
  }
}

/// Tombol merah untuk tindakan yang tidak dapat dibatalkan (PRD 4.5: konfirmasi diperlukan untuk penghapusan).
class _DangerButton extends StatelessWidget {
  const _DangerButton({super.key, required this.label, required this.onPressed, this.busy = false});

  final String label;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    return Semantics(
      button: true,
      enabled: enabled,
      container: true,
      child: SizedBox(
        width: double.infinity,
        child: FilledButton.icon(
          style: FilledButton.styleFrom(
            backgroundColor: context.kc.danger,
            foregroundColor: context.kc.onDanger,
            disabledBackgroundColor: context.kc.disabledBg,
            minimumSize: const Size.fromHeight(KapdhSize.buttonHeight),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
          ),
          onPressed: enabled ? onPressed : null,
          icon: busy
              ? SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: context.kc.disabledText),
                )
              : const Icon(KapdhIcons.deleteForeverOutlined),
          label: Text(busy ? 'Memproses...' : label),
        ),
      ),
    );
  }
}
