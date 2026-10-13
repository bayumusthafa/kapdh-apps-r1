// Fixture JSON domain Content (kontrak C4, content.yaml): Beranda, banner, berita dan like. Setiap builder mengisi
// SEMUA field wajib skema; field nullable dikirim null bila tidak berlaku.

import '../../support/fakes.dart';
import '../events/event_fixtures.dart' show eventEndsAt, eventStartsAt, iso;

Map<String, Object?> postCategoryJson({String slug = 'pengumuman', String label = 'Pengumuman'}) => {
  'id': 'cat-$slug',
  'slug': slug,
  'label': label,
};

Map<String, Object?> postSummaryJson({
  String id = 'post-1',
  String slug = 'halal-bihalal-2026',
  String title = 'Halal Bihalal Alumni 2026',
  String? excerpt = 'Silaturahmi akbar alumni Darel Hikmah di Pekanbaru.',
  bool withCover = true,
  Map<String, Object?>? category,
  int likeCount = 3,
  bool likedByMe = false,
  DateTime? publishedAt,
}) => {
  'id': id,
  'slug': slug,
  'title': title,
  'excerpt': excerpt,
  'cover_url': withCover ? 'https://files.kapdh.or.id/posts/$id.jpg' : null,
  'category': category ?? postCategoryJson(),
  'published_at': iso(publishedAt ?? testNow.subtract(const Duration(days: 1))),
  'like_count': likeCount,
  'liked_by_me': likedByMe,
};

Map<String, Object?> postJson({
  String slug = 'halal-bihalal-2026',
  String title = 'Halal Bihalal Alumni 2026',
  String bodyHtml =
      '<p>Assalamu\'alaikum. Halal bihalal alumni digelar di aula pondok.</p>'
      '<p>Info lengkap di <a href="https://contoh.org/info" target="_blank" rel="noopener noreferrer nofollow" '
      'data-external="true">situs panitia</a>.</p>',
  int likeCount = 3,
  bool likedByMe = false,
}) => {
  ...postSummaryJson(slug: slug, title: title, likeCount: likeCount, likedByMe: likedByMe),
  'body_html': bodyHtml,
  'updated_at': iso(testNow.subtract(const Duration(hours: 20))),
};

Map<String, Object?> postPageJson(List<Map<String, Object?>> items, {String? nextCursor}) => {
  'items': items,
  'next_cursor': nextCursor,
};

Map<String, Object?> likeStateJson({required bool liked, required int count}) => {'liked': liked, 'like_count': count};

Map<String, Object?> bannerJson({
  String id = 'banner-1',
  String title = 'Reuni Akbar 2026',
  String type = 'post',
  bool available = true,
  String? route = '/news/halal-bihalal-2026',
  String? url,
}) => {
  'id': id,
  'title': title,
  'image_url': 'https://files.kapdh.or.id/banners/$id.jpg',
  'target': {
    'type': type,
    'available': available,
    'route': route,
    'url': url,
    'external': type == 'url',
  },
};

Map<String, Object?> homeEventJson({
  String id = 'event-1',
  String title = 'Camping Alumni KAPDH',
  String registrationState = 'open',
  String price = '200000.00',
}) => {
  'id': id,
  'title': title,
  'cover_url': 'https://files.kapdh.or.id/events/$id.jpg',
  'category': {'id': 'cat-reuni', 'slug': 'reuni', 'label': 'Reuni'},
  'starts_at': iso(eventStartsAt),
  'ends_at': iso(eventEndsAt),
  'timezone': 'Asia/Jakarta',
  'location_name': 'Bumi Perkemahan Cibubur',
  'price': price,
  'is_free': price == '0.00',
  'seats_total': 36,
  'seats_available': 20,
  'registration_state': registrationState,
  'registration_opens_at': iso(DateTime.utc(2026, 10, 1)),
  'registration_closes_at': iso(DateTime.utc(2026, 10, 19, 17)),
};

Map<String, Object?> homeJson({
  List<Map<String, Object?>>? banners,
  List<Map<String, Object?>>? events,
  List<Map<String, Object?>>? posts,
  int unread = 2,
  String status = 'verified',
  DateTime? expiresAt,
  DateTime? generatedAt,
}) => {
  'banners': banners ?? [bannerJson()],
  'upcoming_events': events ?? [homeEventJson()],
  'posts': posts ?? [postSummaryJson()],
  'quick_access': {
    'unread_notification_count': unread,
    'effective_status': status,
    'member_number': '29.01.01.7',
    'expires_at': expiresAt == null ? null : iso(expiresAt),
  },
  'generated_at': iso(generatedAt ?? testNow),
};

/// Beranda tanpa banner, event dan berita (feed kosong, AC F08-4).
Map<String, Object?> emptyHomeJson() => homeJson(banners: const [], events: const [], posts: const []);
