import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';
import 'directory_tab.dart';
import 'moderation_repository.dart';
import 'paged_list.dart';
import 'report_sheet.dart';

/// Laporan dan banding milik sendiri (moderation.yaml listMyReports), terbaru dulu (AC F12-2).
final myReportsProvider = NotifierProvider.autoDispose<MyReportsController, PagedState<ModerationReport>>(
  MyReportsController.new,
);

class MyReportsController extends PagedController<ModerationReport> {
  @override
  Future<PageResult<ModerationReport>> fetchPage(String? cursor) async {
    final page = await ref.read(moderationRepositoryProvider).listMyReports(cursor: cursor);
    return PageResult(page.items, page.nextCursor);
  }

  @override
  String keyOf(ModerationReport item) => item.id;
}

/// Detail laporan terbaru (GET /reports/{reportId}).
final myReportDetailProvider = FutureProvider.autoDispose.family<ModerationReport, String>(
  (ref, reportId) => ref.watch(moderationRepositoryProvider).getMyReport(reportId),
  retry: (_, _) => null,
);

/// Status laporan dengan label dan ikon (status tidak dibedakan dengan warna saja, PRD 4.5).
StatusBadgeStyle reportStatusStyle(ModerationReportStatus status) => switch (status) {
  ModerationReportStatus.open => const StatusBadgeStyle(
    label: 'Menunggu tinjauan',
    icon: KapdhIcons.hourglassTop,
    foreground: KapdhColors.info,
    background: KapdhColors.infoBg,
  ),
  ModerationReportStatus.inReview => const StatusBadgeStyle(
    label: 'Sedang ditinjau',
    icon: KapdhIcons.visibilityOutlined,
    foreground: KapdhColors.warning,
    background: KapdhColors.warningBg,
  ),
  ModerationReportStatus.resolved => const StatusBadgeStyle(
    label: 'Selesai',
    icon: KapdhIcons.checkCircle,
    foreground: KapdhColors.success,
    background: KapdhColors.successBg,
  ),
  ModerationReportStatus.dismissed => const StatusBadgeStyle(
    label: 'Ditutup',
    icon: KapdhIcons.doNotDisturbOnOutlined,
    foreground: KapdhColors.neutral,
    background: KapdhColors.neutralBg,
  ),
  ModerationReportStatus.unknown => const StatusBadgeStyle(
    label: 'Status tidak dikenal',
    icon: KapdhIcons.helpOutline,
    foreground: KapdhColors.neutral,
    background: KapdhColors.neutralBg,
  ),
};

/// Hasil yang terlihat pelapor tanpa merinci tindakan terhadap pihak lain (moderation.yaml ModerationOutcome).
String? reportOutcomeText(ModerationReport report) {
  final appeal = report.category == ModerationReportCategory.appeal;
  return switch (report.outcome) {
    ModerationOutcome.actionTaken => appeal ? 'Banding dikabulkan.' : 'Pengurus telah mengambil tindakan.',
    ModerationOutcome.noAction => appeal ? 'Banding ditolak.' : 'Tidak ada tindakan yang diperlukan.',
    _ => null,
  };
}

/// Objek yang dilaporkan dalam satu baris.
String reportTargetText(ModerationReport report) {
  final name = report.targetName ?? 'Akun tidak tersedia';
  final room = report.roomName;
  return switch (report.targetType) {
    ModerationTargetType.user =>
      report.category == ModerationReportCategory.appeal ? 'Banding pembatasan akun' : 'Pengguna: $name',
    ModerationTargetType.message => room == null ? 'Pesan dari $name' : 'Pesan dari $name di grup $room',
    ModerationTargetType.room => 'Grup: ${room ?? 'tidak tersedia'}',
    ModerationTargetType.unknown => name,
  };
}

/// Akun > Laporan Saya (F-12, AC F12-2): status dan hasil laporan yang dikirim pemanggil. Bukti, identitas pengurus
/// dan catatan internal tidak pernah dikirim server.
class MyReportsScreen extends ConsumerWidget {
  const MyReportsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(myReportsProvider);
    final controller = ref.read(myReportsProvider.notifier);

    Widget body;
    if (!state.loaded && state.error == null) {
      body = const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat laporan');
    } else if (!state.loaded) {
      body = ErrorState.fromException(state.error!, onRetry: controller.refresh);
    } else if (state.isEmpty) {
      body = const EmptyState(
        icon: KapdhIcons.flagOutlined,
        title: 'Belum ada laporan',
        message:
            'Laporan pengguna, pesan atau grup yang Anda kirim tampil di sini beserta statusnya. Laporan tidak '
            'dibuka kepada pihak yang dilaporkan.',
      );
    } else {
      body = RefreshIndicator(
        onRefresh: () => controller.refresh(silent: true),
        child: ListView.separated(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(KapdhSpace.s4),
          itemCount: state.items.length + 1,
          separatorBuilder: (_, _) => const SizedBox(height: KapdhSpace.s3),
          itemBuilder: (context, index) {
            if (index == state.items.length) {
              return PagedFooter(state: state, onRetry: controller.loadMore, onLoadMore: controller.loadMore);
            }
            final report = state.items[index];
            return _ReportCard(report: report, onTap: () => _showDetail(context, report.id));
          },
        ),
      );
    }
    return AppScaffold(title: 'Laporan Saya', fallbackLocation: AppRoutes.account, body: body);
  }

  Future<void> _showDetail(BuildContext context, String reportId) => showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _ReportDetailSheet(reportId: reportId),
  );
}

