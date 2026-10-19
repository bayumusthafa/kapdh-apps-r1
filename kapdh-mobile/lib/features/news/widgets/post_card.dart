import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_palette.dart';
import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/format/formatters.dart';
import '../../../design/kapdh_icons.dart';
import '../../home/shared/content_widgets.dart';
import '../../home/shared/remote_image.dart';

/// Tampilan kartu berita. [standard] dipakai halaman Berita; Beranda v2 memakai [hero] untuk berita pertama (kategori,
/// tanggal dan suka di atas gambar berscrim) dan [compact] untuk sisanya (baris dengan sampul 80 x 80).
enum PostCardVariant { standard, hero, compact }

/// Kartu berita: cover, kategori, judul, ringkasan, tanggal terbit (WIB) dan jumlah like (F-08).
class PostCard extends StatelessWidget {
  const PostCard({super.key, required this.post, this.onTap, this.variant = PostCardVariant.standard});

  final PostSummary post;
  final VoidCallback? onTap;
  final PostCardVariant variant;

  @override
  Widget build(BuildContext context) {
    final date = formatDate(post.publishedAt);
    final likes = '${post.likeCount} suka';
    return TappableCard(
      onTap: onTap,
      padding: variant == PostCardVariant.compact ? const EdgeInsets.all(KapdhSpace.s3) : EdgeInsets.zero,
      semanticsLabel: [
        post.title,
        ?post.category?.label,
        'terbit $date',
        likes,
        if (post.likedByMe) 'Anda menyukai berita ini',
      ].join(', '),
      child: switch (variant) {
        PostCardVariant.standard => _standard(context, date, likes),
        PostCardVariant.hero => _hero(context, date, likes),
        PostCardVariant.compact => _compact(context, date, likes),
      },
    );
  }

  Widget _likes(BuildContext context, String likes, {Color? color, Color? likedColor}) {
    final muted = color ?? context.kc.textMuted;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          post.likedByMe ? KapdhIcons.favorite : KapdhIcons.favoriteBorder,
          size: 14,
          color: post.likedByMe ? (likedColor ?? context.kc.danger) : muted,
        ),
        const SizedBox(width: KapdhSpace.s1),
        Text(
          likes,
          style: TextStyle(fontSize: KapdhFontSize.caption, color: muted),
        ),
      ],
    );
  }

  Widget _excerpt(BuildContext context) {
    final excerpt = post.excerpt;
    if (excerpt == null || excerpt.trim().isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: KapdhSpace.s1),
      child: Text(
        excerpt,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 13, color: context.kc.textMuted, height: 1.45),
      ),
    );
  }

  Widget _standard(BuildContext context, String date, String likes) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (post.coverUrl != null)
          AspectRatio(
            aspectRatio: 16 / 9,
            child: RemoteImage(url: post.coverUrl, placeholderIcon: KapdhIcons.articleOutlined),
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
              _excerpt(context),
              const SizedBox(height: KapdhSpace.s2),
              Row(
                children: [
                  Expanded(
                    child: IconLine(icon: KapdhIcons.calendarTodayOutlined, text: date),
                  ),
                  _likes(context, likes),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _hero(BuildContext context, String date, String likes) {
    const onImage = Color(0xEBFFFFFF);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AspectRatio(
          aspectRatio: 16 / 9,
          child: Stack(
            fit: StackFit.expand,
            children: [
              RemoteImage(url: post.coverUrl, placeholderIcon: KapdhIcons.articleOutlined),
              const DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.bottomCenter,
                    end: Alignment.topCenter,
                    colors: [Color(0xB8000000), Color(0x2E000000), Color(0x00000000)],
                    stops: [0, 0.42, 0.7],
                  ),
                ),
              ),
              if (post.category != null)
                Positioned(
                  top: KapdhSpace.s3,
                  left: KapdhSpace.s3,
                  child: CategoryChip(post.category!.label, onImage: true),
                ),
              Positioned(
                left: KapdhSpace.s3,
                right: KapdhSpace.s3,
                bottom: 10,
                child: Row(
                  children: [
                    Expanded(
                      child: IconLine(icon: KapdhIcons.calendarTodayOutlined, text: date, color: onImage),
                    ),
                    // Merah muda 6,9:1 di scrim gelap untuk suka milik sendiri.
                    _likes(context, likes, color: onImage, likedColor: const Color(0xFFFFB4AB)),
                  ],
                ),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, KapdhSpace.s3, 14, 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                post.title,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, height: 1.35),
              ),
              _excerpt(context),
            ],
          ),
        ),
      ],
    );
  }

  Widget _compact(BuildContext context, String date, String likes) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        RemoteImage(
          url: post.coverUrl,
          width: 80,
          height: 80,
          borderRadius: BorderRadius.circular(KapdhRadius.md),
          placeholderIcon: KapdhIcons.articleOutlined,
        ),
        const SizedBox(width: KapdhSpace.s3),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Wrap: suka turun ke baris berikut pada teks besar (N-11). SizedBox membuat Wrap selebar kolom supaya
              // spaceBetween menaruh suka di kanan.
              SizedBox(
                width: double.infinity,
                child: Wrap(
                  alignment: WrapAlignment.spaceBetween,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: KapdhSpace.s2,
                  runSpacing: KapdhSpace.s1,
                  children: [if (post.category != null) CategoryChip(post.category!.label), _likes(context, likes)],
                ),
              ),
              const SizedBox(height: 6),
              Text(
                post.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600, height: 1.35),
              ),
              const SizedBox(height: KapdhSpace.s1),
              Text(
                date,
                style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
