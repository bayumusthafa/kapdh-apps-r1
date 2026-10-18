import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import 'widgets/scroll_column.dart';
import 'account_repository.dart';
import 'widgets/account_section.dart';

/// Sesi perangkat (F-02; PRD 4.6 "Flutter akun: sesi"). Satu baris per keluarga sesi yang masih berlaku (id stabil
/// selama rotasi refresh). Perangkat ini tampil paling atas; perangkat lain dapat dicabut satu per satu, dan "Keluar
/// dari semua perangkat" mencabut seluruh sesi sehingga HTTP dan socket lama tidak dapat dipakai lagi (AC F02-6).
/// Daftar tidak memuat token maupun IP (N-14).
class SessionsScreen extends ConsumerStatefulWidget {
  const SessionsScreen({super.key});

  @override
  ConsumerState<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends ConsumerState<SessionsScreen> {
  List<Session> _items = const [];
  String? _nextCursor;
  bool _loading = true;
  ApiException? _error;
  bool _loadingMore = false;
  final Set<String> _revoking = {};
  bool _signingOutAll = false;

  AccountRepository get _repo => ref.read(accountRepositoryProvider);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = _items.isEmpty;
      _error = null;
    });
    try {
      final page = await _repo.listSessions();
      if (!mounted) return;
      setState(() {
        _items = page.items;
        _nextCursor = page.nextCursor;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  Future<void> _loadMore() async {
    final cursor = _nextCursor;
    if (cursor == null || _loadingMore) return;
    setState(() => _loadingMore = true);
    try {
      final page = await _repo.listSessions(cursor: cursor);
      if (!mounted) return;
      final known = {for (final s in _items) s.id};
      setState(() {
        _items = [..._items, ...page.items.where((s) => !known.contains(s.id))];
        _nextCursor = page.nextCursor;
      });
    } on ApiException catch (error) {
      if (mounted) unawaited(ref.read(errorPresenterProvider).present(error, onRetry: _loadMore));
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<bool> _confirm({required String title, required String message, required String action}) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Batal')),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: KapdhColors.danger),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(action),
          ),
        ],
      ),
    );
    return result ?? false;
  }

  Future<void> _revoke(Session session) async {
    if (session.current) return _signOutThisDevice();
    final confirmed = await _confirm(
      title: 'Keluarkan perangkat?',
      message:
          '${_deviceLabel(session)} akan dikeluarkan dari akun Anda dan perlu masuk ulang. Notifikasi push ke '
          'perangkat itu dihentikan.',
      action: 'Keluarkan',
    );
    if (!confirmed || !mounted) return;
    setState(() => _revoking.add(session.id));
    try {
      await _repo.revokeSession(session.id);
      if (!mounted) return;
      setState(() => _items = _items.where((s) => s.id != session.id).toList());
      _snack('${_deviceLabel(session)} sudah dikeluarkan.');
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.notFound) {
        // Sudah dicabut (mis. dari perangkat lain atau kedaluwarsa): hasil yang diinginkan sudah tercapai.
        setState(() => _items = _items.where((s) => s.id != session.id).toList());
        _snack('Sesi perangkat itu sudah tidak berlaku.');
      } else {
        unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_revoke(session))));
      }
    } finally {
      if (mounted) setState(() => _revoking.remove(session.id));
    }
  }

  Future<void> _signOutThisDevice() async {
    final confirmed = await _confirm(
      title: 'Keluar dari perangkat ini?',
      message: 'Anda perlu masuk ulang. Cache KTA dan data akun di perangkat ini dihapus.',
      action: 'Keluar',
    );
    if (!confirmed || !mounted) return;
    final router = GoRouter.of(context);
    await ref.read(sessionProvider.notifier).logout();
    router.go(AppRoutes.login);
  }

  /// AC F02-6: semua sesi dicabut di server; bila gagal, sesi lokal tidak diubah dan pengguna diberi tahu.
  Future<void> _signOutAll() async {
    final confirmed = await _confirm(
      title: 'Keluar dari semua perangkat?',
      message:
          'Semua perangkat, termasuk perangkat ini, akan dikeluarkan dan perlu masuk ulang. Gunakan bila Anda '
          'kehilangan perangkat atau melihat perangkat yang tidak dikenal.',
      action: 'Keluar semua',
    );
    if (!confirmed || !mounted) return;
    final router = GoRouter.of(context);
    setState(() => _signingOutAll = true);
    try {
      await ref.read(sessionProvider.notifier).logout(allDevices: true);
      router.go(AppRoutes.login);
    } on ApiException catch (error) {
      if (mounted) unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_signOutAll())));
    } finally {
      if (mounted) setState(() => _signingOutAll = false);
    }
  }

  void _snack(String message) => ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(message)));

  @override
  Widget build(BuildContext context) {
    return AppScaffold(title: 'Sesi Perangkat', fallbackLocation: AppRoutes.account, body: _body());
  }

  Widget _body() {
    if (_loading) return const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat sesi perangkat');
    final error = _error;
    if (error != null) return ErrorState.fromException(error, onRetry: _load);
    final now = ref.read(serverClockProvider).now();
    // Perangkat ini paling atas, lalu aktivitas terbaru (kontrak: tampilan boleh diurutkan menurut last_seen_at).
    final sorted = [..._items]
      ..sort((a, b) {
        if (a.current != b.current) return a.current ? -1 : 1;
        return b.lastSeenAt.compareTo(a.lastSeenAt);
      });
    final current = sorted.where((s) => s.current).toList();
    final others = sorted.where((s) => !s.current).toList();
    return RefreshIndicator(
      onRefresh: _load,
      child: ScrollColumn(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s8),
        children: [
          const InfoBox(
            icon: KapdhIcons.shieldOutlined,
            message:
                'Keluarkan perangkat yang tidak Anda kenali, lalu ganti password Anda. Mengganti password juga '
                'mengeluarkan semua perangkat lain.',
          ),
          const SizedBox(height: KapdhSpace.s5),
          if (current.isNotEmpty) ...[
            AccountSection(title: 'PERANGKAT INI', children: [for (final s in current) _tile(s, now)]),
            const SizedBox(height: KapdhSpace.s5),
          ],
          AccountSection(
            title: 'PERANGKAT LAIN',
            children: others.isEmpty
                ? const [
                    Padding(
                      padding: EdgeInsets.all(KapdhSpace.s4),
                      child: Text(
                        'Tidak ada perangkat lain yang masuk ke akun Anda.',
                        style: TextStyle(fontSize: KapdhFontSize.body, color: KapdhColors.textMuted),
                      ),
                    ),
                  ]
                : [for (final s in others) _tile(s, now)],
          ),
          if (_nextCursor != null)
            Center(
              child: _loadingMore
                  ? const Padding(padding: EdgeInsets.all(KapdhSpace.s3), child: CircularProgressIndicator())
                  : KapdhLinkButton(label: 'Muat perangkat lain', onPressed: _loadMore),
            ),
          const SizedBox(height: KapdhSpace.s6),
          KapdhButton.outlined(
            key: const ValueKey('sessions-logout-all'),
            label: 'Keluar dari semua perangkat',
            busyLabel: 'Mengeluarkan...',
            busy: _signingOutAll,
            icon: KapdhIcons.logout,
            onPressed: _signOutAll,
          ),
        ],
      ),
    );
  }

  Widget _tile(Session session, DateTime now) {
    final busy = _revoking.contains(session.id);
    final platform = switch (session.platform) {
      SessionPlatform.android => 'Android',
      SessionPlatform.ios => 'iOS',
      SessionPlatform.web => 'Web',
      _ => null,
    };
    final details = [?platform, if (session.appVersion case final version?) 'versi $version'].join(' · ');
    final lastSeen = session.current
        ? 'Aktif sekarang'
        : 'Terakhir aktif ${formatRelative(session.lastSeenAt, now: now)}';
    return Padding(
      key: ValueKey('session-${session.id}'),
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s4, KapdhSpace.s3, KapdhSpace.s2, KapdhSpace.s3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            session.platform == SessionPlatform.web ? KapdhIcons.computer : KapdhIcons.smartphone,
            color: KapdhColors.primary,
          ),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _deviceLabel(session),
                  style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
                ),
                if (details.isNotEmpty)
                  Text(
                    details,
                    style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                  ),
                Text(
                  lastSeen,
                  style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                ),
                Text(
                  'Masuk ${formatDateTime(session.createdAt)}',
                  style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                ),
              ],
            ),
          ),
          if (busy)
            const Padding(
              padding: EdgeInsets.all(KapdhSpace.s3),
              child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else
            TextButton(
              key: ValueKey('session-revoke-${session.id}'),
              style: TextButton.styleFrom(
                foregroundColor: KapdhColors.danger,
                minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
              ),
              onPressed: () => unawaited(_revoke(session)),
              child: Text(session.current ? 'Keluar' : 'Keluarkan'),
            ),
        ],
      ),
    );
  }

  static String _deviceLabel(Session session) {
    final name = session.deviceName?.trim();
    if (name != null && name.isNotEmpty) return name;
    return switch (session.platform) {
      SessionPlatform.android => 'Perangkat Android',
      SessionPlatform.ios => 'Perangkat iOS',
      SessionPlatform.web => 'Peramban web',
      _ => 'Perangkat tidak dikenal',
    };
  }
}
