import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../home/shared/paged_list.dart';

/// Repositori Berita (F-08) di atas `KapdhApi.content`. Server hanya mengirim berita published yang sudah waktunya
/// tampil (AC F08-1) dan menjaga satu like per anggota per berita (AC F08-3).
class NewsRepository {
  NewsRepository(this._content);

  final ContentApi _content;

  static const pageSize = 20;

  Future<CursorPage<PostSummary>> listPosts({String? categorySlug, String? cursor}) async {
    final page = await _content.listPosts(cursor: cursor, limit: pageSize, category: categorySlug);
    return (items: page.items, nextCursor: page.nextCursor);
  }

  /// Kategori berita aktif untuk tab filter (guideline "Manajemen Kategori").
  Future<List<ContentCategory>> listCategories() async =>
      (await _content.listCategories(kind: ContentCategoryKind.post)).items;

  Future<Post> getPost(String slug) => _content.getPost(slug);

  /// PUT/DELETE idempoten secara alami: mengulang tidak menambah like kedua (AC F08-3).
  Future<LikeState> setLiked(String slug, {required bool liked}) =>
      liked ? _content.likePost(slug) : _content.unlikePost(slug);
}

final newsRepositoryProvider = Provider<NewsRepository>((ref) => NewsRepository(ref.watch(kapdhApiProvider).content));
