import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/error_presenter.dart';
import '../../core/ui/external_links.dart';
import '../../design/design.dart';
import '../chat/chat_repository.dart';
import 'moderation_actions.dart';
import 'network_repository.dart';
import 'report_sheet.dart';
import 'widgets/alumni_avatar.dart';
import 'widgets/directory_member_card.dart';
import 'widgets/tag_chip.dart';

/// Profil anggota lain dari GET /directory/{userId} (AC F10-2, F10-4).
final memberProfileProvider = FutureProvider.autoDispose.family<NetworkMemberProfile, String>(
  (ref, userId) => ref.watch(networkRepositoryProvider).profile(userId),
  retry: (_, _) => null,
);

/// Jaringan sosial di profil (guideline hal. 7 "Social Media").
enum SocialNetwork {
  instagram('Instagram', Icons.camera_alt_outlined, 'https://instagram.com/'),
  x('X', Icons.alternate_email, 'https://x.com/'),
  facebook('Facebook', Icons.facebook, 'https://facebook.com/'),
  linkedin('LinkedIn', Icons.work_outline, 'https://www.linkedin.com/in/');

  const SocialNetwork(this.label, this.icon, this.baseUrl);

  final String label;
  final IconData icon;
  final String baseUrl;

  /// Tautan https dari nama pengguna atau URL tersimpan; null bila nilainya tidak dapat dibuka dengan aman (hanya
  /// https yang dibuka, bukan skema lain).
  Uri? linkFor(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) return null;
    if (trimmed.contains('://')) {
      final uri = Uri.tryParse(trimmed);
      return uri != null && uri.scheme == 'https' && uri.host.isNotEmpty ? uri : null;
    }
    final handle = trimmed.startsWith('@') ? trimmed.substring(1) : trimmed;
    if (handle.isEmpty || handle.contains(RegExp(r'[\s/?#]'))) return null;
    return Uri.parse('$baseUrl${Uri.encodeComponent(handle)}');
  }
}

/// Profil alumni (guideline hal. 7): kepala hijau bermotif, avatar, nama, email dan kota; Angkatan, Lulusan
/// Terakhir, Profesi, Skill, Nomor Telpon, Tentang, Social Media; tombol "Kirim Pesan". Kontak hanya tampil bila
/// pemiliknya mengizinkan, karena field yang disembunyikan tidak dikirim server (AC F10-2).
class MemberProfileScreen extends ConsumerWidget {
  const MemberProfileScreen({super.key, required this.userId});

  /// Parameter rute `userId`.
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(memberProfileProvider(userId));
    return profile.when(
      loading: () => const AppScaffold(
        title: 'Profil Alumni',
        fallbackLocation: AppRoutes.network,
        body: LoadingSkeleton(semanticsLabel: 'Memuat profil alumni'),
      ),
      error: (error, _) => AppScaffold(
        title: 'Profil Alumni',
        fallbackLocation: AppRoutes.network,
        body: error is ApiException
            ? (error.code == ErrorCode.notFound
                  // Alasan tidak dibedakan (N-09): tidak aktif, menyembunyikan profil, atau membatasi pemanggil.
                  ? const EmptyState(
                      icon: Icons.person_off_outlined,
                      title: 'Profil tidak tersedia',
                      message: 'Profil alumni ini tidak dapat ditampilkan saat ini.',
                    )
                  : ErrorState.fromException(error, onRetry: () => ref.invalidate(memberProfileProvider(userId))))
            : ErrorState(title: 'Terjadi kesalahan', message: '$error'),
      ),
      data: (data) => _ProfileView(profile: data),
    );
  }
}

class _ProfileView extends ConsumerStatefulWidget {
  const _ProfileView({required this.profile});

  final NetworkMemberProfile profile;

  @override
  ConsumerState<_ProfileView> createState() => _ProfileViewState();
}

enum _ProfileAction { block, unblock, report }

class _ProfileViewState extends ConsumerState<_ProfileView> {
  bool _opening = false;

  NetworkMemberProfile get profile => widget.profile;

