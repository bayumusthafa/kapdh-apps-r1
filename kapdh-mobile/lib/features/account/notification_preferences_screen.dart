import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/error_presenter.dart';
import '../../core/push/push_platform.dart';
import '../../design/design.dart';
import 'widgets/scroll_column.dart';
import '../notifications/notification_presentation.dart';
import '../notifications/notifications_repository.dart';
import '../notifications/push_permission.dart';
import 'widgets/account_section.dart';

/// Preferensi notifikasi (F-13, AC F13-2): saklar push untuk pembayaran, keanggotaan, event, berita dan chat; email
/// untuk pembayaran, keanggotaan dan event. Kategori keamanan dan akun wajib dan selalu aktif (terkunci,
/// ARCHITECTURE §4.7). Mematikan kategori hanya menghentikan push/email berikutnya; kotak masuk tetap menyimpan
/// semuanya. Bagian atas menampilkan izin push perangkat beserta cara mengaktifkannya.
class NotificationPreferencesScreen extends ConsumerStatefulWidget {
  const NotificationPreferencesScreen({super.key});

  @override
  ConsumerState<NotificationPreferencesScreen> createState() => _NotificationPreferencesScreenState();
}

class _NotificationPreferencesScreenState extends ConsumerState<NotificationPreferencesScreen> {
  NotificationPreferences? _prefs;
  ApiException? _error;
  bool _loading = true;

  /// Penyimpanan berurutan: saklar dikunci selama satu PUT berjalan agar penggantian penuh tidak saling menimpa.
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    unawaited(ref.read(pushPermissionProvider.notifier).check());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final prefs = await ref.read(notificationsRepositoryProvider).preferences();
      if (!mounted) return;
      setState(() {
        _prefs = prefs;
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

  Future<void> _save(NotificationPreferencesUpdate update) async {
    final previous = _prefs;
    if (previous == null || _saving) return;
    // Tampilan langsung berubah; dikembalikan bila server menolak.
    setState(() {
      _saving = true;
      _prefs = NotificationPreferences(
        push: update.push,
        email: update.email,
        mandatoryCategories: previous.mandatoryCategories,
        updatedAt: previous.updatedAt,
      );
    });
    try {
      final saved = await ref.read(notificationsRepositoryProvider).savePreferences(update);
      if (mounted) setState(() => _prefs = saved);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _prefs = previous);
      unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_save(update))));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _setPush(PushPreferences Function(PushPreferences p) change) {
    final prefs = _prefs;
    if (prefs == null) return;
    unawaited(_save(NotificationPreferencesUpdate(push: change(prefs.push), email: prefs.email)));
  }

  void _setEmail(EmailPreferences Function(EmailPreferences e) change) {
    final prefs = _prefs;
    if (prefs == null) return;
    unawaited(_save(NotificationPreferencesUpdate(push: prefs.push, email: change(prefs.email))));
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(title: 'Preferensi Notifikasi', fallbackLocation: AppRoutes.account, body: _body());
  }

