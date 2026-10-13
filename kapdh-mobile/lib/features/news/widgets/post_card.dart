import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/format/formatters.dart';
import '../../home/shared/content_widgets.dart';
import '../../home/shared/remote_image.dart';

/// Kartu berita: cover, kategori, judul, ringkasan, tanggal terbit (WIB) dan jumlah like (F-08).
class PostCard extends StatelessWidget {
  const PostCard({super.key, required this.post, this.onTap});

  final PostSummary post;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final date = formatDate(post.publishedAt);
    final likes = '${post.likeCount} suka';
    final excerpt = post.excerpt;
    return TappableCard(
      onTap: onTap,
      padding: EdgeInsets.zero,
      semanticsLabel: [
        post.title,
        ?post.category?.label,
        'terbit $date',
        likes,
        if (post.likedByMe) 'Anda menyukai berita ini',
      ].join(', '),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (post.coverUrl != null)
            AspectRatio(
              aspectRatio: 16 / 9,
              child: RemoteImage(url: post.coverUrl, placeholderIcon: Icons.article_outlined),
            ),
          Padding(
            padding: const EdgeInsets.all(KapdhSpace.s3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (post.category != null) ...[CategoryChip(post.category!.label), const SizedBox(height: 6)],
                Text(
                  post.title,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600, height: 1.35),
                ),
                if (excerpt != null && excerpt.trim().isNotEmpty) ...[
                  const SizedBox(height: KapdhSpace.s1),
                  Text(
                    excerpt,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13, color: KapdhColors.textMuted, height: 1.45),
                  ),
                ],
                const SizedBox(height: KapdhSpace.s2),
                Row(
                  children: [
                    Expanded(child: IconLine(icon: Icons.calendar_today_outlined, text: date)),
                    Icon(
                      post.likedByMe ? Icons.favorite : Icons.favorite_border,
                      size: 14,
                      color: post.likedByMe ? KapdhColors.danger : KapdhColors.textMuted,
                    ),
                    const SizedBox(width: KapdhSpace.s1),
                    Text(likes, style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted)),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
