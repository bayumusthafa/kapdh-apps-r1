import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';
import 'notification_presentation.dart';
import 'notification_unread_count.dart';
import 'notifications_repository.dart';

/// Kotak masuk notifikasi (F-13; PRD 4.6 "Flutter akun: Inbox"). Kotak masuk adalah riwayat resmi dan selalu dapat
/// dibuka, walaupun izin push OS ditolak atau kategori push dimatikan (AC F13-2). Mengetuk notifikasi menandainya
/// dibaca lalu membuka deep link-nya melalui router, sehingga sesi dan status diperiksa redirect lebih dulu dan
/// endpoint objek memeriksa izin di server (AC F13-3).
class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  final _scroll = ScrollController();
  StreamSubscription<NotificationCreatedPayload>? _realtime;

  bool _unreadOnly = false;
  List<InboxNotification> _items = const [];
  String? _nextCursor;
  int _unread = 0;
  bool _loading = true;
  ApiException? _error;
  bool _loadingMore = false;
  ApiException? _moreError;
  bool _markingAll = false;

  /// Naik setiap memuat ulang (ganti filter, tarik untuk memuat ulang); respons lama dibuang.
  int _generation = 0;

  NotificationsRepository get _repo => ref.read(notificationsRepositoryProvider);

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _realtime = ref.read(notificationCreatedEventsProvider).listen(_onRealtime);
    unawaited(_load());
  }

  @override
  void dispose() {
    unawaited(_realtime?.cancel());
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scroll.hasClients) return;
    if (_scroll.position.extentAfter < 400) unawaited(_loadMore());
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _loading = _items.isEmpty;
      _error = null;
      _moreError = null;
    });
    try {
      final page = await _repo.list(unreadOnly: _unreadOnly);
      if (!mounted || generation != _generation) return;
      setState(() {
        _items = page.items;
        _nextCursor = page.nextCursor;
        _unread = page.unreadCount;
        _loading = false;
      });
      ref.read(notificationUnreadCountProvider.notifier).set(page.unreadCount);
    } on ApiException catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  Future<void> _loadMore() async {
    final cursor = _nextCursor;
    if (cursor == null || _loadingMore || _loading) return;
    final generation = _generation;
    setState(() {
      _loadingMore = true;
      _moreError = null;
    });
    try {
      final page = await _repo.list(unreadOnly: _unreadOnly, cursor: cursor);
      if (!mounted || generation != _generation) return;
      final known = {for (final item in _items) item.id};
      setState(() {
        _items = [..._items, ...page.items.where((item) => !known.contains(item.id))];
        _nextCursor = page.nextCursor;
        _unread = page.unreadCount;
      });
    } on ApiException catch (error) {
      if (mounted && generation == _generation) setState(() => _moreError = error);
    } finally {
      if (mounted && generation == _generation) setState(() => _loadingMore = false);
    }
  }

  void _onRealtime(NotificationCreatedPayload payload) {
    if (!mounted) return;
    setState(() {
      _unread = payload.unreadCount;
      if (_loading || _error != null || _items.any((item) => item.id == payload.id)) return;
      _items = [inboxFromRealtime(payload), ..._items];
    });
  }

  void _setFilter(bool unreadOnly) {
    if (unreadOnly == _unreadOnly) return;
    setState(() {
      _unreadOnly = unreadOnly;
      _items = const [];
      _nextCursor = null;
    });
    unawaited(_load());
  }

  DateTime _now() => ref.read(serverClockProvider).now();

  InboxNotification _asRead(InboxNotification item, DateTime at) => InboxNotification(
    id: item.id,
    category: item.category,
    title: item.title,
    body: item.body,
    deepLink: item.deepLink,
    readAt: item.readAt ?? at,
    createdAt: item.createdAt,
  );

  Future<void> _open(InboxNotification item) async {
    if (item.readAt == null) {
      final now = _now();
      setState(() {
        _items = [for (final i in _items) i.id == item.id ? _asRead(i, now) : i];
        _unread = _unread > 0 ? _unread - 1 : 0;
      });
      ref.read(notificationUnreadCountProvider.notifier).set(_unread);
      // Tanda dibaca tidak menghalangi membuka tujuan; kegagalan (mis. offline) dibiarkan dan diulang saat dibuka lagi.
      unawaited(
        _repo.markRead([item.id]).then((result) {
          if (!mounted) return;
          setState(() => _unread = result.unreadCount);
          ref.read(notificationUnreadCountProvider.notifier).set(result.unreadCount);
        }, onError: (Object _) {}),
      );
    }
    final target = notificationTarget(item.deepLink);
    if (!mounted) return;
    if (target == null || target.path == AppRoutes.notifications) {
      if (item.deepLink != null) {
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(const SnackBar(content: Text('Tujuan notifikasi ini belum didukung versi aplikasi Anda.')));
      }
      return;
    }
    openNotificationTarget(context, target);
  }

  Future<void> _markAll() async {
    if (_markingAll) return;
    final upTo = _items.isEmpty ? null : _items.map((item) => item.createdAt).reduce((a, b) => a.isAfter(b) ? a : b);
    setState(() => _markingAll = true);
    try {
      final result = await _repo.markAllRead(upTo: upTo);
      if (!mounted) return;
      final now = _now();
      setState(() {
        _unread = result.unreadCount;
        _items = [
          for (final item in _items)
            if (upTo == null || !item.createdAt.isAfter(upTo)) _asRead(item, now) else item,
        ];
      });
      ref.read(notificationUnreadCountProvider.notifier).set(result.unreadCount);
      if (_unreadOnly) unawaited(_load());
    } on ApiException catch (error) {
      if (mounted) await ref.read(errorPresenterProvider).present(error, onRetry: _markAll);
    } finally {
      if (mounted) setState(() => _markingAll = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: 'Notifikasi',
      fallbackLocation: AppRoutes.home,
      actions: [
        IconButton(
          key: const ValueKey('notifications-mark-all'),
          tooltip: 'Tandai semua dibaca',
          icon: _markingAll
              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.done_all),
          onPressed: _unread > 0 && !_markingAll && _items.isNotEmpty ? _markAll : null,
        ),
      ],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s3, KapdhSpace.s5, KapdhSpace.s2),
            child: Wrap(
              spacing: KapdhSpace.s2,
              runSpacing: KapdhSpace.s2,
              children: [
                ChoiceChip(
                  key: const ValueKey('notifications-filter-all'),
                  label: const Text('Semua'),
                  selected: !_unreadOnly,
                  onSelected: (_) => _setFilter(false),
                ),
                ChoiceChip(
                  key: const ValueKey('notifications-filter-unread'),
                  label: Text(_unread > 0 ? 'Belum dibaca ($_unread)' : 'Belum dibaca'),
                  selected: _unreadOnly,
                  onSelected: (_) => _setFilter(true),
                ),
              ],
            ),
          ),
          Expanded(child: _body()),
        ],
      ),
    );
  }

  Widget _body() {
    if (_loading) return const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat notifikasi');
    final error = _error;
    if (error != null) return ErrorState.fromException(error, onRetry: _load);
    if (_items.isEmpty) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: 420,
              child: EmptyState(
                icon: Icons.notifications_none,
                title: _unreadOnly ? 'Semua notifikasi sudah dibaca' : 'Belum ada notifikasi',
                message: _unreadOnly
                    ? 'Notifikasi baru akan tampil di sini.'
                    : 'Hasil pembayaran, masa KTA, event, berita dan keamanan akun akan tersimpan di sini, '
                          'termasuk saat notifikasi push dimatikan.',
              ),
            ),
          ],
        ),
      );
    }
    final now = _now();
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: KapdhSpace.s6),
        itemCount: _items.length + 1,
        separatorBuilder: (_, index) =>
            index < _items.length - 1 ? const Divider(height: 1, indent: 72) : const SizedBox.shrink(),
        itemBuilder: (context, index) {
          if (index == _items.length) return _footer();
          final item = _items[index];
          return NotificationTile(
            key: ValueKey('notification-${item.id}'),
            notification: item,
            now: now,
            onTap: () => _open(item),
          );
        },
      ),
    );
  }

  Widget _footer() {
    final moreError = _moreError;
    if (moreError != null) {
      return Padding(
        padding: const EdgeInsets.all(KapdhSpace.s4),
        child: Column(
          children: [
            Text(
              moreError.message,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.danger),
            ),
            KapdhLinkButton(label: 'Coba lagi', icon: Icons.refresh, onPressed: _loadMore),
          ],
        ),
      );
    }
    if (_loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(KapdhSpace.s4),
        child: Center(child: CircularProgressIndicator(semanticsLabel: 'Memuat notifikasi lain')),
      );
    }
    if (_nextCursor != null) {
      return Center(
        child: KapdhLinkButton(label: 'Muat lebih banyak', onPressed: _loadMore),
      );
    }
    return const SizedBox(height: KapdhSpace.s4);
  }
}

