import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/error_presenter.dart';
import '../../core/ui/app_keys.dart';
import '../../design/design.dart';
import 'moderation_repository.dart';

/// Panjang maksimum penjelasan pelapor (moderation.yaml CreateModerationReportRequest.description).
const int reportDescriptionMaxChars = 2000;

/// Panjang minimum penjelasan (karakter bukan spasi) untuk kategori "Lainnya".
const int reportOtherMinChars = 10;

/// Label kategori laporan untuk anggota (moderation.yaml ModerationReportCategory).
String reportCategoryLabel(ModerationReportCategory category) => switch (category) {
  ModerationReportCategory.spam => 'Spam',
  ModerationReportCategory.harassment => 'Pelecehan atau perundungan',
  ModerationReportCategory.hate => 'Ujaran kebencian',
  ModerationReportCategory.sexual => 'Konten seksual',
  ModerationReportCategory.violenceThreat => 'Ancaman kekerasan atau keselamatan',
  ModerationReportCategory.scam => 'Penipuan',
  ModerationReportCategory.otherValue => 'Lainnya',
  ModerationReportCategory.appeal => 'Banding',
  ModerationReportCategory.unknown => 'Kategori lain',
};

String _inputCategoryLabel(ModerationReportInputCategory category) =>
    reportCategoryLabel(ModerationReportCategory.fromJson(category.value));

/// Keterangan singkat per kategori agar pelapor memilih dengan tepat.
String _inputCategoryHint(ModerationReportInputCategory category) => switch (category) {
  ModerationReportInputCategory.violenceThreat => 'Ditangani paling lambat 24 jam.',
  ModerationReportInputCategory.otherValue => 'Wajib menjelaskan masalahnya.',
  _ => '',
};

/// Objek yang dilaporkan (moderation.yaml createReport: user, message, atau grup).
sealed class ReportTarget {
  const ReportTarget();

  /// Judul lembar ("Laporkan pengguna").
  String get title;

  /// Ringkasan objek yang dilaporkan.
  String get summary;

  CreateModerationReportRequest request(ModerationReportInputCategory category, String? description);
}

/// Anggota lain (target_type user).
final class UserReportTarget extends ReportTarget {
  const UserReportTarget({required this.userId, required this.name});

  final String userId;
  final String name;

  @override
  String get title => 'Laporkan pengguna';

  @override
  String get summary => name;

  @override
  CreateModerationReportRequest request(ModerationReportInputCategory category, String? description) =>
      CreateModerationReportRequest(
        targetType: ModerationTargetType.user,
        targetUserId: userId,
        category: category,
        description: description,
      );
}

/// Pesan orang lain di room tempat pelapor anggota joined (target_type message), dengan maksimal 5 pesan konteks.
final class MessageReportTarget extends ReportTarget {
  const MessageReportTarget({
    required this.messageId,
    required this.senderName,
    this.preview,
    this.contextMessageIds = const [],
  });

  final String messageId;
  final String senderName;
  final String? preview;
  final List<String> contextMessageIds;

  @override
  String get title => 'Laporkan pesan';

  @override
  String get summary => preview == null ? 'Pesan dari $senderName' : '$senderName: $preview';

  @override
  CreateModerationReportRequest request(ModerationReportInputCategory category, String? description) =>
      CreateModerationReportRequest(
        targetType: ModerationTargetType.message,
        messageId: messageId,
        contextMessageIds: contextMessageIds.isEmpty ? null : contextMessageIds.take(5).toList(),
        category: category,
        description: description,
      );
}

/// Grup tempat pelapor anggota joined (target_type room).
final class RoomReportTarget extends ReportTarget {
  const RoomReportTarget({required this.roomId, required this.name});

  final String roomId;
  final String name;

  @override
  String get title => 'Laporkan grup';

  @override
  String get summary => name;

  @override
  CreateModerationReportRequest request(ModerationReportInputCategory category, String? description) =>
      CreateModerationReportRequest(
        targetType: ModerationTargetType.room,
        roomId: roomId,
        category: category,
        description: description,
      );
}

/// Membuka lembar laporan (AC F12-2). Mengembalikan laporan yang tercatat, atau null bila dibatalkan.
Future<ModerationReport?> showReportSheet(BuildContext context, ReportTarget target) =>
    showModalBottomSheet<ModerationReport>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => ReportSheet(target: target),
    );

/// Formulir laporan: kategori (violence_threat = prioritas 24 jam), penjelasan opsional (wajib untuk Lainnya).
/// Laporan tidak dibuka kepada pihak terlapor; statusnya dipantau di Akun > Laporan Saya (AC F12-2).
class ReportSheet extends ConsumerStatefulWidget {
  const ReportSheet({super.key, required this.target});

  final ReportTarget target;