  Widget _body() {
    if (_loading) return const LoadingSkeleton(showCard: false, lines: 8, semanticsLabel: 'Memuat preferensi');
    final error = _error;
    final prefs = _prefs;
    if (error != null || prefs == null) {
      return ErrorState.fromException(
        error ?? const ApiException(kind: ApiFailureKind.unexpected, operationId: 'getNotificationPreferences'),
        onRetry: _load,
      );
    }
    final push = prefs.push;
    final email = prefs.email;
    final enabled = !_saving;
    return ScrollColumn(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s8),
      children: [
        const _DevicePushCard(),
        const SizedBox(height: KapdhSpace.s4),
        const InfoBox(
          icon: KapdhIcons.inboxOutlined,
          message:
              'Kotak masuk di aplikasi selalu menyimpan seluruh notifikasi, termasuk kategori yang push atau '
              'emailnya Anda matikan.',
        ),
        const SizedBox(height: KapdhSpace.s5),
        AccountSection(
          title: 'Notifikasi push',
          children: [
            _PreferenceSwitch(
              keyName: 'push-payment',
              title: 'Pembayaran',
              subtitle: 'Hasil verifikasi iuran dan tiket, penolakan bukti, refund.',
              value: push.payment,
              enabled: enabled,
              onChanged: (v) => _setPush((p) => _push(p, payment: v)),
            ),
            _PreferenceSwitch(
              keyName: 'push-membership',
              title: 'Masa KTA',
              subtitle: 'Aktivasi, pengingat 30 hari sebelum berakhir dan perpanjangan.',
              value: push.membership,
              enabled: enabled,
              onChanged: (v) => _setPush((p) => _push(p, membership: v)),
            ),
            _PreferenceSwitch(
              keyName: 'push-event',
              title: 'Event',
              subtitle: 'Pengingat H-3 dan H-1, perubahan dan pembatalan event.',
              value: push.event,
              enabled: enabled,
              onChanged: (v) => _setPush((p) => _push(p, event: v)),
            ),
            _PreferenceSwitch(
              keyName: 'push-news',
              title: 'Berita',
              subtitle: 'Pengumuman dan berita resmi pengurus.',
              value: push.news,
              enabled: enabled,
              onChanged: (v) => _setPush((p) => _push(p, news: v)),
            ),
            _PreferenceSwitch(
              keyName: 'push-chat',
              title: 'Chat',
              subtitle: 'Pesan dan undangan grup. Isi pesan tidak ditampilkan di layar kunci.',
              value: push.chat,
              enabled: enabled,
              onChanged: (v) => _setPush((p) => _push(p, chat: v)),
            ),
            // Kategori wajib dari server (`mandatory_categories`, selalu security dan account).
            for (final category in prefs.mandatoryCategories)
              _MandatoryRow(
                title: notificationCategoryStyle(category).label,
                subtitle: switch (category) {
                  NotificationCategory.security => 'Login, penggantian password dan pencabutan sesi. Selalu dikirim.',
                  NotificationCategory.account => 'Pembatasan, banding dan penghapusan akun. Selalu dikirim.',
                  _ => 'Wajib dan selalu dikirim.',
                },
              ),
          ],
        ),
        const SizedBox(height: KapdhSpace.s5),
        AccountSection(
          title: 'Email',
          children: [
            _PreferenceSwitch(
              keyName: 'email-payment',
              title: 'Pembayaran',
              subtitle: 'Ringkasan keputusan pembayaran ke email Anda.',
              value: email.payment,
              enabled: enabled,
              onChanged: (v) => _setEmail((e) => _email(e, payment: v)),
            ),
            _PreferenceSwitch(
              keyName: 'email-membership',
              title: 'Masa KTA',
              subtitle: 'Aktivasi dan pengingat perpanjangan.',
              value: email.membership,
              enabled: enabled,
              onChanged: (v) => _setEmail((e) => _email(e, membership: v)),
            ),
            _PreferenceSwitch(
              keyName: 'email-event',
              title: 'Event',
              subtitle: 'Tiket dan perubahan event yang Anda ikuti.',
              value: email.event,
              enabled: enabled,
              onChanged: (v) => _setEmail((e) => _email(e, event: v)),
            ),
            const _MandatoryRow(
              title: 'Kode OTP, keamanan dan akun',
              subtitle: 'Email ini wajib dan tidak dapat dimatikan.',
            ),
          ],
        ),
      ],
    );
  }

  static PushPreferences _push(
    PushPreferences p, {
    bool? payment,
    bool? membership,
    bool? event,
    bool? news,
    bool? chat,
  }) => PushPreferences(
    payment: payment ?? p.payment,
    membership: membership ?? p.membership,
    event: event ?? p.event,
    news: news ?? p.news,
    chat: chat ?? p.chat,
  );

  static EmailPreferences _email(EmailPreferences e, {bool? payment, bool? membership, bool? event}) =>
      EmailPreferences(payment: payment ?? e.payment, membership: membership ?? e.membership, event: event ?? e.event);
}

