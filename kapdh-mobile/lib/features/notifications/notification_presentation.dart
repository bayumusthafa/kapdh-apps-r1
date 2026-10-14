import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/redirect.dart';
import '../../app/routes.dart';
import '../../core/deep_link/deep_links.dart';

/// Label dan ikon kategori notifikasi (ARCHITECTURE §4.7). Kategori selalu ditampilkan sebagai teks, bukan warna saja
/// (PRD 4.5).
({String label, IconData icon}) notificationCategoryStyle(NotificationCategory category) => switch (category) {
  NotificationCategory.payment => (label: 'Pembayaran', icon: Icons.payments_outlined),
  NotificationCategory.membership => (label: 'Keanggotaan', icon: Icons.badge_outlined),
  NotificationCategory.event => (label: 'Event', icon: Icons.event_outlined),
  NotificationCategory.news => (label: 'Berita', icon: Icons.article_outlined),
  NotificationCategory.chat => (label: 'Chat', icon: Icons.chat_bubble_outline),
  NotificationCategory.security => (label: 'Keamanan akun', icon: Icons.shield_outlined),
  NotificationCategory.account => (label: 'Akun', icon: Icons.manage_accounts_outlined),
  NotificationCategory.unknown => (label: 'Informasi', icon: Icons.notifications_none),
};

/// Lokasi internal dari `deep_link` (`kapdh://app/<rute>`, kontrak C7). Null bila notifikasi hanya informasi, tautan
/// tidak sah, atau rutenya tidak dikenal versi aplikasi ini (kontrak: rute tak dikenal membuka kotak masuk).
Uri? notificationTarget(String? deepLink) {
  final location = DeepLinks.parse(deepLink);
  if (location == null) return null;
  final group = routeGroupOf(location.path);
  if (group == RouteGroup.unknown) return null;
  return location;
}

/// Cabang cangkang tab bawah (router.dart): rute di bawahnya dibuka dengan `go` karena StatefulShellRoute tidak
/// di-push dari luar cangkang.
const Set<String> _shellBranches = {'home', 'events', 'kta', 'network', 'account'};

/// Membuka tujuan notifikasi. Rute detail di luar cangkang di-push agar tombol kembali kembali ke kotak masuk;
/// [replace] mengganti lokasi saat ini (gerbang ketukan push). Semua jalur melewati redirect yang memeriksa sesi dan
/// status lebih dulu (AC F13-3); endpoint objek tujuan tetap memeriksa izin di server (PRD 2.1).
void openNotificationTarget(BuildContext context, Uri location, {bool replace = false}) {
  final router = GoRouter.of(context);
  final target = location.hasQuery ? '${location.path}?${location.query}' : location.path;
  final segments = location.pathSegments;
  final inShell = segments.isNotEmpty && _shellBranches.contains(segments.first);
  if (replace || inShell || target == AppRoutes.notifications) {
    router.go(target);
  } else {
    router.push(target);
  }
}
