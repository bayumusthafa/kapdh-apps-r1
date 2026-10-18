import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import '../home/shared/member_gate.dart';
import '../home/shared/paged_list.dart';
import 'news_controllers.dart';
import 'widgets/post_card.dart';

/// Daftar Berita (F-08): feed berita terbit per kategori dengan muat berikutnya, tarik untuk menyegarkan, keadaan
/// kosong dan galat (AC F08-1, F08-4). Hanya anggota aktif (kontrak C4, PRD 2.2).
class NewsListScreen extends ConsumerStatefulWidget {
  const NewsListScreen({super.key});

  @override
  ConsumerState<NewsListScreen> createState() => _NewsListScreenState();
}

class _NewsListScreenState extends ConsumerState<NewsListScreen> {
  /// Slug kategori terpilih; null = "Semua".
  String? _category;

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(sessionProvider.select((session) => session.effectiveStatus));
    if (!isActiveMember(status)) {
      return AppScaffold(
        title: 'Berita',
        fallbackLocation: AppRoutes.home,
        body: MemberOnlyNotice(feature: 'Berita', status: status),
      );
    }
    final provider = postsControllerProvider(_category);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    return AppScaffold(
      title: 'Berita',
      fallbackLocation: AppRoutes.home,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _CategoryFilter(selected: _category, onSelected: (slug) => setState(() => _category = slug)),
          Expanded(
            child: PagedListView(
              key: ValueKey('posts-${_category ?? 'semua'}'),
              state: state,
              loadingSemantics: 'Memuat berita',
              onRefresh: controller.refresh,
              onLoadMore: () => unawaited(controller.loadMore()),
              itemBuilder: (context, post) =>
                  PostCard(post: post, onTap: () => unawaited(context.push(AppRoutes.newsDetail(post.slug)))),
              empty: EmptyState(
                icon: KapdhIcons.articleOutlined,
                title: _category == null ? 'Belum ada berita' : 'Belum ada berita di kategori ini',
                message: _category == null
                    ? 'Berita resmi pengurus akan tampil di sini setelah terbit.'
                    : 'Coba kategori lain atau lihat semua berita.',
                actionLabel: _category == null ? 'Muat ulang' : 'Lihat semua berita',
                onAction: _category == null
                    ? () => unawaited(controller.refresh())
                    : () => setState(() => _category = null),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CategoryFilter extends ConsumerWidget {
  const _CategoryFilter({required this.selected, required this.onSelected});

  final String? selected;
  final ValueChanged<String?> onSelected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Kategori gagal dimuat: hanya "Semua" (feed tetap dapat dibaca).
    final categories = ref.watch(newsCategoriesProvider).value ?? const [];
    if (categories.isEmpty) return const SizedBox.shrink();
    Widget chip(String label, String? slug) => Padding(
      padding: const EdgeInsets.only(right: KapdhSpace.s2),
      child: ChoiceChip(
        label: Text(label),
        selected: selected == slug,
        onSelected: (_) => onSelected(slug),
        selectedColor: KapdhColors.primary,
        labelStyle: TextStyle(
          color: selected == slug ? KapdhColors.onPrimary : KapdhColors.text,
          fontWeight: FontWeight.w600,
          fontSize: KapdhFontSize.caption,
        ),
        showCheckmark: false,
      ),
    );
    return Container(
      color: KapdhColors.surface,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s2, KapdhSpace.s3, KapdhSpace.s2),
        child: Row(
          children: [chip('Semua', null), for (final category in categories) chip(category.label, category.slug)],
        ),
      ),
    );
  }
}
