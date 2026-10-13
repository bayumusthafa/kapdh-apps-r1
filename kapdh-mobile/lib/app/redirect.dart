import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../core/app_gate/app_gate.dart';
import '../core/deep_link/deep_links.dart';
import '../core/session/session_state.dart';
import 'routes.dart';

/// Kelompok rute untuk matriks akses (ARCHITECTURE §8.4, PRD 2.2).
enum RouteGroup {
  splash,
  updateRequired,
  maintenance,
  login,
  register,
  registerOtp,
  forgot,
  forgotOtp,
  forgotReset,
  legal,
  onboarding,
  payments,
  home,
  news,
  events,

  /// Detail satu event `/events/:eventId`: juga dibuka anggota expired untuk event yang pernah ia pesan (tiket lunas
  /// tetap berlaku, deep link notifikasi event; kontrak C5 getEvent `nonsuspended`). Server menjawab 403
  /// MEMBERSHIP_REQUIRED untuk event lain dan layar menjelaskannya.
  eventDetail,
  tickets,
  kta,
  renewal,
  network,
  chat,
  notifications,
  account,

  /// Blokir dan laporan milik sendiri: tindakan komunitas, hanya anggota aktif.
  accountCommunity,
  accountDelete,
  restricted,
  deletionStatus,

  /// Path yang tidak dikenal aplikasi (termasuk `/`).
  unknown,
}

const Set<RouteGroup> _authGroups = {
  RouteGroup.login,
  RouteGroup.register,
  RouteGroup.registerOtp,
  RouteGroup.forgot,
  RouteGroup.forgotOtp,
  RouteGroup.forgotReset,
};

const Set<RouteGroup> _systemGroups = {RouteGroup.splash, RouteGroup.updateRequired, RouteGroup.maintenance};

/// Kelompok rute dari path.
RouteGroup routeGroupOf(String path) {
  final segments = path.split('/').where((s) => s.isNotEmpty).toList();
  if (segments.isEmpty) return RouteGroup.unknown;
  final first = segments.first;
  final second = segments.length > 1 ? segments[1] : null;
  final single = segments.length == 1;
  return switch (first) {
    'splash' when single => RouteGroup.splash,
    'update-required' when single => RouteGroup.updateRequired,
    'maintenance' when single => RouteGroup.maintenance,
    'login' when single => RouteGroup.login,
    'register' when single => RouteGroup.register,
    'register' when second == 'otp' && segments.length == 2 => RouteGroup.registerOtp,
    'forgot' when single => RouteGroup.forgot,
    'forgot' when second == 'otp' && segments.length == 2 => RouteGroup.forgotOtp,
    'forgot' when second == 'reset' && segments.length == 2 => RouteGroup.forgotReset,
    'legal' when segments.length == 2 => RouteGroup.legal,
    'onboarding' when !single => RouteGroup.onboarding,
    'payments' => RouteGroup.payments,
    'home' when single => RouteGroup.home,
    'news' => RouteGroup.news,
    'events' when segments.length == 2 => RouteGroup.eventDetail,
    'events' => RouteGroup.events,
    'tickets' => RouteGroup.tickets,
    'kta' when single => RouteGroup.kta,
    'renewal' when single => RouteGroup.renewal,
    'network' => RouteGroup.network,
    'chat' when !single => RouteGroup.chat,
    'notifications' when single => RouteGroup.notifications,
    'account' when single => RouteGroup.account,
    'account' when second == 'blocked' || second == 'reports' => RouteGroup.accountCommunity,
    'account' when second == 'delete' => RouteGroup.accountDelete,
    'account' => RouteGroup.account,
    'restricted' when single => RouteGroup.restricted,
    'deletion-status' when single => RouteGroup.deletionStatus,
    _ => RouteGroup.unknown,
  };
}