class _PreferenceSwitch extends StatelessWidget {
  const _PreferenceSwitch({
    required this.keyName,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  final String keyName;
  final String title;
  final String subtitle;
  final bool value;
  final bool enabled;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      key: ValueKey('pref-$keyName'),
      contentPadding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4),
      title: Text(
        title,
        style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w500),
      ),
      subtitle: Text(subtitle, style: const TextStyle(fontSize: KapdhFontSize.caption)),
      value: value,
      onChanged: enabled ? onChanged : null,
    );
  }
}

/// Kategori wajib: ditampilkan aktif dan terkunci dengan alasan, bukan saklar yang dinonaktifkan tanpa penjelasan.
class _MandatoryRow extends StatelessWidget {
  const _MandatoryRow({required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    // Teks > 130 %: label "Selalu aktif" pindah ke bawah subjudul agar trailing tidak menyempitkan judul.
    final big = MediaQuery.textScalerOf(context).scale(KapdhFontSize.caption) > KapdhFontSize.caption * 1.3;
    final alwaysOn = Semantics(
      label: 'Selalu aktif',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(KapdhIcons.lockOutline, size: 16, color: context.kc.textMuted),
          const SizedBox(width: KapdhSpace.s1),
          ExcludeSemantics(
            child: Text(
              'Selalu aktif',
              style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
            ),
          ),
        ],
      ),
    );
    final subtitleText = Text(subtitle, style: const TextStyle(fontSize: KapdhFontSize.caption));
    return MergeSemantics(
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4),
        title: Text(
          title,
          style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w500),
        ),
        subtitle: big
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  subtitleText,
                  const SizedBox(height: KapdhSpace.s1),
                  alwaysOn,
                ],
              )
            : subtitleText,
        trailing: big ? null : alwaysOn,
      ),
    );
  }
}

/// Izin push perangkat (AC F13-2): tanpa izin aplikasi tetap berfungsi dan kotak masuk tetap terbuka.
class _DevicePushCard extends ConsumerWidget {
  const _DevicePushCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(pushPermissionProvider);
    final controller = ref.read(pushPermissionProvider.notifier);
    final Widget content;
    if (state.available == null) {
      content = const InfoBox(message: 'Memeriksa notifikasi push perangkat...');
    } else if (state.available == false) {
      content = const InfoBox(
        icon: KapdhIcons.notificationsOffOutlined,
        title: 'Push tidak tersedia di perangkat ini',
        message:
            'Notifikasi tetap masuk ke kotak masuk aplikasi. Buka menu Notifikasi untuk melihat semua riwayat '
            'keputusan dan pengingat.',
      );
    } else if (state.granted) {
      content = const InfoBox(
        icon: KapdhIcons.notificationsActiveOutlined,
        title: 'Notifikasi push aktif',
        message: 'Perangkat ini menerima push untuk kategori yang Anda aktifkan di bawah.',
      );
    } else if (state.permission == PushPermission.denied) {
      content = InfoBox(
        tone: InfoBoxTone.warning,
        icon: KapdhIcons.notificationsOffOutlined,
        title: 'Izin notifikasi ditolak',
        message:
            'Aplikasi tetap berfungsi dan semua notifikasi tersimpan di kotak masuk. Untuk menerima push, aktifkan '
            'izin notifikasi KAPDH di Pengaturan perangkat (Aplikasi > KAPDH > Notifikasi), lalu periksa lagi.',
        trailing: TextButton(
          onPressed: state.busy ? null : () => unawaited(controller.request()),
          child: const Text('Periksa lagi'),
        ),
      );
    } else {
      content = InfoBox(
        icon: KapdhIcons.notificationsNone,
        title: 'Izinkan notifikasi push',
        message: 'Terima hasil pembayaran, pengingat masa KTA dan event langsung di perangkat ini.',
        trailing: TextButton(
          key: const ValueKey('push-permission-request'),
          onPressed: state.busy ? null : () => unawaited(controller.request()),
          child: const Text('Izinkan'),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        content,
        Align(
          alignment: Alignment.centerLeft,
          child: KapdhLinkButton(
            label: 'Buka kotak masuk',
            icon: KapdhIcons.inboxOutlined,
            onPressed: () => context.push(AppRoutes.notifications),
          ),
        ),
      ],
    );
  }
}