/// Satu baris kotak masuk: ikon kategori, judul, ringkasan, kategori + waktu relatif dan penanda belum dibaca
/// (teks untuk pembaca layar, bukan warna saja; PRD 4.5, N-11).
class NotificationTile extends StatelessWidget {
  const NotificationTile({super.key, required this.notification, required this.now, required this.onTap});

  final InboxNotification notification;
  final DateTime now;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final unread = notification.readAt == null;
    final style = notificationCategoryStyle(notification.category);
    final when = formatRelative(notification.createdAt, now: now);
    final body = notification.body;
    return Semantics(
      button: true,
      label: [if (unread) 'Belum dibaca', style.label, notification.title, ?body, when].join(', '),
      excludeSemantics: true,
      child: Material(
        color: unread ? KapdhColors.green50 : KapdhColors.surface,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s5, vertical: KapdhSpace.s3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: const BoxDecoration(color: KapdhColors.green100, shape: BoxShape.circle),
                  child: Icon(style.icon, size: 20, color: KapdhColors.primary),
                ),
                const SizedBox(width: KapdhSpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        notification.title,
                        style: TextStyle(
                          fontSize: KapdhFontSize.body,
                          fontWeight: unread ? FontWeight.w600 : FontWeight.w500,
                          color: KapdhColors.text,
                        ),
                      ),
                      if (body != null && body.isNotEmpty) ...[
                        const SizedBox(height: 2),
                        Text(
                          body,
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 13, height: 1.45, color: KapdhColors.textMuted),
                        ),
                      ],
                      const SizedBox(height: KapdhSpace.s1),
                      Text(
                        '${style.label} · $when',
                        style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                      ),
                    ],
                  ),
                ),
                if (unread) ...[
                  const SizedBox(width: KapdhSpace.s2),
                  Container(
                    margin: const EdgeInsets.only(top: 6),
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: KapdhColors.primary,
                      borderRadius: BorderRadius.circular(KapdhRadius.pill),
                    ),
                    child: const Text(
                      'Baru',
                      style: TextStyle(fontSize: KapdhFontSize.overline, color: KapdhColors.onPrimary),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
