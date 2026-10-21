import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_palette.dart';
import '../../app/theme/kapdh_theme.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import '../chat/chat_list_controller.dart';
import '../events/widgets/event_card.dart';
import '../network/network_screen.dart' show networkTabRequestProvider;
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
      backgroundColor: context.kc.background,
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
              child: ContentWidth(
                child: active ? const _ActiveHome() : _GatedHome(status: status, unread: liveUnread),
              ),
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
      return ListView(children: const [_HomeSkeleton()]);
    }

    final allEmpty = home.banners.isEmpty && home.upcomingEvents.isEmpty && home.posts.isEmpty;
    final unread = ref.watch(notificationUnreadCountProvider) ?? home.quickAccess.unreadNotificationCount;
    final chatUnread = ref.watch(chatBadgeCountsProvider.select((badge) => badge.unreadRooms));
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
          // [v2] Akses cepat tepat di bawah kepala, sebelum banner.
          _QuickAccess(unread: unread, chatUnread: chatUnread),
          const SizedBox(height: KapdhSpace.s4),
          if (home.banners.isNotEmpty) BannerCarousel(banners: home.banners),
          if (home.quickAccess.effectiveStatus == EffectiveStatus.expiring) ...[
            const SizedBox(height: KapdhSpace.s3),
            _RenewalReminder(expiresAt: home.quickAccess.expiresAt),
          ],
          const SizedBox(height: KapdhSpace.s5),
          if (allEmpty)
            EmptyState(
              icon: KapdhIcons.campaignOutlined,
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
                icon: KapdhIcons.eventOutlined,
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
                icon: KapdhIcons.articleOutlined,
                message: 'Belum ada berita terbit. Berita resmi pengurus akan tampil di sini.',
              )
            else
              for (final (index, post) in home.posts.indexed) ...[
                // [v2] Berita pertama sebagai kartu hero, sisanya baris ringkas 80 x 80.
                PostCard(
                  post: post,
                  variant: index == 0 ? PostCardVariant.hero : PostCardVariant.compact,
                  onTap: () => unawaited(context.push(AppRoutes.newsDetail(post.slug))),
                ),
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
      return InfoBox(icon: KapdhIcons.history, title: 'Menampilkan data tersimpan', message: '$updated Memperbarui…');
    }
    final offline = failure.isNetwork;
    return Semantics(
      liveRegion: true,
      child: InfoBox(
        tone: InfoBoxTone.warning,
        icon: offline ? KapdhIcons.cloudOff : KapdhIcons.syncProblem,
        title: offline ? 'Offline' : 'Beranda belum dapat diperbarui',
        message: offline ? '$updated Periksa koneksi internet Anda.' : '$updated ${failure.message}',
        trailing: loading ? null : TextButton(onPressed: onRetry, child: const Text('Coba lagi')),
      ),
    );
  }
}

/// Akses cepat anggota aktif (v2): Pesan menggantikan KTA karena KTA sudah ada di tombol tengah navigasi bawah.
/// Jumlah belum dibaca tampil sebagai lencana emas di lingkaran ikon.
class _QuickAccess extends ConsumerWidget {
  const _QuickAccess({required this.unread, required this.chatUnread});

  /// Jumlah notifikasi belum dibaca dari penghitung bersama (cadangan: angka GET /home).
  final int unread;

  /// Jumlah percakapan berpesan belum dibaca (lencana tab Jejaring).
  final int chatUnread;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return QuickAccessRow(
      actions: [
        QuickAction(
          key: const ValueKey('quick-messages'),
          icon: KapdhIcons.chatBubble,
          label: 'Pesan',
          badgeCount: chatUnread,
          onTap: () {
            ref.read(networkTabRequestProvider.notifier).request(1);
            context.go(AppRoutes.network);
          },
        ),
        QuickAction(
          key: const ValueKey('quick-notifications'),
          icon: KapdhIcons.notificationsActive,
          label: 'Notifikasi',
          badgeCount: unread,
          onTap: () => unawaited(context.push(AppRoutes.notifications)),
        ),
        QuickAction(
          key: const ValueKey('quick-tickets'),
          icon: KapdhIcons.confirmationNumber,
          label: 'Tiket Saya',
          onTap: () => unawaited(context.push(AppRoutes.tickets)),
        ),
        QuickAction(
          key: const ValueKey('quick-news'),
          icon: KapdhIcons.newspaper,
          label: 'Berita',
          onTap: () => unawaited(context.push(AppRoutes.news)),
        ),
      ],
    );
  }
}

