import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../home/shared/paged_list.dart';
import 'news_repository.dart';

/// Keadaan like terbaru dari server untuk satu berita; disiarkan agar feed dan Beranda menampilkan jumlah yang sama
/// tanpa memuat ulang (AC F08-3).
@immutable
class PostLikeEvent {
  const PostLikeEvent(this.slug, this.state);

  final String slug;
  final LikeState state;
}

final postLikeEventProvider = NotifierProvider<PostLikeEvents, PostLikeEvent?>(PostLikeEvents.new);

class PostLikeEvents extends Notifier<PostLikeEvent?> {
  @override
  PostLikeEvent? build() => null;

  void publish(String slug, LikeState like) => state = PostLikeEvent(slug, like);
}

/// Ringkasan berita dengan keadaan like dari server.
PostSummary postWithLike(PostSummary post, LikeState like) => PostSummary(
  id: post.id,
  slug: post.slug,
  title: post.title,
  excerpt: post.excerpt,
  coverUrl: post.coverUrl,
  category: post.category,
  publishedAt: post.publishedAt,
  likeCount: like.likeCount,
  likedByMe: like.liked,
);

/// Kategori berita aktif untuk tab filter; gagal memuat tidak menghalangi feed ("Semua" tetap tersedia).
final newsCategoriesProvider = FutureProvider.autoDispose<List<ContentCategory>>(
  (ref) => ref.watch(newsRepositoryProvider).listCategories(),
  retry: (retryCount, error) => null,
);

/// Feed berita per slug kategori (null = semua).
final postsControllerProvider = NotifierProvider.autoDispose.family<PostsController, PagedState<PostSummary>, String?>(
  PostsController.new,
);

class PostsController extends PagedController<PostSummary> {
  PostsController(this.categorySlug);

  final String? categorySlug;

  @override
  PagedState<PostSummary> build() {
    ref.listen(postLikeEventProvider, (previous, event) {
      if (event == null) return;
      replaceWhere((post) => post.slug == event.slug, (post) => postWithLike(post, event.state));
    });
    return super.build();
  }

  @override
  Future<CursorPage<PostSummary>> fetchPage(String? cursor) =>
      ref.read(newsRepositoryProvider).listPosts(categorySlug: categorySlug, cursor: cursor);

  @override
  Object keyOf(PostSummary item) => item.id;
}

/// Keadaan detail berita (F-08, AC F08-1, F08-3).
@immutable
class PostDetailState {
  const PostDetailState({this.post, this.loading = true, this.error, this.likeBusy = false, this.like});

  final Post? post;
  final bool loading;
  final ApiException? error;

  /// Permintaan like/unlike sedang berjalan; tombol nonaktif sehingga ketukan ganda tidak mengirim request kedua.
  final bool likeBusy;

  /// Keadaan like terbaru dari server (menggantikan nilai pada [post]).
  final LikeState? like;

  bool get liked => like?.liked ?? post?.likedByMe ?? false;

  int get likeCount => like?.likeCount ?? post?.likeCount ?? 0;
}

final postDetailControllerProvider = NotifierProvider.autoDispose.family<PostDetailController, PostDetailState, String>(
  PostDetailController.new,
);

class PostDetailController extends Notifier<PostDetailState> {
  PostDetailController(this.slug);

  final String slug;
  int _generation = 0;

  @override
  PostDetailState build() {
    final generation = ++_generation;
    scheduleMicrotask(() {
      if (ref.mounted && generation == _generation) unawaited(reload());
    });
    return const PostDetailState();
  }

  Future<void> reload() async {
    final generation = ++_generation;
    state = PostDetailState(post: state.post, like: state.like);
    try {
      final post = await ref.read(newsRepositoryProvider).getPost(slug);
      if (!ref.mounted || generation != _generation) return;
      state = PostDetailState(post: post, loading: false);
    } on ApiException catch (error) {
      if (!ref.mounted || generation != _generation) return;
      state = PostDetailState(post: state.post, like: state.like, loading: false, error: error);
      reportStatusError(ref, error);
    }
  }

  /// Menyukai atau membatalkan; hasil selalu keadaan akhir dari server (AC F08-3). Galat dikembalikan ke layar.
  Future<ApiException?> toggleLike() async {
    final current = state;
    if (current.post == null || current.likeBusy) return null;
    state = PostDetailState(post: current.post, loading: false, like: current.like, likeBusy: true);
    try {
      final like = await ref.read(newsRepositoryProvider).setLiked(slug, liked: !current.liked);
      if (!ref.mounted) return null;
      state = PostDetailState(post: state.post, loading: false, like: like);
      ref.read(postLikeEventProvider.notifier).publish(slug, like);
      return null;
    } on ApiException catch (error) {
      if (!ref.mounted) return error;
      state = PostDetailState(post: state.post, loading: false, like: state.like);
      reportStatusError(ref, error);
      return error;
    }
  }
}