/// Fitur anggota yang tersedia untuk unverified, verified, expiring dan expired: beranda/berita (informasi resmi),
/// KTA (dengan label status), riwayat pembayaran sendiri, kotak masuk, pengaturan akun dan hapus akun.
const Set<RouteGroup> _memberBase = {
  RouteGroup.home,
  RouteGroup.news,
  RouteGroup.kta,
  RouteGroup.payments,
  RouteGroup.notifications,
  RouteGroup.account,
  RouteGroup.accountDelete,
};

/// Matriks akses PRD 2.2 per effective_status. Legal selalu boleh dan ditangani terpisah. Server tetap menegakkan
/// izin di setiap endpoint (PRD 2.1); matriks ini hanya routing.
const Map<EffectiveStatus, Set<RouteGroup>> _allowed = {
  // Verifikasi/kirim ulang OTP; aplikasi utama, pembayaran dan KTA ditolak.
  EffectiveStatus.pendingOtp: {RouteGroup.registerOtp},
  // Profil minimum, KTA Tidak Aktif, instruksi iuran, bukti, status/riwayat sendiri, pengaturan akun, hapus akun.
  // Ditolak: KTA aktif, pemesanan event, direktori, chat.
  EffectiveStatus.unverified: {..._memberBase, RouteGroup.onboarding},
  // Seluruh fitur anggota.
  EffectiveStatus.verified: {
    ..._memberBase,
    RouteGroup.events,
    RouteGroup.eventDetail,
    RouteGroup.tickets,
    RouteGroup.network,
    RouteGroup.chat,
    RouteGroup.renewal,
    RouteGroup.accountCommunity,
  },
  EffectiveStatus.expiring: {
    ..._memberBase,
    RouteGroup.events,
    RouteGroup.eventDetail,
    RouteGroup.tickets,
    RouteGroup.network,
    RouteGroup.chat,
    RouteGroup.renewal,
    RouteGroup.accountCommunity,
  },
  // Riwayat sendiri, kartu kedaluwarsa, perpanjangan, pengaturan akun, hapus akun; tiket yang sudah paid sebelum
  // kedaluwarsa tetap dapat dilihat dan dipakai, beserta detail event yang pernah dipesan (kontrak C5 getEvent).
  // Ditolak: daftar event dan pemesanan baru, direktori, chat.
  EffectiveStatus.expired: {..._memberBase, RouteGroup.renewal, RouteGroup.tickets, RouteGroup.eventDetail},
  // Portal pembatasan, bantuan (legal) dan penghapusan setelah verifikasi identitas.
  EffectiveStatus.suspended: {RouteGroup.restricted, RouteGroup.accountDelete},
  // Pemeriksaan status penghapusan/pemulihan dengan challenge terbatas.
  EffectiveStatus.disabled: {RouteGroup.deletionStatus},
  EffectiveStatus.deletionPending: {RouteGroup.deletionStatus},
};

/// Rute yang tujuannya HANYA mutasi, sehingga tidak berguna selama maintenance (server menolak mutasi dengan 503
/// MAINTENANCE, PRD 4.5): seluruh alur auth (login, daftar, OTP, pemulihan sandi), pembayaran baru, perpanjangan,
/// ganti sandi, membuat grup chat dan hapus akun. Rute lain tetap dapat dibaca dalam mode baca terkendali; simpan
/// yang ditolak ditampilkan ErrorPresenter.
bool isMutationOnlyRoute(String path) {
  final group = routeGroupOf(path);
  if (_authGroups.contains(group)) return true;
  if (group == RouteGroup.renewal || group == RouteGroup.accountDelete) return true;
  return path == AppRoutes.accountPassword ||
      path == AppRoutes.chatNewGroup ||
      path.startsWith('${AppRoutes.payments}/new/');
}

/// Apakah [status] boleh membuka kelompok rute [group] (PRD 2.2). Legal selalu boleh.
bool isRouteAllowed(EffectiveStatus status, RouteGroup group) =>
    group == RouteGroup.legal || (_allowed[status]?.contains(group) ?? false);

