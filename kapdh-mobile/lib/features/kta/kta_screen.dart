import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/cache/kta_avatar_cache.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../core/session/session_state.dart';
import '../../design/design.dart';
import 'kta_fullscreen.dart';
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
  /// Jeda percobaan sinkron otomatis selama kartu tampil dari cache atau tidak dapat ditampilkan karena server tidak
  /// terjangkau (AC F05-4): bertambah sampai 5 menit agar tidak membebani server dan baterai.
  static const retryDelays = [
    Duration(seconds: 15),
    Duration(seconds: 30),
    Duration(minutes: 1),
    Duration(minutes: 2),
    Duration(minutes: 5),
  ];

  KtaView _view = const KtaLoading();
  bool _syncing = false;
  late final AppLifecycleListener _lifecycle;
  StreamSubscription<NotificationCreatedPayload>? _updates;
  StreamSubscription<void>? _reconnects;
  Timer? _retry;
  int _retryAttempt = 0;

  /// Tampilan berasal dari cache offline atau gagal karena server tidak terjangkau: status kartu bisa sudah berubah
  /// di server, sehingga sinkron diulang begitu server terjangkau lagi (AC F05-2, F05-4).
  bool get _awaitingServer => switch (_view) {
    KtaOffline() => true,
    KtaUnavailable(:final reason) => reason != null,
    _ => false,
  };

  @override
  void initState() {
    super.initState();
    // Kembali ke aplikasi: QR diterbitkan ulang dan status kartu diperbarui (AC F05-4, F05-5).
    _lifecycle = AppLifecycleListener(onResume: () => unawaited(_sync()));
    // Iuran disetujui atau keanggotaan berubah (notifikasi realtime): kartu menjadi Aktif tanpa menunggu pengguna
    // menyinkronkan (PRD 4.1, AC F05-1).
    _updates = ref.read(paymentUpdatesProvider).listen((_) => unawaited(_sync()));
    // Koneksi kembali saat sesi tetap aktif (jaringan sempat putus): kartu cache diganti status server terbaru,
    // termasuk status dibatasi (AC F05-4). Sesi yang kembali dari offlineLastKnown ditangani pendengar sesi di build.
    _reconnects = ref.read(realtimeReconnectedProvider).listen((_) {
      if (_awaitingServer) unawaited(_sync());
    });
    unawaited(_sync());
  }

  @override
  void dispose() {
    _retry?.cancel();
    unawaited(_updates?.cancel());
    unawaited(_reconnects?.cancel());
    _lifecycle.dispose();
    super.dispose();
  }

  Future<void> _sync() async {
    final userId = ref.read(sessionProvider).userId;
    if (_syncing || userId == null) return;
    _retry?.cancel();
    setState(() => _syncing = true);
    try {
      final view = await ref.read(ktaSyncProvider).sync(userId: userId);
      if (!mounted) return;
      setState(() => _view = view);
      if (view is KtaOnline) _followStatus(view.card);
      _scheduleRetry();
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  /// Selama kartu tampil dari cache (atau tidak tampil karena server tidak terjangkau), sinkron dicoba ulang otomatis
  /// dengan jeda bertambah. Pemicu konektivitas saja tidak cukup: jaringan dapat tersambung tanpa server terjangkau
  /// (captive portal) dan realtime tidak tersambung untuk akun yang baru dibatasi (AC F05-4).
  void _scheduleRetry() {
    _retry?.cancel();
    if (!_awaitingServer) {
      _retryAttempt = 0;
      return;
    }
    final delay = retryDelays[_retryAttempt < retryDelays.length ? _retryAttempt : retryDelays.length - 1];
    _retryAttempt++;
    _retry = Timer(delay, () {
      if (!mounted) return;
      // Di latar belakang tidak ada request; kembali ke aplikasi memicu sinkron lewat AppLifecycleListener.
      final lifecycle = WidgetsBinding.instance.lifecycleState;
      if (lifecycle != null && lifecycle != AppLifecycleState.resumed) return;
      unawaited(_sync());
    });
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
    // offline dan berganti saat avatar diganti (kontrak C2 MemberCard.avatar_url). Foto disimpan di cache KTA
    // tersendiri yang dihapus bersama cache kartu (logout, berganti akun, dibatasi; PRD 5.2, AC F05-3).
    final fileId = ref.read(sessionProvider).me?.profile.avatarFileId;
    final userId = ref.read(sessionProvider).userId;
    return ref
        .read(ktaAvatarCacheProvider)
        .imageFor(url, cacheKey: fileId == null ? null : 'kta-avatar-$userId-$fileId');
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
              : const Icon(KapdhIcons.sync),
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
          _TappableKta(data: KtaCardData.fromMemberCard(card, avatar: _avatar(card))),
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
              icon: KapdhIcons.brightnessHighOutlined,
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
              icon: KapdhIcons.locationCityOutlined,
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
          _TappableKta(
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
    return _OfflineUnavailable(
      key: const ValueKey('kta-offline-unavailable'),
      title: title,
      message: message,
      syncing: _syncing,
      onSync: () => _sync(),
    );
  }
}

/// KTA tidak dapat ditampilkan karena server tidak terjangkau dan cache tidak sah (AC F05-3). Tombol Sinkronkan
/// selebar layar agar labelnya membungkus, bukan meluap, pada teks 200 % (N-11); tarik ke bawah juga menyinkronkan.
class _OfflineUnavailable extends StatelessWidget {
  const _OfflineUnavailable({
    super.key,
    required this.title,
    required this.message,
    required this.syncing,
    required this.onSync,
  });

  final String title;
  final String message;
  final bool syncing;
  final Future<void> Function() onSync;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onSync,
      child: ListView(
        padding: const EdgeInsets.all(KapdhSpace.s6),
        children: [
          const SizedBox(height: KapdhSpace.s6),
          Center(
            child: ExcludeSemantics(
              child: Container(
                width: 64,
                height: 64,
                decoration: const BoxDecoration(color: KapdhColors.dangerBg, shape: BoxShape.circle),
                child: const Icon(KapdhIcons.cloudOff, size: 30, color: KapdhColors.danger),
              ),
            ),
          ),
          const SizedBox(height: KapdhSpace.s4),
          Semantics(
            header: true,
            child: Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: KapdhFontSize.h3, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(height: KapdhSpace.s2),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhColors.textMuted),
          ),
          const SizedBox(height: KapdhSpace.s5),
          KapdhButton.outlined(
            label: 'Sinkronkan',
            icon: KapdhIcons.sync,
            busy: syncing,
            busyLabel: 'Menyinkronkan...',
            onPressed: syncing ? null : () => unawaited(onSync()),
          ),
        ],
      ),
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
          const Icon(KapdhIcons.sync, size: 14, color: KapdhColors.textMuted),
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
      (KapdhIcons.qrCode2, 'QR KTA untuk verifikasi'),
      (KapdhIcons.groupsOutlined, 'Jejaring alumni dan chat'),
      (KapdhIcons.eventOutlined, 'Pendaftaran event dan tiket'),
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

/// KTA yang membuka pratinjau layar penuh landscape saat diketuk.
class _TappableKta extends StatelessWidget {
  const _TappableKta({required this.data});

  final KtaCardData data;

  @override
  Widget build(BuildContext context) => KtaCard(data: data, onTap: () => unawaited(showKtaFullScreen(context, data)));
}
