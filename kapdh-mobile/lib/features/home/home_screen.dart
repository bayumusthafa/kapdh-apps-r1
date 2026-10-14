import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import '../events/widgets/event_card.dart';
import '../news/widgets/post_card.dart';
import '../notifications/notification_unread_count.dart';
import 'home_controller.dart';
import 'shared/content_widgets.dart';
import 'shared/member_gate.dart';
import 'widgets/banner_carousel.dart';
import 'widgets/home_widgets.dart';

/// Beranda (F-08; PRD 3.8): sapaan, banner aktif, akses cepat KTA/notifikasi, event mendatang dan berita terbaru,
/// dengan keadaan memuat, kosong, galat dan cache lama berwaktu pembaruan (AC F08-2, AC F08-4).
///
/// Anggota yang belum aktif (unverified) atau kedaluwarsa (expired) tidak memanggil GET /home (server menolaknya,
/// PRD 2.2); Beranda mereka menjelaskan status dan ajakan bayar iuran/perpanjang, dengan pintasan yang tetap
/// diizinkan (KTA berlabel, notifikasi, tiket lunas untuk expired).
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final status = session.effectiveStatus;
    final name = session.me?.profile.fullName ?? 'Anggota KAPDH';
    final active = isActiveMember(status);
    // Satu penghitung belum dibaca untuk seluruh aplikasi (F-13): lonceng dan akses cepat Beranda memakai penghitung
    // yang sama dengan menu Akun dan portal pembatasan, yang diperbarui realtime, kotak masuk dan tandai dibaca.
    // Beranda tetap terpasang di tumpukan tab, jadi angka GET /home saja akan usang. Angka itu hanya cadangan selama
    // penghitung belum diketahui (mis. offline dengan cache Beranda).
    final homeUnread = active
        ? ref.watch(homeControllerProvider.select((state) => state.home?.quickAccess.unreadNotificationCount))
        : null;
    final liveUnread = ref.watch(notificationUnreadCountProvider);
    final unread = liveUnread ?? homeUnread;
    // Beranda tidak memakai AppScaffold; pita global Offline/Pemeliharaan dipasang sendiri tepat di bawah kepala.
    final banner = AppBannerScope.of(context);
    return Scaffold(
      backgroundColor: KapdhColors.background,
      appBar: HomeHeader(
        name: name,
        unreadCount: unread,
        onNotifications: () => unawaited(context.push(AppRoutes.notifications)),
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ?banner,
          Expanded(
            child: SafeArea(
              top: false,
              child: active ? const _ActiveHome() : _GatedHome(status: status, unread: liveUnread),
            ),
          ),
        ],
      ),
    );
  }
}

class _ActiveHome extends ConsumerWidget {
  const _ActiveHome();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(homeControllerProvider);
    final controller = ref.read(homeControllerProvider.notifier);
    final home = state.home;
    final error = state.error;