/// Rute awal per status dari katalog bersama (`routeForStatus`, packages/shared). Status yang belum dikenal versi
/// aplikasi ini diarahkan ke layar wajib update; aplikasi tidak menebak akses.
String homeFor(EffectiveStatus status) => routeForStatus(status)?.path ?? AppRoutes.updateRequired;

/// Masukan redirect: keputusan gerbang aplikasi dan keadaan sesi.
@immutable
class RedirectState {
  const RedirectState({required this.gate, required this.session});

  final GateStatus gate;
  final SessionState session;
}

/// Redirect go_router (ARCHITECTURE §8.4; PRD 2.2, 4.5, AC F13-3). Fungsi murni; null berarti tetap di [location].
///
/// Urutan: legal selalu terbuka → gerbang aplikasi (pemeriksaan, wajib update, maintenance) → sesi (memuat, anonim,
/// aktif/offline) → matriks status. Tujuan yang ditunda (deep link, notifikasi) disimpan di `?from=` saat diarahkan
/// ke splash/login/maintenance dan dipulihkan setelah siap bila status mengizinkan.
String? resolveRedirect(RedirectState state, Uri location) {
  final path = location.path.isEmpty ? '/' : location.path;

  // App Links https://kapdh.or.id/app/<rute> tiba sebagai /app/<rute>.
  if (path == DeepLinks.webPrefix || path.startsWith('${DeepLinks.webPrefix}/')) {
    final normalized = DeepLinks.normalize(location);
    return normalized == null ? AppRoutes.splash : _locationString(normalized);
  }

  final group = routeGroupOf(path);
  if (group == RouteGroup.legal) return null;

  final session = state.session;
  switch (state.gate) {
    case GateStatus.checking:
      return group == RouteGroup.splash ? null : _withFrom(AppRoutes.splash, _pending(location, group));
    case GateStatus.updateRequired:
      return group == RouteGroup.updateRequired ? null : _withFrom(AppRoutes.updateRequired, _pending(location, group));
    case GateStatus.maintenance:
      if (group == RouteGroup.maintenance) return null;
      // Mode baca terkendali (PRD 4.5): server hanya menolak mutasi, jadi anggota tetap dapat membuka rute baca yang
      // diizinkan statusnya (KTA, tiket, riwayat pembayaran, berita, kotak masuk, akun) dengan pita pemeliharaan.
      if (_readableDuringMaintenance(session, group, path)) break;
      // Memulihkan sesi memakai GET /me (baca), tetap di splash sampai statusnya diketahui.
      if (group == RouteGroup.splash && session.phase == SessionPhase.unknown) return null;
      // Anonim (login ditolak), alur mutasi, splash setelah sesi siap: layar maintenance yang menjelaskan estimasi,
      // coba lagi dan (bila ada sesi) tombol lanjut dalam mode baca.
      return _withFrom(AppRoutes.maintenance, _pending(location, group));
    case GateStatus.ok:
    case GateStatus.unavailable:
      break;
  }

  // effective_status baru yang belum dikenal versi aplikasi ini.
  final status = session.effectiveStatus;
  if (status != null && routeForStatus(status) == null) {
    return group == RouteGroup.updateRequired ? null : AppRoutes.updateRequired;
  }
  if (group == RouteGroup.updateRequired || group == RouteGroup.maintenance) {
    return _landing(state, _fromParam(location));
  }

  switch (session.phase) {
    case SessionPhase.unknown:
      return group == RouteGroup.splash ? null : _withFrom(AppRoutes.splash, _pending(location, group));
    case SessionPhase.anonymous:
      return _anonymous(session, location, group);
    case SessionPhase.authenticated:
    case SessionPhase.offlineLastKnown:
      final current = status ?? EffectiveStatus.unknown;
      if (isRouteAllowed(current, group)) return null;
      if (group == RouteGroup.splash || _authGroups.contains(group)) return _landing(state, _fromParam(location));
      return homeFor(current);
  }
}

