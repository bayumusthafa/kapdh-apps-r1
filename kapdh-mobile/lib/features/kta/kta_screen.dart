import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../core/session/session_state.dart';
import '../../design/design.dart';
import '../payments/payment_updates.dart';
import 'kta_presentation.dart';
import 'kta_sync.dart';

/// Kartu Tanda Anggota digital (F-05; prototipe layar 6, 7; guideline hal. 6; PRD 3.5).
///
/// - Online: kartu dari GET /me/card dengan QR bertanda tangan server (`qr.url`, qr_flutter), badge status, waktu
///   sinkronisasi, dan aksi Bayar/Lanjutkan/Perpanjang sesuai `action` server (Perpanjang nonaktif sebelum jendela
///   perpanjangan dibuka, AC F07-5). Setiap respons disimpan ke cache offline.
/// - Server tidak terjangkau: cache tampil berlabel "Offline" dengan waktu sinkronisasi hanya bila tersinkron
///   <= 7 hari, masa anggota belum habis, akun yang sama dan bukan status dibatasi (AC F05-2, F05-3); selain itu
///   pengguna diminta sinkronisasi. Status dibatasi dari server menggantikan cache aktif (AC F05-4).
class KtaScreen extends ConsumerStatefulWidget {
  const KtaScreen({super.key});

  @override
  ConsumerState<KtaScreen> createState() => _KtaScreenState();
}

class _KtaScreenState extends ConsumerState<KtaScreen> {
  KtaView _view = const KtaLoading();
  bool _syncing = false;
  late final AppLifecycleListener _lifecycle;
  StreamSubscription<NotificationCreatedPayload>? _updates;

  @override
  void initState() {
    super.initState();
    // Kembali ke aplikasi: QR diterbitkan ulang dan status kartu diperbarui (AC F05-4, F05-5).
    _lifecycle = AppLifecycleListener(onResume: () => unawaited(_sync()));
    // Iuran disetujui atau keanggotaan berubah (notifikasi realtime): kartu menjadi Aktif tanpa menunggu pengguna
    // menyinkronkan (PRD 4.1, AC F05-1).
    _updates = ref.read(paymentUpdatesProvider).listen((_) => unawaited(_sync()));
    unawaited(_sync());
  }

  @override
  void dispose() {
    unawaited(_updates?.cancel());
    _lifecycle.dispose();
    super.dispose();
  }

