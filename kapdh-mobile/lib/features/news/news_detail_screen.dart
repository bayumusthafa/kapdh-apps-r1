import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import '../home/shared/content_widgets.dart';
import '../home/shared/member_gate.dart';
import '../home/shared/remote_image.dart';
import 'news_controllers.dart';
import 'widgets/post_body.dart';

/// Detail Berita (F-08): cover, kategori, judul, tanggal terbit, isi HTML tersanitasi server dengan penanda tautan
/// luar, dan like idempoten (AC F08-1, F08-3). Berita yang diarsipkan/belum terbit menghasilkan 404 dan tampil
/// "Berita tidak lagi tersedia", termasuk saat dibuka dari banner atau notifikasi lama (AC F08-2, AC F13-3).
class NewsDetailScreen extends ConsumerWidget {
  const NewsDetailScreen({super.key, required this.slug});

  /// Parameter rute `slug`.
  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(sessionProvider.select((session) => session.effectiveStatus));
    if (!isActiveMember(status)) {
      return AppScaffold(
        title: 'Detail Berita',
        fallbackLocation: AppRoutes.home,
        body: MemberOnlyNotice(feature: 'Berita', status: status),
      );
    }
    final provider = postDetailControllerProvider(slug);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final post = state.post;
    final error = state.error;

    Widget body;
    if (post == null && state.loading) {
      body = ListView(children: const [LoadingSkeleton(lines: 8, semanticsLabel: 'Memuat berita')]);
    } else if (post == null && error != null) {
      body = error.code == ErrorCode.notFound
          ? EmptyState(
              icon: Icons.search_off,
              title: 'Berita tidak lagi tersedia',
              message: 'Berita ini sudah diarsipkan atau belum diterbitkan pengurus.',
              actionLabel: 'Lihat berita lain',
              onAction: () => context.go(AppRoutes.news),
            )
          : ErrorState.fromException(error, onRetry: () => unawaited(controller.reload()));
    } else {
      body = _PostContent(post: post!, state: state, onToggleLike: () => _toggleLike(ref, controller));
    }
    return AppScaffold(title: 'Detail Berita', fallbackLocation: AppRoutes.news, body: body);
  }

  Future<void> _toggleLike(WidgetRef ref, PostDetailController controller) async {
    final error = await controller.toggleLike();
    if (error != null) {
      await ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(controller.toggleLike()));
    }
  }
}

class _PostContent extends StatelessWidget {
  const _PostContent({required this.post, required this.state, required this.onToggleLike});

  final Post post;
  final PostDetailState state;
  final VoidCallback onToggleLike;

  @override
  Widget build(BuildContext context) {
    return ListView(
      key: const ValueKey('post-detail'),
      padding: const EdgeInsets.only(bottom: KapdhSpace.s8),
      children: [
        if (post.coverUrl != null)
          AspectRatio(
            aspectRatio: 16 / 9,
            child: RemoteImage(url: post.coverUrl, semanticLabel: 'Cover berita ${post.title}'),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (post.category != null) ...[CategoryChip(post.category!.label), const SizedBox(height: KapdhSpace.s2)],
              Semantics(
                header: true,
                child: Text(
                  post.title,
                  style: const TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w700, height: 1.3),
                ),
              ),
              const SizedBox(height: KapdhSpace.s2),
              IconLine(icon: Icons.calendar_today_outlined, text: 'Terbit ${formatDateTime(post.publishedAt)}'),
              const SizedBox(height: KapdhSpace.s4),
              PostBody(html: post.bodyHtml),
              const SizedBox(height: KapdhSpace.s5),
              const Divider(),
              const SizedBox(height: KapdhSpace.s3),
              _LikeBar(liked: state.liked, count: state.likeCount, busy: state.likeBusy, onPressed: onToggleLike),
            ],
          ),
        ),
      ],
    );
  }
}

/// Tombol suka: satu like per anggota per berita; tombol nonaktif selama request sehingga ketukan ganda tidak
/// mengirim permintaan kedua, dan jumlah selalu dari server (AC F08-3).
class _LikeBar extends StatelessWidget {
  const _LikeBar({required this.liked, required this.count, required this.busy, required this.onPressed});

  final bool liked;
  final int count;
  final bool busy;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final countLabel = '$count suka';
    return Row(
      children: [
        Semantics(
          button: true,
          toggled: liked,
          label: liked ? 'Batal suka' : 'Suka',
          hint: countLabel,
          excludeSemantics: true,
          onTap: busy ? null : onPressed,
          child: OutlinedButton.icon(
            key: const ValueKey('post-like'),
            onPressed: busy ? null : onPressed,
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
              foregroundColor: liked ? KapdhColors.danger : KapdhColors.primary,
              side: BorderSide(color: liked ? KapdhColors.danger : KapdhColors.primary),
            ),
            icon: busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : Icon(liked ? Icons.favorite : Icons.favorite_border, size: 20),
            label: Text(liked ? 'Disukai' : 'Suka'),
          ),
        ),
        const SizedBox(width: KapdhSpace.s3),
        Expanded(
          child: Text(
            countLabel,
            key: const ValueKey('post-like-count'),
            style: const TextStyle(fontSize: KapdhFontSize.body, color: KapdhColors.textMuted),
          ),
        ),
      ],
    );
  }
}
