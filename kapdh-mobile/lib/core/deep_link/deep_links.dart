/// Normalisasi deep link ke lokasi rute internal (ARCHITECTURE §4.7, §8.4; AC F13-3).
///
/// Bentuk yang diterima:
/// - rute internal: `/payments/123`
/// - skema aplikasi: `kapdh://app/payments/123`
/// - App Links / Universal Links: `https://kapdh.or.id/app/payments/123`
/// - path dari platform untuk tautan https: `/app/payments/123`
///
/// Tautan ke host atau skema lain ditolak (null) agar notifikasi atau tautan luar tidak dapat mengarahkan aplikasi
/// ke tujuan sembarang. Otorisasi tetap diperiksa redirect router sebelum objek dibuka.
abstract final class DeepLinks {
  static const scheme = 'kapdh';
  static const schemeHost = 'app';
  static const webHosts = {'kapdh.or.id', 'www.kapdh.or.id'};
  static const webPrefix = '/app';

  /// Lokasi internal (path + query) atau null bila bukan tautan aplikasi yang sah.
  static Uri? normalize(Uri uri) {
    String path;
    if (uri.hasScheme) {
      final scheme = uri.scheme.toLowerCase();
      if (scheme == DeepLinks.scheme) {
        if (uri.host.toLowerCase() != schemeHost) return null;
        path = uri.path;
      } else if (scheme == 'https') {
        if (!webHosts.contains(uri.host.toLowerCase())) return null;
        if (uri.path != webPrefix && !uri.path.startsWith('$webPrefix/')) return null;
        path = uri.path.substring(webPrefix.length);
      } else {
        return null;
      }
    } else {
      if (uri.hasAuthority) return null;
      path = uri.path;
      if (path == webPrefix || path.startsWith('$webPrefix/')) path = path.substring(webPrefix.length);
    }
    if (path.isEmpty) path = '/';
    if (!path.startsWith('/') || path.startsWith('//')) return null;
    if (path.length > 1 && path.endsWith('/')) path = path.substring(0, path.length - 1);
    if (path.split('/').any((segment) => segment == '..' || segment == '.')) return null;
    return Uri(path: path, query: uri.hasQuery && uri.query.isNotEmpty ? uri.query : null);
  }

  /// Dari string mentah (payload notifikasi `data.route` / `deep_link`, `InboxNotification.deep_link`).
  static Uri? parse(String? raw) {
    if (raw == null) return null;
    final value = raw.trim();
    if (value.isEmpty || value.length > 2048) return null;
    final uri = Uri.tryParse(value);
    return uri == null ? null : normalize(uri);
  }
}
