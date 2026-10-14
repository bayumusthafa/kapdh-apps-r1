import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import 'status_repository.dart';

/// Panjang alasan banding (kontrak C6 `CreateAppealRequest.description`).
const int appealMinChars = 10;
const int appealMaxChars = 2000;

/// Banding atas pembatasan yang sedang berlaku dari portal pembatasan (PRD 3.12 "mekanisme banding wajib tersedia",
/// PRD 2.2). Keputusan yang dibanding ditentukan server dari suspend aktif; klien hanya mengirim alasan. Status dan
/// hasil banding tampil di sini (dan lewat notifikasi kategori akun). Satu banding aktif per pemohon.
class AppealSection extends ConsumerStatefulWidget {
  const AppealSection({super.key});

  @override
  ConsumerState<AppealSection> createState() => _AppealSectionState();
}

class _AppealSectionState extends ConsumerState<AppealSection> {
  final _reason = TextEditingController();
  ModerationReport? _appeal;
  bool _loading = true;
  ApiException? _error;
  bool _submitting = false;
  bool _submitted = false;
  String? _fieldError;

  StatusRepository get _repo => ref.read(statusRepositoryProvider);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final appeal = await _repo.latestAppeal();
      if (!mounted) return;
      setState(() {
        _appeal = appeal;
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

  static bool _isActive(ModerationReport report) =>
      report.status == ModerationReportStatus.open || report.status == ModerationReportStatus.inReview;

  int get _length => _reason.text.trim().length;

  String? get _localProblem {
    final nonSpace = _reason.text.replaceAll(RegExp(r'\s'), '').length;
    if (nonSpace < appealMinChars) return 'Tuliskan alasan banding minimal $appealMinChars karakter.';
    if (_length > appealMaxChars) return 'Maksimal $appealMaxChars karakter.';
    return null;
  }

  Future<void> _submit() async {
    setState(() => _submitted = true);
    if (_localProblem != null || _submitting) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _submitting = true;
      _fieldError = null;
    });
    try {
      final appeal = await _repo.createAppeal(_reason.text.trim());
      if (!mounted) return;
      setState(() {
        _appeal = appeal;
        _reason.clear();
        _submitted = false;
      });
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(const SnackBar(content: Text('Banding terkirim. Pengurus akan meninjaunya.')));
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.forbidden) {
        // Tidak ada pembatasan yang berlaku lagi (mis. sudah dicabut): status dimuat ulang dan router mengarahkan.
        unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(error.message)));
      } else if (error.fieldErrors['description'] case final messages?) {
        setState(() => _fieldError = messages.join(' '));
      } else {
        unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_submit())));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const LoadingSkeleton(showCard: false, lines: 2, semanticsLabel: 'Memuat status banding');
    }
    final error = _error;
    if (error != null) {
      return InfoBox(
        tone: InfoBoxTone.warning,
        title: 'Status banding belum dapat dimuat',
        message: error.message,
        trailing: TextButton(onPressed: _load, child: const Text('Coba lagi')),
      );
    }
    final appeal = _appeal;
    final active = appeal != null && _isActive(appeal);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (appeal != null) _AppealCard(appeal: appeal),
        if (!active) ...[if (appeal != null) const SizedBox(height: KapdhSpace.s4), _form()],
      ],
    );
  }

  Widget _form() {
    final problem = _submitted ? (_fieldError ?? _localProblem) : _fieldError;
    return Container(
      padding: const EdgeInsets.all(KapdhSpace.s4),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            header: true,
            child: const Text(
              'Ajukan banding',
              style: TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(height: KapdhSpace.s1),
          const Text(
            'Jelaskan mengapa pembatasan ini perlu ditinjau ulang. Pengurus menanggapi paling lambat 2 hari kerja.',
            style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.5, color: KapdhColors.textMuted),
          ),
          const SizedBox(height: KapdhSpace.s3),
          KapdhTextField(
            key: const ValueKey('appeal-reason'),
            label: 'Alasan banding',
            controller: _reason,
            hint: 'Tuliskan alasan Anda',
            maxLines: 5,
            helperText: '$_length/$appealMaxChars karakter',
            errorText: problem,
            enabled: !_submitting,
            onChanged: (_) => setState(() => _fieldError = null),
          ),
          const SizedBox(height: KapdhSpace.s3),
          KapdhButton.solid(
            key: const ValueKey('appeal-submit'),
            label: 'Kirim banding',
            busyLabel: 'Mengirim...',
            busy: _submitting,
            icon: Icons.send_outlined,
            onPressed: _submit,
          ),
        ],
      ),
    );
  }
}

class _AppealCard extends StatelessWidget {
  const _AppealCard({required this.appeal});

  final ModerationReport appeal;

  @override
  Widget build(BuildContext context) {
    final (String title, String status, String? note) = switch ((appeal.status, appeal.outcome)) {
      (ModerationReportStatus.open, _) => (
        'Banding sudah diterima',
        'Menunggu ditinjau',
        'Target tanggapan ${formatDateTime(appeal.dueAt)}.',
      ),
      (ModerationReportStatus.inReview, _) => (
        'Banding sedang ditinjau',
        'Sedang ditinjau',
        'Target tanggapan ${formatDateTime(appeal.dueAt)}.',
      ),
      (_, ModerationOutcome.actionTaken) => (
        'Banding dikabulkan',
        'Dikabulkan',
        'Bila akun Anda masih dibatasi, pembatasan ini berbeda dari yang dibanding; Anda dapat mengajukan banding baru.',
      ),
      (_, ModerationOutcome.noAction) => (
        'Banding ditolak',
        'Ditolak',
        'Anda dapat mengajukan banding baru dengan alasan tambahan atau menghubungi pengurus.',
      ),
      _ => ('Banding', 'Diproses', null),
    };
    final decided = appeal.resolvedAt;
    return SummaryCard(
      key: const ValueKey('appeal-status'),
      title: title,
      rows: [
        SummaryRow('Status', status, emphasis: true),
        SummaryRow('Diajukan', formatDateTime(appeal.createdAt)),
        if (decided != null) SummaryRow('Diputuskan', formatDateTime(decided)),
      ],
      body: appeal.decisionMessage == null ? null : 'Pesan pengurus: ${appeal.decisionMessage}',
      footnote: note,
    );
  }
}