    if (home == null) {
      if (error != null) {
        return RefreshIndicator(
          onRefresh: controller.refresh,
          child: LayoutBuilder(
            builder: (context, constraints) => ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                ConstrainedBox(
                  constraints: BoxConstraints(minHeight: constraints.maxHeight),
                  child: ErrorState.fromException(error, onRetry: () => unawaited(controller.refresh())),
                ),
              ],
            ),
          ),
        );
      }
      return ListView(children: const [LoadingSkeleton(lines: 6, semanticsLabel: 'Memuat Beranda')]);
    }

    final allEmpty = home.banners.isEmpty && home.upcomingEvents.isEmpty && home.posts.isEmpty;
    final unread = ref.watch(notificationUnreadCountProvider) ?? home.quickAccess.unreadNotificationCount;
    return RefreshIndicator(
      onRefresh: controller.refresh,
      child: ListView(
        key: const ValueKey('home-list'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s8),
        children: [
          if (state.loading) ...[
            const LinearProgressIndicator(minHeight: 2, semanticsLabel: 'Memperbarui Beranda'),
            const SizedBox(height: KapdhSpace.s3),
          ],
          if (state.fromCache) ...[
            _CacheNotice(
              generatedAt: home.generatedAt,
              error: error,
              loading: state.loading,
              onRetry: () => unawaited(controller.refresh()),
            ),
            const SizedBox(height: KapdhSpace.s4),
          ],
          if (home.banners.isNotEmpty) ...[
            BannerCarousel(banners: home.banners),
            const SizedBox(height: KapdhSpace.s4),
          ],
          _QuickAccess(quickAccess: home.quickAccess, unread: unread),
          if (home.quickAccess.effectiveStatus == EffectiveStatus.expiring) ...[
            const SizedBox(height: KapdhSpace.s3),
            _RenewalReminder(expiresAt: home.quickAccess.expiresAt),
          ],
          const SizedBox(height: KapdhSpace.s5),
          if (allEmpty)
            EmptyState(
              icon: Icons.campaign_outlined,
              title: 'Belum ada kabar terbaru',
              message:
                  'Pengurus belum menerbitkan berita atau event. Tarik layar ke bawah untuk memuat ulang; kabar baru '
                  'juga dikirim lewat notifikasi.',
              actionLabel: 'Muat ulang',
              onAction: () => unawaited(controller.refresh()),
            )
          else ...[
            HomeSectionTitle(title: 'Event Mendatang', onAction: () => context.go(AppRoutes.events)),
            const SizedBox(height: KapdhSpace.s2),
            if (home.upcomingEvents.isEmpty)
              const SectionEmpty(
                icon: Icons.event_outlined,
                message: 'Belum ada event mendatang. Event baru dari pengurus akan tampil di sini.',
              )
            else
              for (final event in home.upcomingEvents) ...[
                EventCard.home(event, onTap: () => unawaited(context.push(AppRoutes.event(event.id)))),
                const SizedBox(height: KapdhSpace.s3),
              ],
            const SizedBox(height: KapdhSpace.s4),
            HomeSectionTitle(title: 'Berita Terbaru', onAction: () => unawaited(context.push(AppRoutes.news))),
            const SizedBox(height: KapdhSpace.s2),
            if (home.posts.isEmpty)
              const SectionEmpty(
                icon: Icons.article_outlined,
                message: 'Belum ada berita terbit. Berita resmi pengurus akan tampil di sini.',
              )
            else
              for (final post in home.posts) ...[
                PostCard(post: post, onTap: () => unawaited(context.push(AppRoutes.newsDetail(post.slug)))),
                const SizedBox(height: KapdhSpace.s3),
              ],
          ],
        ],
      ),
    );
  }
}

/// Pemberitahuan cache lama dengan waktu pembaruan dari server (`generated_at`, AC F08-4).
class _CacheNotice extends StatelessWidget {
  const _CacheNotice({required this.generatedAt, required this.error, required this.loading, required this.onRetry});

  final DateTime generatedAt;
  final ApiException? error;
  final bool loading;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final updated = 'Diperbarui ${formatDateTime(generatedAt)}.';
    final failure = error;
    if (failure == null) {
      return InfoBox(icon: Icons.history, title: 'Menampilkan data tersimpan', message: '$updated Memperbarui…');
    }
    final offline = failure.isNetwork;
    return Semantics(
      liveRegion: true,
      child: InfoBox(
        tone: InfoBoxTone.warning,
        icon: offline ? Icons.cloud_off : Icons.sync_problem,
        title: offline ? 'Offline' : 'Beranda belum dapat diperbarui',
        message: offline ? '$updated Periksa koneksi internet Anda.' : '$updated ${failure.message}',
        trailing: loading ? null : TextButton(onPressed: onRetry, child: const Text('Coba lagi')),
      ),
    );
  }
}

/// Keterangan jumlah belum dibaca pada akses cepat Notifikasi.
String _unreadDetail(int unread) => unread > 0 ? '$unread belum dibaca' : 'Semua terbaca';

class _QuickAccess extends StatelessWidget {
  const _QuickAccess({required this.quickAccess, required this.unread});

  final HomeQuickAccess quickAccess;

  /// Jumlah belum dibaca dari penghitung bersama (cadangan: angka GET /home).
  final int unread;

  @override
  Widget build(BuildContext context) {
    return QuickAccessRow(
      actions: [
        QuickAction(
          key: const ValueKey('quick-kta'),
          icon: Icons.badge_outlined,
          label: 'KTA',
          detail: quickAccess.memberNumber ?? membershipLabel(quickAccess.effectiveStatus),
          onTap: () => context.go(AppRoutes.kta),
        ),
        QuickAction(
          key: const ValueKey('quick-notifications'),
          icon: Icons.notifications_outlined,
          label: 'Notifikasi',
          detail: _unreadDetail(unread),
          onTap: () => unawaited(context.push(AppRoutes.notifications)),
        ),
        QuickAction(
          key: const ValueKey('quick-tickets'),
          icon: Icons.confirmation_number_outlined,
          label: 'Tiket Saya',
          onTap: () => unawaited(context.push(AppRoutes.tickets)),
        ),
        QuickAction(
          key: const ValueKey('quick-news'),
          icon: Icons.article_outlined,
          label: 'Berita',
          onTap: () => unawaited(context.push(AppRoutes.news)),
        ),
      ],
    );
  }
}