bool _readableDuringMaintenance(SessionState session, RouteGroup group, String path) {
  final status = session.effectiveStatus;
  if (!session.hasSession || status == null || routeForStatus(status) == null) return false;
  return isRouteAllowed(status, group) && !isMutationOnlyRoute(path);
}

/// Tujuan tombol "Lanjut dalam mode baca" di layar maintenance: tujuan tertunda `?from=` bila dapat dibaca, atau
/// rute awal status. Null bila tidak ada mode baca (anonim, pending_otp, status belum dikenal).
String? readOnlyLanding(RedirectState state, Uri location) {
  final status = state.session.effectiveStatus;
  if (!state.session.hasSession || status == null) return null;
  final from = _fromParam(location);
  if (from != null && resolveRedirect(state, from) == null) return _locationString(from);
  final home = homeFor(status);
  return resolveRedirect(state, Uri.parse(home)) == null ? home : null;
}

/// Apakah [location] boleh dibuka sekarang tanpa dialihkan (mis. untuk mengunci tab shell).
bool isLocationAllowed(RedirectState state, String location) => resolveRedirect(state, Uri.parse(location)) == null;

String? _anonymous(SessionState session, Uri location, RouteGroup group) {
  switch (group) {
    case RouteGroup.login:
    case RouteGroup.register:
    case RouteGroup.forgot:
      return null;
    case RouteGroup.registerOtp:
      return session.challenge?.purpose == OtpPurpose.signup ? null : AppRoutes.login;
    case RouteGroup.forgotOtp:
      return session.challenge?.purpose == OtpPurpose.passwordReset ? null : AppRoutes.forgot;
    case RouteGroup.forgotReset:
      return session.resetToken != null ? null : AppRoutes.forgot;
    case RouteGroup.splash:
      return _withFrom(AppRoutes.login, _fromParam(location));
    default:
      // Rute terlindungi: masuk dulu, lalu kembali ke tujuan (AC F13-3).
      return _withFrom(AppRoutes.login, _pending(location, group));
  }
}

/// Tujuan setelah layar sistem/auth selesai.
String _landing(RedirectState state, Uri? from) {
  final session = state.session;
  switch (session.phase) {
    case SessionPhase.unknown:
      return _withFrom(AppRoutes.splash, from);
    case SessionPhase.anonymous:
      return _withFrom(AppRoutes.login, from);
    case SessionPhase.authenticated:
    case SessionPhase.offlineLastKnown:
      if (from != null && resolveRedirect(state, from) == null) return _locationString(from);
      return homeFor(session.effectiveStatus ?? EffectiveStatus.unknown);
  }
}

/// Lokasi yang ditunda saat dialihkan dari [location]: layar sistem/auth meneruskan `from` miliknya sendiri; rute
/// lain menjadi tujuan yang ditunda.
Uri? _pending(Uri location, RouteGroup group) {
  if (_systemGroups.contains(group) || _authGroups.contains(group)) return _fromParam(location);
  if (group == RouteGroup.unknown) return null;
  return _sanitize(location);
}

Uri? _fromParam(Uri location) => _sanitize(DeepLinks.parse(location.queryParameters['from']));

/// Hanya rute internal fitur yang boleh menjadi tujuan tertunda (bukan sistem, auth atau path tak dikenal).
Uri? _sanitize(Uri? candidate) {
  if (candidate == null) return null;
  final normalized = DeepLinks.normalize(candidate);
  if (normalized == null) return null;
  final group = routeGroupOf(normalized.path);
  if (_systemGroups.contains(group) || _authGroups.contains(group) || group == RouteGroup.unknown) return null;
  return normalized;
}

String _withFrom(String path, Uri? from) =>
    from == null ? path : Uri(path: path, queryParameters: {'from': _locationString(from)}).toString();

String _locationString(Uri uri) => uri.hasQuery && uri.query.isNotEmpty ? '${uri.path}?${uri.query}' : uri.path;