class _ReportCard extends StatelessWidget {
  const _ReportCard({required this.report, required this.onTap});

  final ModerationReport report;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final outcome = reportOutcomeText(report);
    // Kartu v2 (card card--md): garis rambut cardBorder + bayangan sm, radius 12.
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(KapdhRadius.md), boxShadow: context.kc.shadowSm),
      child: Card(
        margin: EdgeInsets.zero,
        elevation: 0,
        color: context.kc.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(KapdhRadius.md),
          side: BorderSide(color: context.kc.cardBorder),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(KapdhRadius.md),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(KapdhSpace.s4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Wrap: lencana turun ke baris berikut saat teks diperbesar 200 % (N-11).
                Wrap(
                  spacing: KapdhSpace.s2,
                  runSpacing: KapdhSpace.s1,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(reportCategoryLabel(report.category), style: const TextStyle(fontWeight: FontWeight.w600)),
                    StatusBadge(reportStatusStyle(report.status)),
                  ],
                ),
                const SizedBox(height: KapdhSpace.s1),
                Text(reportTargetText(report), style: TextStyle(color: context.kc.textMuted)),
                const SizedBox(height: KapdhSpace.s1),
                Text(
                  'Dikirim ${formatDateTime(report.createdAt)}',
                  style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
                ),
                if (outcome != null) ...[
                  const SizedBox(height: KapdhSpace.s2),
                  Text(outcome, style: const TextStyle(fontSize: KapdhFontSize.caption)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ReportDetailSheet extends ConsumerWidget {
  const _ReportDetailSheet({required this.reportId});

  final String reportId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(myReportDetailProvider(reportId));
    return SafeArea(
      child: detail.when(
        loading: () => const LoadingSkeleton(showCard: false, lines: 5, semanticsLabel: 'Memuat detail laporan'),
        error: (error, _) => error is ApiException
            ? ErrorState.fromException(error, onRetry: () => ref.invalidate(myReportDetailProvider(reportId)))
            : ErrorState(title: 'Terjadi kesalahan', message: '$error'),
        data: (report) {
          final outcome = reportOutcomeText(report);
          final open = report.status == ModerationReportStatus.open || report.status == ModerationReportStatus.inReview;
          return ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, 0, KapdhSpace.s5, KapdhSpace.s6),
            children: [
              Semantics(
                header: true,
                child: Text(
                  reportCategoryLabel(report.category),
                  // [v2] Judul lembar mengikuti .sheet__title: w700, tinggi baris 1.45.
                  style: const TextStyle(fontSize: KapdhFontSize.h3, fontWeight: FontWeight.w700, height: 1.45),
                ),
              ),
              const SizedBox(height: KapdhSpace.s2),
              Align(alignment: Alignment.centerLeft, child: StatusBadge(reportStatusStyle(report.status))),
              const SizedBox(height: KapdhSpace.s4),
              SummaryCard(
                title: 'Rincian laporan',
                rows: [
                  SummaryRow('Objek', reportTargetText(report)),
                  SummaryRow('Dikirim', formatDateTime(report.createdAt)),
                  if (open) SummaryRow('Target penanganan', formatDateTime(report.dueAt)),
                  if (report.resolvedAt != null) SummaryRow('Diputus', formatDateTime(report.resolvedAt!)),
                ],
              ),
              if (report.description != null && report.description!.trim().isNotEmpty) ...[
                const SizedBox(height: KapdhSpace.s4),
                const Text('Penjelasan Anda', style: TextStyle(fontWeight: FontWeight.w500)),
                const SizedBox(height: KapdhSpace.s1),
                Text(report.description!),
              ],
              if (outcome != null) ...[
                const SizedBox(height: KapdhSpace.s4),
                InfoBox(
                  tone: report.outcome == ModerationOutcome.actionTaken ? InfoBoxTone.info : InfoBoxTone.warning,
                  title: 'Hasil',
                  message: outcome,
                ),
              ],
              if (report.decisionMessage != null && report.decisionMessage!.trim().isNotEmpty) ...[
                const SizedBox(height: KapdhSpace.s3),
                const Text('Pesan pengurus', style: TextStyle(fontWeight: FontWeight.w500)),
                const SizedBox(height: KapdhSpace.s1),
                Text(report.decisionMessage!),
              ],
            ],
          );
        },
      ),
    );
  }
}