/// Kerangka Beranda (v2): bentuk mengikuti isi (akses cepat, banner, judul bagian, kartu event), berkilau.
class _HomeSkeleton extends StatelessWidget {
  const _HomeSkeleton();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Memuat Beranda',
      liveRegion: true,
      excludeSemantics: true,
      child: KapdhShimmer(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s5),
          child: LayoutBuilder(
            builder: (context, constraints) => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    SkeletonBlock(width: 56, height: 56, circle: true),
                    SkeletonBlock(width: 56, height: 56, circle: true),
                    SkeletonBlock(width: 56, height: 56, circle: true),
                    SkeletonBlock(width: 56, height: 56, circle: true),
                  ],
                ),
                const SizedBox(height: KapdhSpace.s6),
                SkeletonBlock(height: constraints.maxWidth / 2.2, radius: KapdhRadius.lg),
                const SizedBox(height: KapdhSpace.s6),
                const SkeletonBlock(width: 160, height: 18),
                const SizedBox(height: KapdhSpace.s3),
                const SkeletonBlock(height: 128, radius: KapdhRadius.lg),
                const SizedBox(height: KapdhSpace.s3),
                const SkeletonBlock(height: 128, radius: KapdhRadius.lg),
              ],
            ),
          ),
        ),
      ),
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
      icon: KapdhIcons.schedule,
      title: 'Masa aktif KTA segera berakhir',
      message: 'KTA Anda berakhir$until. Perpanjang sekarang agar akses event, jejaring dan chat tidak terputus.',
      centerTrailing: true,
      // [v2] Tombol berisi warna peringatan dengan teks putih (5,9:1), bukan tautan teks.
      trailing: FilledButton(
        onPressed: () => context.go(AppRoutes.renewal),
        style: FilledButton.styleFrom(
          backgroundColor: context.kc.warning,
          foregroundColor: context.kc.isDark ? KapdhColors.green950 : KapdhColors.onPrimary,
          minimumSize: const Size(KapdhSize.touchTargetMin, 36),
          tapTargetSize: MaterialTapTargetSize.padded,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          textStyle: KapdhTheme.font(fontSize: 13, fontWeight: FontWeight.w600),
        ),
        child: const Text('Perpanjang'),
      ),
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
        'Selesaikan iuran pendaftaran agar pengurus dapat memverifikasi keanggotaan. Berita, event dan jejaring '
            'alumni adalah layanan untuk anggota terverifikasi.',
        'Selesaikan Iuran Pendaftaran',
        AppRoutes.onboardingFees,
      ),
      EffectiveStatus.expired => (
        'Masa keanggotaan berakhir',
        'Berita, event, jejaring dan chat adalah layanan untuk anggota aktif. Hubungi pengurus atau perpanjang '
            'keanggotaan organisasi. Tiket event yang sudah lunas tetap berlaku dan dapat dibuka di Tiket Saya.',
        'Perpanjang Keanggotaan',
        AppRoutes.renewal,
      ),
      _ => ('Beranda belum tersedia', 'Beranda belum tersedia untuk status akun Anda saat ini.', null, null),
    };
    return ListView(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s6, KapdhSpace.s5, KapdhSpace.s8),
      children: [
        // [v2] Status dan tombol aksi dalam satu kartu.
        Container(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s6, KapdhSpace.s5, KapdhSpace.s5),
          decoration: BoxDecoration(
            color: context.kc.surface,
            border: Border.all(color: context.kc.rejectionBorder),
            borderRadius: BorderRadius.circular(KapdhRadius.xl),
            boxShadow: context.kc.shadowSm,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              StatusHero(
                status: StatusStyles.membership(current),
                icon: KapdhIcons.lockOutline,
                title: title,
                message: message,
              ),
              if (actionLabel != null && actionRoute != null) ...[
                const SizedBox(height: KapdhSpace.s5),
                KapdhButton(label: actionLabel, onPressed: () => context.go(actionRoute)),
              ],
            ],
          ),
        ),
        const SizedBox(height: KapdhSpace.s5),
        QuickAccessRow(
          actions: [
            // KTA tetap di Beranda terkunci: statusnya penting di sini dan Jejaring (Pesan) terkunci.
            QuickAction(
              key: const ValueKey('quick-kta'),
              icon: KapdhIcons.badge,
              label: 'KTA',
              detail: membershipLabel(current),
              onTap: () => context.go(AppRoutes.kta),
            ),
            QuickAction(
              key: const ValueKey('quick-notifications'),
              icon: KapdhIcons.notificationsActive,
              label: 'Notifikasi',
              badgeCount: unread,
              onTap: () => unawaited(context.push(AppRoutes.notifications)),
            ),
            if (expired)
              QuickAction(
                key: const ValueKey('quick-tickets'),
                icon: KapdhIcons.confirmationNumber,
                label: 'Tiket Saya',
                onTap: () => unawaited(context.push(AppRoutes.tickets)),
              ),
          ],
        ),
      ],
    );
  }
}
