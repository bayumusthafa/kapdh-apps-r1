import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../design/design.dart';
import '../membership/academic.dart';
import 'directory_controller.dart';
import 'directory_filter.dart';
import 'paged_list.dart';
import 'widgets/directory_member_card.dart';
import 'widgets/tag_chip.dart';

/// Tab "Jejaring": hasil direktori anggota aktif (F-10) dengan chip filter aktif, total hasil dan paging keyset
/// tanpa duplikasi (AC F10-1).
class DirectoryTab extends ConsumerWidget {
  const DirectoryTab({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final filter = ref.watch(directoryFilterProvider);
    final state = ref.watch(directoryProvider);
    final controller = ref.read(directoryProvider.notifier);
    final filterController = ref.read(directoryFilterProvider.notifier);

    Widget body;
    if (!state.loaded && state.error == null) {
      body = const LoadingSkeleton(showCard: false, lines: 8, semanticsLabel: 'Memuat direktori alumni');
    } else if (!state.loaded && state.error != null) {
      body = ErrorState.fromException(state.error!, onRetry: controller.refresh);
    } else if (state.isEmpty) {
      body = EmptyState(
        icon: Icons.person_search_outlined,
        title: 'Alumni tidak ditemukan',
        message: filter.isEmpty
            ? 'Belum ada alumni aktif yang menampilkan profilnya di direktori.'
            : 'Tidak ada alumni yang cocok. Ubah kata kunci atau filter pencarian.',
        actionLabel: filter.isEmpty ? null : 'Atur ulang filter',
        onAction: filter.isEmpty ? null : filterController.reset,
      );
    } else {
      body = _DirectoryList(state: state, controller: controller);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _ActiveFilters(filter: filter, total: state.loaded ? state.total : null),
        if (state.loaded && state.error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s4, 0, KapdhSpace.s4, KapdhSpace.s2),
            child: InfoBox(
              tone: InfoBoxTone.warning,
              message: 'Hasil terbaru belum dapat dimuat. ${state.error!.message}',
              trailing: TextButton(onPressed: controller.refresh, child: const Text('Coba lagi')),
            ),
          ),
        Expanded(child: body),
      ],
    );
  }
}

class _ActiveFilters extends ConsumerWidget {
  const _ActiveFilters({required this.filter, required this.total});

  final DirectoryFilter filter;
  final int? total;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.read(directoryFilterProvider.notifier);
    DirectoryFilter without({
      bool cohort = false,
      bool classLevel = false,
      bool city = false,
      bool profession = false,
      bool skill = false,
      bool sort = false,
    }) => DirectoryFilter(
      cohort: cohort ? null : filter.cohort,
      classLevel: classLevel ? null : filter.classLevel,
      city: city ? null : filter.city,
      profession: profession ? null : filter.profession,
      skill: skill ? null : filter.skill,
      sort: sort ? DirectorySort.nameAsc : filter.sort,
    );
    final chips = <Widget>[
      if (filter.cohort != null)
        TagChip(
          label: 'Angkatan ${filter.cohort}',
          tone: TagChipTone.neutral,
          onDeleted: () => controller.applySheet(without(cohort: true)),
        ),
      if (filter.classLevel != null)
        TagChip(
          label: classLabel(filter.classLevel!),
          tone: TagChipTone.neutral,
          onDeleted: () => controller.applySheet(without(classLevel: true)),
        ),
      if (filter.city != null)
        TagChip(
          label: filter.city!,
          tone: TagChipTone.neutral,
          onDeleted: () => controller.applySheet(without(city: true)),
        ),
      if (filter.profession != null)
        TagChip(
          label: filter.profession!.label,
          tone: TagChipTone.neutral,
          onDeleted: () => controller.applySheet(without(profession: true)),
        ),
      if (filter.skill != null)
        TagChip(
          label: filter.skill!.label,
          tone: TagChipTone.neutral,
          onDeleted: () => controller.applySheet(without(skill: true)),
        ),
      if (filter.sort == DirectorySort.cohortDesc)
        TagChip(
          label: 'Angkatan terbaru',
          tone: TagChipTone.neutral,
          onDeleted: () => controller.applySheet(without(sort: true)),
        ),
    ];
    final count = total;
    if (chips.isEmpty && count == null) return const SizedBox(height: KapdhSpace.s2);
    return Padding(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s4, KapdhSpace.s2, KapdhSpace.s4, KapdhSpace.s2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (chips.isNotEmpty) Wrap(spacing: KapdhSpace.s2, runSpacing: KapdhSpace.s1, children: chips),
          if (count != null)
            Semantics(
              liveRegion: true,
              child: Text(
                '$count alumni ditemukan',
                style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
              ),
            ),
        ],
      ),
    );
  }
}

class _DirectoryList extends StatelessWidget {
  const _DirectoryList({required this.state, required this.controller});

  final PagedState<DirectoryMember> state;
  final DirectoryController controller;

  @override
  Widget build(BuildContext context) {
    final items = state.items;
    return NotificationListener<ScrollNotification>(
      onNotification: (notification) {
        if (notification.metrics.extentAfter < 400 && state.hasMore && !state.loadingMore && state.moreError == null) {
          controller.loadMore();
        }
        return false;
      },
      child: RefreshIndicator(
        onRefresh: () => controller.refresh(silent: true),
        child: ListView.separated(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s4, 0, KapdhSpace.s4, KapdhSpace.s6),
          itemCount: items.length + 1,
          separatorBuilder: (_, _) => const SizedBox(height: KapdhSpace.s3),
          itemBuilder: (context, index) {
            if (index == items.length) {
              return PagedFooter(state: state, onRetry: controller.loadMore, onLoadMore: controller.loadMore);
            }
            final member = items[index];
            return DirectoryMemberCard(member: member, onTap: () => context.push(AppRoutes.member(member.userId)));
          },
        ),
      ),
    );
  }
}

/// Akhir daftar ber-paging: indikator memuat, galat dengan coba lagi, atau tombol muat lebih banyak (target sentuh
/// tetap tersedia bagi pengguna yang tidak menggulir, N-11).
class PagedFooter extends StatelessWidget {
  const PagedFooter({super.key, required this.state, required this.onRetry, required this.onLoadMore});

  final PagedState<Object?> state;
  final VoidCallback onRetry;
  final VoidCallback onLoadMore;

  @override
  Widget build(BuildContext context) {
    if (state.loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(KapdhSpace.s4),
        child: Center(
          child: SizedBox(
            width: 24,
            height: 24,
            child: CircularProgressIndicator(strokeWidth: 2, semanticsLabel: 'Memuat lebih banyak'),
          ),
        ),
      );
    }
    final moreError = state.moreError;
    if (moreError != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: KapdhSpace.s2),
        child: InfoBox(
          tone: InfoBoxTone.warning,
          message: moreError.message,
          trailing: TextButton(onPressed: onRetry, child: const Text('Coba lagi')),
        ),
      );
    }
    if (state.hasMore) {
      return Center(
        child: TextButton(onPressed: onLoadMore, child: const Text('Muat lebih banyak')),
      );
    }
    return const SizedBox(height: KapdhSpace.s2);
  }
}
