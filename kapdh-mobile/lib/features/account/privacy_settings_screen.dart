import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/error_presenter.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import 'account_repository.dart';
import 'widgets/account_section.dart';

/// Privasi profil sendiri (F-10, AC F10-2, N-15). Bawaan melindungi kontak: telepon, email dan media sosial
/// tersembunyi sampai pemilik mengaktifkannya; tampil di direktori aktif. Data yang disembunyikan tidak dikirim ke
/// perangkat anggota lain (bukan sekadar disamarkan di layar). Setiap saklar disimpan langsung lewat PATCH
/// /me/profile dengan If-Match versi profil (AC F15-4); konflik versi memuat ulang nilai terbaru.
class PrivacySettingsScreen extends ConsumerStatefulWidget {
  const PrivacySettingsScreen({super.key});

  @override
  ConsumerState<PrivacySettingsScreen> createState() => _PrivacySettingsScreenState();
}

class _PrivacySettingsScreenState extends ConsumerState<PrivacySettingsScreen> {
  Me? _me;
  bool _loading = true;
  ApiException? _error;
  bool _saving = false;

  AccountRepository get _repo => ref.read(accountRepositoryProvider);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = _me == null;
      _error = null;
    });
    try {
      final me = await _repo.getMe();
      if (!mounted) return;
      setState(() {
        _me = me;
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

  Future<void> _set(ProfilePrivacyUpdate change) async {
    final me = _me;
    if (me == null || _saving) return;
    setState(() => _saving = true);
    try {
      final updated = await _repo.updateProfile(ProfileUpdate(privacy: change), version: me.version);
      if (!mounted) return;
      setState(() => _me = updated);
      unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.versionConflict) {
        // Profil diubah di perangkat lain: tampilkan nilai terbaru dari server sebelum pengguna mengulang.
        final current = error.current;
        if (current is Map<String, Object?>) {
          setState(() => _me = Me.fromJson(current));
        } else {
          unawaited(_load());
        }
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text('Profil baru saja diubah di perangkat lain. Pengaturan terbaru ditampilkan.')),
        );
      } else {
        await ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_set(change)));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(title: 'Privasi Profil', fallbackLocation: AppRoutes.account, body: _body());
  }

  Widget _body() {
    if (_loading) return const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat pengaturan privasi');
    final error = _error;
    final me = _me;
    if (error != null || me == null) {
      return ErrorState.fromException(
        error ?? const ApiException(kind: ApiFailureKind.unexpected, operationId: 'getMe'),
        onRetry: _load,
      );
    }
    final privacy = me.profile.privacy;
    final listed = switch (me.effectiveStatus) {
      EffectiveStatus.verified || EffectiveStatus.expiring => true,
      _ => false,
    };
    final enabled = !_saving;
    Widget flag({
      required String key,
      required String title,
      required String description,
      required bool value,
      required ProfilePrivacyUpdate Function(bool v) change,
      String? note,
    }) => SwitchListTile(
      key: ValueKey('privacy-$key'),
      contentPadding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s1),
      title: Text(
        title,
        style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        [description, ?note].join('\n'),
        style: const TextStyle(fontSize: KapdhFontSize.caption, height: 1.45),
      ),
      value: value,
      onChanged: enabled ? (v) => unawaited(_set(change(v))) : null,
    );

    return ListView(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s8),
      children: [
        const InfoBox(
          icon: Icons.shield_outlined,
          message:
              'Kontak dan media sosial Anda tersembunyi sampai Anda mengizinkannya. Data yang disembunyikan tidak '
              'dikirim ke perangkat anggota lain. Pengurus berizin tetap dapat melihat data Anda untuk keperluan '
              'administrasi yang tercatat.',
        ),
        if (!listed) ...[
          const SizedBox(height: KapdhSpace.s3),
          const InfoBox(
            tone: InfoBoxTone.warning,
            message:
                'Direktori hanya menampilkan anggota dengan KTA aktif. Profil Anda belum muncul di Jejaring sampai '
                'KTA aktif, apa pun pengaturan di bawah.',
          ),
        ],
        const SizedBox(height: KapdhSpace.s5),
        AccountSection(
          title: 'DIREKTORI',
          children: [
            flag(
              key: 'directory',
              title: 'Tampil di direktori Jejaring',
              description:
                  'Anggota aktif dapat menemukan nama, foto, angkatan, kota, profesi dan keahlian Anda. Bila dimatikan, '
                  'profil Anda tidak muncul di pencarian.',
              value: privacy.showInDirectory,
              change: (v) => ProfilePrivacyUpdate(showInDirectory: v),
            ),
          ],
        ),
        const SizedBox(height: KapdhSpace.s5),
        AccountSection(
          title: 'KONTAK DAN MEDIA SOSIAL',
          footnote: 'Bawaan: semua tersembunyi untuk melindungi kontak Anda.',
          children: [
            flag(
              key: 'phone',
              title: 'Tampilkan nomor telepon',
              description: 'Nomor telepon terlihat oleh anggota aktif di profil Anda.',
              note: me.profile.phone == null ? 'Anda belum mengisi nomor telepon.' : null,
              value: privacy.showPhone,
              change: (v) => ProfilePrivacyUpdate(showPhone: v),
            ),
            flag(
              key: 'email',
              title: 'Tampilkan email',
              description: 'Alamat email akun terlihat oleh anggota aktif di profil Anda.',
              value: privacy.showEmail,
              change: (v) => ProfilePrivacyUpdate(showEmail: v),
            ),
            flag(
              key: 'social',
              title: 'Tampilkan media sosial',
              description: 'Instagram, X, Facebook dan LinkedIn terlihat oleh anggota aktif di profil Anda.',
              value: privacy.showSocial,
              change: (v) => ProfilePrivacyUpdate(showSocial: v),
            ),
          ],
        ),
        if (_saving) ...[
          const SizedBox(height: KapdhSpace.s4),
          const Center(
            child: Text(
              'Menyimpan...',
              style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
            ),
          ),
        ],
      ],
    );
  }
}