  @override
  ConsumerState<ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends ConsumerState<ReportSheet> {
  final _description = TextEditingController();
  ModerationReportInputCategory? _category;
  String? _categoryError;
  String? _descriptionError;
  bool _busy = false;

  static const _categories = [
    ModerationReportInputCategory.spam,
    ModerationReportInputCategory.harassment,
    ModerationReportInputCategory.hate,
    ModerationReportInputCategory.sexual,
    ModerationReportInputCategory.violenceThreat,
    ModerationReportInputCategory.scam,
    ModerationReportInputCategory.otherValue,
  ];

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  bool _validate() {
    final category = _category;
    final text = _description.text;
    final nonSpace = text.replaceAll(RegExp(r'\s'), '').length;
    setState(() {
      _categoryError = category == null ? 'Pilih kategori laporan.' : null;
      _descriptionError = category == ModerationReportInputCategory.otherValue && nonSpace < reportOtherMinChars
          ? 'Jelaskan masalahnya minimal $reportOtherMinChars karakter.'
          : null;
    });
    return _categoryError == null && _descriptionError == null;
  }

  Future<void> _submit() async {
    if (_busy || !_validate()) return;
    final text = _description.text.trim();
    setState(() => _busy = true);
    try {
      final report = await ref
          .read(moderationRepositoryProvider)
          .createReport(widget.target.request(_category!, text.isEmpty ? null : text));
      if (!mounted) return;
      final router = GoRouter.maybeOf(context);
      Navigator.of(context).pop(report);
      ref.read(scaffoldMessengerKeyProvider).currentState
        ?..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: const Text('Laporan terkirim. Pengurus akan meninjaunya.'),
            action: router == null
                ? null
                : SnackBarAction(label: 'Lihat', onPressed: () => router.push(AppRoutes.accountReports)),
          ),
        );
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _busy = false);
      final fieldErrors = error.error?.fieldErrors;
      if (fieldErrors != null && fieldErrors.isNotEmpty) {
        setState(() {
          _descriptionError = fieldErrors['description']?.join(' ');
          _categoryError = fieldErrors['category']?.join(' ');
        });
        if (_descriptionError != null || _categoryError != null) return;
      }
      await ref.read(errorPresenterProvider).present(error, onRetry: _submit);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: bottomInset),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, 0, KapdhSpace.s5, KapdhSpace.s5),
          children: [
            Semantics(
              header: true,
              child: Text(
                widget.target.title,
                style: const TextStyle(fontSize: KapdhFontSize.h3, fontWeight: FontWeight.w600),
              ),
            ),
            const SizedBox(height: KapdhSpace.s1),
            Text(
              widget.target.summary,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: KapdhColors.textMuted),
            ),
            const SizedBox(height: KapdhSpace.s3),
            const Text('Kategori', style: TextStyle(fontWeight: FontWeight.w500)),
            RadioGroup<ModerationReportInputCategory>(
              groupValue: _category,
              onChanged: (value) => setState(() {
                _category = value;
                _categoryError = null;
              }),
              child: Column(
                children: [
                  for (final category in _categories)
                    RadioListTile<ModerationReportInputCategory>(
                      value: category,
                      contentPadding: EdgeInsets.zero,
                      title: Text(_inputCategoryLabel(category)),
                      subtitle: _inputCategoryHint(category).isEmpty ? null : Text(_inputCategoryHint(category)),
                    ),
                ],
              ),
            ),
            if (_categoryError != null)
              Text(_categoryError!, style: const TextStyle(color: KapdhColors.danger, fontSize: KapdhFontSize.caption)),
            const SizedBox(height: KapdhSpace.s3),
            KapdhTextField(
              label: 'Penjelasan',
              controller: _description,
              hint: _category == ModerationReportInputCategory.otherValue ? 'Wajib diisi' : 'Opsional',
              maxLines: 4,
              errorText: _descriptionError,
              inputFormatters: [LengthLimitingTextInputFormatter(reportDescriptionMaxChars)],
              requiredMark: _category == ModerationReportInputCategory.otherValue,
            ),
            const SizedBox(height: KapdhSpace.s3),
            const InfoBox(
              icon: Icons.shield_outlined,
              message:
                  'Laporan tidak dibuka kepada pihak yang dilaporkan. Pantau statusnya di Akun > Laporan Saya. '
                  'Dalam keadaan darurat, hubungi pihak berwenang.',
            ),
            const SizedBox(height: KapdhSpace.s4),
            KapdhButton(
              label: 'Kirim laporan',
              icon: Icons.flag_outlined,
              busy: _busy,
              busyLabel: 'Mengirim laporan',
              onPressed: _busy ? null : _submit,
            ),
          ],
        ),
      ),
    );
  }
}