  /// "Kirim Pesan": buka room direct yang sudah ada, atau buat/ambil room kanonik lewat POST /chat/direct
  /// (AC F11-1).
  Future<void> _message() async {
    final existing = profile.directRoomId;
    if (existing != null) {
      await context.push(AppRoutes.chat(existing));
      return;
    }
    setState(() => _opening = true);
    try {
      final room = await ref.read(chatRepositoryProvider).openDirect(profile.userId);
      if (!mounted) return;
      ref.invalidate(memberProfileProvider(profile.userId));
      await context.push(AppRoutes.chat(room.id));
    } on ApiException catch (error) {
      if (!mounted) return;
      await ref.read(errorPresenterProvider).present(error, onRetry: _message);
      if (error.code == ErrorCode.notFound || error.code == ErrorCode.forbidden) {
        ref.invalidate(memberProfileProvider(profile.userId));
      }
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  Future<void> _onAction(_ProfileAction action) async {
    switch (action) {
      case _ProfileAction.block:
        if (await blockWithConfirmation(context, ref, userId: profile.userId, name: profile.fullName)) {
          ref.invalidate(memberProfileProvider(profile.userId));
        }
      case _ProfileAction.unblock:
        if (await unblockWithConfirmation(context, ref, userId: profile.userId, name: profile.fullName)) {
          ref.invalidate(memberProfileProvider(profile.userId));
        }
      case _ProfileAction.report:
        await showReportSheet(context, UserReportTarget(userId: profile.userId, name: profile.fullName));
    }
  }

  Future<void> _open(Uri uri) async {
    final opened = await ref.read(externalLinkLauncherProvider)(uri);
    if (!opened && mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(content: Text('Tautan tidak dapat dibuka.')));
    }
  }

  void _back() {
    final router = GoRouter.of(context);
    if (router.canPop()) {
      router.pop();
    } else {
      router.go(AppRoutes.network);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = profile;
    final education = educationLine(p.lastEducationInstitution, p.lastEducationCity);
    final banner = AppBannerScope.of(context);
    final social = p.social;
    final socialEntries = social == null
        ? const <(SocialNetwork, String)>[]
        : [
            if (social.instagram != null) (SocialNetwork.instagram, social.instagram!),
            if (social.x != null) (SocialNetwork.x, social.x!),
            if (social.facebook != null) (SocialNetwork.facebook, social.facebook!),
            if (social.linkedin != null) (SocialNetwork.linkedin, social.linkedin!),
          ];

    final sections = <Widget>[
      _Section(
        title: 'Angkatan',
        child: Text('${cohortTag(p.cohortCode)} · Lulus ${p.graduationYear}', style: _valueStyle),
      ),
      if (education.isNotEmpty) _Section(title: 'Lulusan Terakhir', child: Text(education, style: _valueStyle)),
      if (p.profession != null)
        _Section(
          title: 'Profesi',
          child: Align(alignment: Alignment.centerLeft, child: TagChip(label: p.profession!.label)),
        ),
      if (p.skills.isNotEmpty)
        _Section(
          title: 'Skill',
          child: Wrap(
            spacing: KapdhSpace.s2,
            runSpacing: KapdhSpace.s2,
            children: [for (final skill in p.skills) TagChip(label: skill.label, tone: TagChipTone.blue)],
          ),
        ),
      // Kunci phone hanya ada bila show_phone=true (AC F10-2); nilai null berarti belum diisi pemilik.
      if (p.phone != null && p.phone!.trim().isNotEmpty)
        _Section(
          title: 'Nomor Telpon',
          child: InkWell(
            onTap: () => _open(Uri(scheme: 'tel', path: p.phone!.replaceAll(RegExp(r'[^0-9+]'), ''))),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: KapdhSpace.s1),
              child: SelectableText(p.phone!, style: _valueStyle),
            ),
          ),
        ),
      if (p.bio != null && p.bio!.trim().isNotEmpty)
        _Section(title: 'Tentang', child: Text(p.bio!, style: _valueStyle.copyWith(height: 1.5))),
      if (socialEntries.isNotEmpty)
        _Section(
          title: 'Social Media',
          child: Wrap(
            spacing: KapdhSpace.s4,
            runSpacing: KapdhSpace.s1,
            children: [
              for (final (network, value) in socialEntries)
                _SocialLink(
                  network: network,
                  value: value,
                  onTap: network.linkFor(value) == null ? null : () => _open(network.linkFor(value)!),
                ),
            ],
          ),
        ),
    ];

    return Scaffold(
      backgroundColor: KapdhColors.surface,
      body: Column(
        children: [
          Expanded(
            child: CustomScrollView(
              slivers: [
                SliverToBoxAdapter(
                  child: Stack(
                    children: [
                      BrandHeader(
                        minHeight: 112,
                        padding: const EdgeInsets.fromLTRB(KapdhSpace.s1, KapdhSpace.s1, KapdhSpace.s1, 0),
                        child: Row(
                          children: [
                            IconButton(
                              tooltip: 'Kembali',
                              color: KapdhColors.onPrimary,
                              icon: const Icon(Icons.arrow_back),
                              onPressed: _back,
                            ),
                            const Spacer(),
                            if (!p.isMe)
                              PopupMenuButton<_ProfileAction>(
                                tooltip: 'Tindakan lain',
                                iconColor: KapdhColors.onPrimary,
                                onSelected: _onAction,
                                itemBuilder: (_) => [
                                  if (p.isBlockedByMe)
                                    const PopupMenuItem(value: _ProfileAction.unblock, child: Text('Buka blokir'))
                                  else
                                    const PopupMenuItem(value: _ProfileAction.block, child: Text('Blokir')),
                                  const PopupMenuItem(value: _ProfileAction.report, child: Text('Laporkan')),
                                ],
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                if (banner != null) SliverToBoxAdapter(child: banner),
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s4),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        AlumniAvatar(name: p.fullName, url: p.avatarUrl, size: 72),
                        const SizedBox(width: KapdhSpace.s4),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Semantics(
                                header: true,
                                child: Text(
                                  p.fullName,
                                  style: const TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w700),
                                ),
                              ),
                              // Kunci email hanya ada bila show_email=true (AC F10-2).
                              if (p.email != null && p.email!.isNotEmpty)
                                _IconLine(
                                  icon: Icons.mail_outline,
                                  text: p.email!,
                                  onTap: () => _open(Uri(scheme: 'mailto', path: p.email)),
                                ),
                              if (p.city != null && p.city!.isNotEmpty)
                                _IconLine(icon: Icons.place_outlined, text: p.city!),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                if (p.isMe)
                  SliverToBoxAdapter(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, 0, KapdhSpace.s5, KapdhSpace.s3),
                      child: InfoBox(
                        message: 'Ini pratinjau profil Anda seperti dilihat alumni lain.',
                        trailing: TextButton(
                          onPressed: () => context.push(AppRoutes.accountPrivacy),
                          child: const Text('Atur privasi'),
                        ),
                      ),
                    ),
                  ),
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, 0, KapdhSpace.s5, KapdhSpace.s4),
                  sliver: SliverList.separated(
                    itemCount: sections.length,
                    separatorBuilder: (_, _) => const Divider(height: KapdhSpace.s6),
                    itemBuilder: (_, index) => sections[index],
                  ),
                ),
              ],
            ),
          ),
          if (!p.isMe)
            SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s2, KapdhSpace.s5, KapdhSpace.s4),
                child: _MessageArea(
                  profile: p,
                  opening: _opening,
                  onMessage: _message,
                  onUnblock: () => _onAction(_ProfileAction.unblock),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

const _valueStyle = TextStyle(fontSize: KapdhFontSize.body, color: KapdhColors.textMuted);

class _MessageArea extends StatelessWidget {
  const _MessageArea({required this.profile, required this.opening, required this.onMessage, required this.onUnblock});

  final NetworkMemberProfile profile;
  final bool opening;
  final VoidCallback onMessage;
  final VoidCallback onUnblock;

  @override
  Widget build(BuildContext context) {
    if (profile.isBlockedByMe) {
      return InfoBox(
        tone: InfoBoxTone.warning,
        icon: Icons.block,
        message: 'Anda memblokir ${profile.fullName}. Buka blokir untuk kembali saling mengirim pesan.',
        trailing: TextButton(onPressed: onUnblock, child: const Text('Buka blokir')),
      );
    }
    if (!profile.canMessage) {
      // Alasan sengaja tidak dibedakan (AC F12-1, N-09).
      return const InfoBox(message: 'Pesan langsung belum tersedia untuk anggota ini.');
    }
    return KapdhButton.outlined(
      label: 'Kirim Pesan',
      icon: Icons.chat_bubble_outline,
      busy: opening,
      busyLabel: 'Membuka percakapan',
      onPressed: opening ? null : onMessage,
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          header: true,
          child: Text(title, style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600)),
        ),
        const SizedBox(height: KapdhSpace.s2),
        child,
      ],
    );
  }
}

class _IconLine extends StatelessWidget {
  const _IconLine({required this.icon, required this.text, this.onTap});

  final IconData icon;
  final String text;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final row = Padding(
      padding: const EdgeInsets.only(top: KapdhSpace.s1),
      child: Row(
        children: [
          Icon(icon, size: 16, color: KapdhColors.textMuted),
          const SizedBox(width: KapdhSpace.s1),
          Flexible(
            child: Text(text, style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted)),
          ),
        ],
      ),
    );
    return onTap == null ? row : InkWell(onTap: onTap, child: row);
  }
}

class _SocialLink extends StatelessWidget {
  const _SocialLink({required this.network, required this.value, required this.onTap});

  final SocialNetwork network;
  final String value;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '${network.label}: $value',
      link: onTap != null,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin, minWidth: 140),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(network.icon, size: 18, color: KapdhColors.textMuted),
              const SizedBox(width: KapdhSpace.s2),
              Flexible(child: Text(value, style: _valueStyle, overflow: TextOverflow.ellipsis)),
            ],
          ),
        ),
      ),
    );
  }
}