  Future<void> _sync() async {
    final userId = ref.read(sessionProvider).userId;
    if (_syncing || userId == null) return;
    setState(() => _syncing = true);
    try {
      final view = await ref.read(ktaSyncProvider).sync(userId: userId);
      if (!mounted) return;
      setState(() => _view = view);
      if (view is KtaOnline) _followStatus(view.card);
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  /// Kartu menunjukkan status yang berbeda dari sesi (mis. iuran baru disetujui atau akun dibatasi): muat ulang /me
  /// agar perutean dan tab mengikuti status terbaru (PRD 2.2).
  void _followStatus(MemberCard card) {
    final status = ref.read(sessionProvider).effectiveStatus;
    final expected = switch (status) {
      EffectiveStatus.verified => MemberCardStatus.active,
      EffectiveStatus.expiring => MemberCardStatus.expiring,
      EffectiveStatus.unverified => MemberCardStatus.inactive,
      EffectiveStatus.expired => MemberCardStatus.expired,
      EffectiveStatus.suspended => MemberCardStatus.suspended,
      _ => null,
    };
    if (expected != null && expected != card.statusLabel) {
      unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
    }
  }

  void _open(KtaAction action) {
    final location = action.location;
    if (location == null) return;
    switch (action.navigation) {
      case KtaNavigation.go:
        context.go(location);
      case KtaNavigation.push:
        context.push(location);
    }
  }

  ImageProvider? _avatar(MemberCard card) {
    final url = card.avatarUrl;
    if (url == null) return null;
    // URL foto bertanda tangan berumur pendek; kunci cache mengikuti berkas avatar agar foto tetap tampil saat
    // offline dan berganti saat avatar diganti (kontrak C2 MemberCard.avatar_url).
    final fileId = ref.read(sessionProvider).me?.profile.avatarFileId;
    final userId = ref.read(sessionProvider).userId;
    return CachedNetworkImageProvider(url, cacheKey: fileId == null ? null : 'kta-avatar-$userId-$fileId');
  }

  @override
  Widget build(BuildContext context) {
    // Sesi kembali online atau berganti akun: kartu disinkronkan ulang (AC F05-3, F05-4).
    ref.listen<SessionState>(sessionProvider, (previous, next) {
      final reconnected = previous?.phase == SessionPhase.offlineLastKnown && next.phase == SessionPhase.authenticated;
      final changedUser = previous?.userId != next.userId;
      final changedStatus = previous?.effectiveStatus != next.effectiveStatus;
      if (next.hasSession && (reconnected || changedUser || changedStatus)) unawaited(_sync());
    });
    final view = _view;
    return AppScaffold(
      title: 'Kartu Tanda Anggota',
      showBack: false,
      banner: view is KtaOffline ? OfflineBanner(syncedAt: view.syncedAt) : null,
      actions: [
        IconButton(
          tooltip: 'Sinkronkan KTA',
          onPressed: _syncing ? null : () => unawaited(_sync()),
          icon: _syncing
              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.sync),
        ),
      ],
      body: switch (view) {
        KtaLoading() => const LoadingSkeleton(semanticsLabel: 'Memuat KTA'),
        KtaOnline(:final card) => _online(card),
        KtaOffline() => _offline(view),
        KtaUnavailable() => _unavailable(view),
      },
    );
  }

  Widget _online(MemberCard card) {
    final (:message, :action) = ktaStatusOf(card);
    final active = card.statusLabel == MemberCardStatus.active || card.statusLabel == MemberCardStatus.expiring;
    return RefreshIndicator(
      onRefresh: _sync,
      child: ListView(
        padding: const EdgeInsets.all(KapdhSpace.s5),
        children: [
          KtaCard(data: KtaCardData.fromMemberCard(card, avatar: _avatar(card))),
          const SizedBox(height: KapdhSpace.s2),
          _SyncedAt(syncedAt: card.syncedAt),
          const SizedBox(height: KapdhSpace.s4),
          StatusActionCard(
            key: const ValueKey('kta-status'),
            status: StatusStyles.card(card.statusLabel),
            message: message,
            actionLabel: action?.label,
            onAction: action != null && action.enabled ? () => _open(action) : null,
          ),
          if (active && card.qr != null) ...[
            const SizedBox(height: KapdhSpace.s4),
            const InfoBox(
              key: ValueKey('kta-brightness-tip'),
              icon: Icons.brightness_high_outlined,
              message:
                  'Naikkan kecerahan layar saat QR dipindai. Status terkini selalu dicek server saat pemeriksa '
                  'memindai QR, dan QR diperbarui setiap kali KTA disinkronkan.',
            ),
          ],
          if (card.statusLabel == MemberCardStatus.inactive) ...[
            const SizedBox(height: KapdhSpace.s4),
            const _LockedFeatures(),
          ],
          if (card.city == null && card.statusLabel != MemberCardStatus.suspended) ...[
            const SizedBox(height: KapdhSpace.s4),
            InfoBox(
              key: const ValueKey('kta-complete-profile'),
              icon: Icons.location_city_outlined,
              message: 'Kota domisili belum diisi. Lengkapi profil agar kota tampil di KTA.',
              trailing: TextButton(
                onPressed: () => context.push(AppRoutes.accountProfile),
                child: const Text('Lengkapi'),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _offline(KtaOffline view) {
    final card = view.card;
    return RefreshIndicator(
      onRefresh: _sync,
      child: ListView(
        padding: const EdgeInsets.all(KapdhSpace.s5),
        children: [
          KtaCard(
            data: KtaCardData.fromMemberCard(card, qrUsable: view.qrUsable, avatar: _avatar(card)),
          ),
          const SizedBox(height: KapdhSpace.s4),
          StatusActionCard(
            key: const ValueKey('kta-status'),
            status: StatusStyles.card(card.statusLabel),
            message: 'Status dari sinkronisasi terakhir.',
            actionLabel: 'Sinkronkan',
            outlinedAction: true,
            busy: _syncing,
            onAction: () => unawaited(_sync()),
          ),
          const SizedBox(height: KapdhSpace.s4),
          const InfoBox(
            key: ValueKey('kta-offline-rule'),
            message:
                'Kartu offline tetap bisa ditunjukkan sampai 7 hari sejak sinkronisasi terakhir. Status terkini '
                'selalu dicek saat pemeriksa memindai QR.',
          ),
        ],
      ),
    );
  }

  Widget _unavailable(KtaUnavailable view) {
    final reason = view.reason;
    if (reason == null) return ErrorState.fromException(view.error, onRetry: () => unawaited(_sync()));
    final (:title, :message) = ktaOfflineMissOf(reason);
    return ErrorState(
      key: const ValueKey('kta-offline-unavailable'),
      icon: Icons.cloud_off,
      title: title,
      message: message,
      retryLabel: 'Sinkronkan',
      onRetry: _syncing ? null : () => unawaited(_sync()),
    );
  }
}

class _SyncedAt extends StatelessWidget {
  const _SyncedAt({required this.syncedAt});

  final DateTime syncedAt;

  @override
  Widget build(BuildContext context) {
    final text = 'Tersinkron ${formatDateTime(syncedAt)}';
    return Semantics(
      label: 'Waktu sinkronisasi terakhir: ${formatDateTime(syncedAt)}',
      excludeSemantics: true,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.sync, size: 14, color: KapdhColors.textMuted),
          const SizedBox(width: KapdhSpace.s1),
          Flexible(
            child: Text(
              text,
              style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
            ),
          ),
        ],
      ),
    );
  }
}

/// "Terbuka setelah KTA aktif" (prototipe layar 6): fitur anggota aktif yang menunggu iuran pendaftaran (PRD 2.2).
class _LockedFeatures extends StatelessWidget {
  const _LockedFeatures();

  @override
  Widget build(BuildContext context) {
    const items = [
      (Icons.qr_code_2, 'QR KTA untuk verifikasi'),
      (Icons.groups_outlined, 'Jejaring alumni dan chat'),
      (Icons.event_outlined, 'Pendaftaran event dan tiket'),
    ];
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: 14),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: const Text(
              'Terbuka setelah KTA aktif',
              style: TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
            ),
          ),
          for (final (icon, label) in items) ...[
            const SizedBox(height: KapdhSpace.s2),
            Row(
              children: [
                Icon(icon, size: 18, color: KapdhColors.textMuted),
                const SizedBox(width: 10),
                Expanded(child: Text(label, style: const TextStyle(fontSize: 13))),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