/// Ajakan perpanjang untuk status expiring (F-07; jendela dibuka 30 hari sebelum habis, AC F07-5).
class _RenewalReminder extends StatelessWidget {
  const _RenewalReminder({required this.expiresAt});

  final DateTime? expiresAt;

  @override
  Widget build(BuildContext context) {
    final until = expiresAt == null ? '' : ' pada ${formatDate(expiresAt!)}';
    return InfoBox(
      tone: InfoBoxTone.warning,
      icon: Icons.schedule,
      title: 'Masa aktif KTA segera berakhir',
      message: 'KTA Anda berakhir$until. Perpanjang sekarang agar akses event, jejaring dan chat tidak terputus.',
      trailing: TextButton(onPressed: () => context.go(AppRoutes.renewal), child: const Text('Perpanjang')),
    );
  }
}

/// Beranda untuk status yang belum membuka informasi anggota (PRD 2.2): unverified diajak menyelesaikan iuran,
/// expired diajak memperpanjang dan tetap dapat membuka tiket lunasnya.
class _GatedHome extends StatelessWidget {
  const _GatedHome({required this.status, required this.unread});

  final EffectiveStatus? status;

  /// Jumlah belum dibaca dari penghitung bersama; null bila belum diketahui (kotak masuk terbuka untuk semua status,
  /// kontrak C7 `member_access: any`).
  final int? unread;

  @override
  Widget build(BuildContext context) {
    final current = status ?? EffectiveStatus.unknown;
    final expired = current == EffectiveStatus.expired;
    final (String title, String message, String? actionLabel, String? actionRoute) = switch (current) {
      EffectiveStatus.unverified => (
        'KTA Anda belum aktif',
        'Selesaikan iuran pendaftaran agar pengurus dapat memverifikasi keanggotaan. Setelah KTA aktif, berita, '
            'event dan jejaring alumni terbuka di Beranda.',
        'Selesaikan Iuran Pendaftaran',
        AppRoutes.onboardingFees,
      ),
      EffectiveStatus.expired => (
        'Masa keanggotaan berakhir',
        'Perpanjang KTA untuk kembali membuka berita, event, jejaring dan chat. Tiket event yang sudah lunas tetap '
            'berlaku dan dapat dibuka di Tiket Saya.',
        'Perpanjang Keanggotaan',
        AppRoutes.renewal,
      ),
      _ => ('Beranda belum tersedia', 'Beranda belum tersedia untuk status akun Anda saat ini.', null, null),
    };
    return ListView(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s6, KapdhSpace.s5, KapdhSpace.s8),
      children: [
        StatusHero(status: StatusStyles.membership(current), icon: Icons.lock_outline, title: title, message: message),
        if (actionLabel != null && actionRoute != null) ...[
          const SizedBox(height: KapdhSpace.s5),
          KapdhButton(label: actionLabel, onPressed: () => context.go(actionRoute)),
        ],
        const SizedBox(height: KapdhSpace.s5),
        QuickAccessRow(
          actions: [
            QuickAction(
              key: const ValueKey('quick-kta'),
              icon: Icons.badge_outlined,
              label: 'KTA',
              detail: membershipLabel(current),
              onTap: () => context.go(AppRoutes.kta),
            ),
            QuickAction(
              key: const ValueKey('quick-notifications'),
              icon: Icons.notifications_outlined,
              label: 'Notifikasi',
              detail: switch (unread) {
                final count? => _unreadDetail(count),
                null => null,
              },
              onTap: () => unawaited(context.push(AppRoutes.notifications)),
            ),
            if (expired)
              QuickAction(
                key: const ValueKey('quick-tickets'),
                icon: Icons.confirmation_number_outlined,
                label: 'Tiket Saya',
                onTap: () => unawaited(context.push(AppRoutes.tickets)),
              ),
          ],
        ),
      ],
    );
  }
}
