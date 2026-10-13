import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/format/formatters.dart';
import '../../../design/design.dart';

/// Penyesuaian/refund atas pembayaran (D6, PRD 3.9). Untuk refund yang menunggu rekening tujuan
/// (`destination_required`), formulir rekening ditampilkan; nilainya hanya dikirim ke server dan tidak pernah
/// disimpan, dicatat, atau ditampilkan kembali (ARCHITECTURE §2 butir 3; respons hanya `has_refund_destination`).
class AdjustmentCard extends StatefulWidget {
  const AdjustmentCard({super.key, required this.adjustment, required this.onSubmitDestination});

  final PaymentAdjustmentSummary adjustment;

  /// Mengirim rekening tujuan; mengembalikan galat per field (kosong bila berhasil).
  final Future<Map<String, List<String>>> Function(RefundDestinationInput input) onSubmitDestination;

  @override
  State<AdjustmentCard> createState() => _AdjustmentCardState();
}

class _AdjustmentCardState extends State<AdjustmentCard> {
  final _provider = TextEditingController();
  final _number = TextEditingController();
  final _holder = TextEditingController();
  bool _editing = false;
  bool _sending = false;
  Map<String, List<String>> _fieldErrors = const {};

  @override
  void dispose() {
    _provider.dispose();
    _number.dispose();
    _holder.dispose();
    super.dispose();
  }

  String? _fieldError(String field) {
    final server = _fieldErrors[field];
    if (server != null && server.isNotEmpty) return server.join(' ');
    return null;
  }

  Future<void> _submit() async {
    final provider = _provider.text.trim();
    final number = _number.text.trim();
    final holder = _holder.text.trim();
    final local = <String, List<String>>{
      if (provider.isEmpty) 'provider': ['Nama bank atau e-wallet wajib diisi.'],
      if (number.isEmpty) 'account_number': ['Nomor rekening wajib diisi.'],
      if (holder.isEmpty) 'account_holder': ['Nama pemilik rekening wajib diisi.'],
    };
    if (local.isNotEmpty) {
      setState(() => _fieldErrors = local);
      return;
    }
    setState(() {
      _sending = true;
      _fieldErrors = const {};
    });
    final errors = await widget.onSubmitDestination(
      RefundDestinationInput(provider: provider, accountNumber: number, accountHolder: holder),
    );
    if (!mounted) return;
    setState(() {
      _sending = false;
      _fieldErrors = errors;
      if (errors.isEmpty) {
        _editing = false;
        // Nilai rekening tidak disimpan di memori layar setelah terkirim.
        _provider.clear();
        _number.clear();
        _holder.clear();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.adjustment;
    final refund = a.kind == PaymentAdjustmentKind.refund;
    final statusText = switch (a.status) {
      PaymentAdjustmentStatus.pending => refund ? 'Sedang diproses bendahara' : 'Sedang diproses',
      PaymentAdjustmentStatus.completed => 'Selesai',
      PaymentAdjustmentStatus.cancelled => 'Dibatalkan',
      PaymentAdjustmentStatus.unknown => 'Status tidak dikenal',
    };
    final pending = a.status == PaymentAdjustmentStatus.pending;
    final showForm = refund && pending && (a.destinationRequired || _editing);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SummaryCard(
          title: refund ? 'Pengembalian dana' : 'Koreksi keuangan',
          rows: [
            SummaryRow('Nominal', formatRupiah(a.amount), emphasis: true),
            SummaryRow('Status', statusText),
            if (a.dueAt != null && pending) SummaryRow('Tenggat proses', formatDate(a.dueAt!)),
            if (a.completedAt != null) SummaryRow('Selesai', formatDateTime(a.completedAt!)),
            if (refund && pending) SummaryRow('Rekening tujuan', a.hasRefundDestination ? 'Sudah diterima' : 'Belum ada'),
          ],
          footnote: refund && pending && a.hasRefundDestination && !_editing
              ? 'Rekening tujuan tidak ditampilkan kembali demi keamanan. Kirim ulang bila ada yang salah.'
              : null,
        ),
        if (refund && pending && a.hasRefundDestination && !_editing)
          Align(
            alignment: Alignment.centerLeft,
            child: KapdhLinkButton(label: 'Ganti rekening tujuan', onPressed: () => setState(() => _editing = true)),
          ),
        if (showForm) ...[
          const SizedBox(height: KapdhSpace.s3),
          const InfoBox(
            message:
                'Isi rekening tujuan pengembalian dana. Data ini hanya dipakai bendahara untuk refund dan dihapus '
                'setelah refund selesai.',
          ),
          const SizedBox(height: KapdhSpace.s3),
          KapdhTextField(
            label: 'Bank atau e-wallet',
            controller: _provider,
            requiredMark: true,
            enabled: !_sending,
            errorText: _fieldError('provider'),
            inputFormatters: [LengthLimitingTextInputFormatter(80)],
            textInputAction: TextInputAction.next,
          ),
          const SizedBox(height: KapdhSpace.s3),
          KapdhTextField(
            label: 'Nomor rekening',
            controller: _number,
            requiredMark: true,
            enabled: !_sending,
            keyboardType: TextInputType.number,
            errorText: _fieldError('account_number'),
            inputFormatters: [LengthLimitingTextInputFormatter(64)],
            textInputAction: TextInputAction.next,
          ),
          const SizedBox(height: KapdhSpace.s3),
          KapdhTextField(
            label: 'Nama pemilik rekening',
            controller: _holder,
            requiredMark: true,
            enabled: !_sending,
            errorText: _fieldError('account_holder'),
            inputFormatters: [LengthLimitingTextInputFormatter(120)],
            textCapitalization: TextCapitalization.words,
          ),
          if (_fieldErrors['_'] case final root? when root.isNotEmpty) ...[
            const SizedBox(height: KapdhSpace.s2),
            Text(
              root.join(' '),
              style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.danger),
            ),
          ],
          const SizedBox(height: KapdhSpace.s3),
          KapdhButton.solid(
            label: 'Kirim rekening tujuan',
            busy: _sending,
            busyLabel: 'Mengirim...',
            onPressed: _submit,
          ),
        ],
      ],
    );
  }
}
