import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_palette.dart';
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

/// Jaringan sosial di profil ("Media Sosial"; v2 berlogo platform Phosphor).
enum SocialNetwork {
  instagram('Instagram', KapdhIcons.instagramLogo, 'https://instagram.com/'),
  x('X (Twitter)', KapdhIcons.xLogo, 'https://x.com/'),
  facebook('Facebook', KapdhIcons.facebook, 'https://facebook.com/'),
  linkedin('LinkedIn', KapdhIcons.linkedinLogo, 'https://www.linkedin.com/in/');

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
    // Hanya nama pengguna sederhana; nilai lain (mis. skema berbahaya) tidak dijadikan tautan.
    if (!RegExp(r'^[A-Za-z0-9._-]{1,100}$').hasMatch(handle)) return null;
    return Uri.parse('$baseUrl${Uri.encodeComponent(handle)}');
  }
}

/// Profil alumni (guideline hal. 7; v2): pita zamrud, avatar bercincin emas, nama, email dan kota; Angkatan, Riwayat
/// Pendidikan, Profesi, Keahlian, Nomor Telpon, Tentang, Media Sosial; tombol "Kirim Pesan". Kontak hanya tampil bila
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
                      icon: KapdhIcons.personOffOutlined,
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

  /// [v2] Piksel gulir isi untuk [BrandStatusBarFill]: pengisi status bar memudar masuk saat pita tergulir.
  final _scrollOffset = ValueNotifier<double>(0);

  NetworkMemberProfile get profile => widget.profile;

  @override
  void dispose() {
    _scrollOffset.dispose();
    super.dispose();
  }

  bool _onScroll(ScrollNotification notification) {
    // Hanya scroll view langsung (depth 0) dan vertikal; gulir bersarang tidak memengaruhi pengisi.
    if (notification.depth == 0 && notification.metrics.axis == Axis.vertical) {
      _scrollOffset.value = notification.metrics.pixels;
    }
    return false;
  }

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

  Future<void> _copy(String text, String done) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(done)));
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
        child: Text('${cohortTag(p.cohortCode)} · Lulus ${p.graduationYear}', style: _valueStyle(context)),
      ),
      if (education.isNotEmpty)
        _Section(
          title: 'Riwayat Pendidikan',
          child: _EducationItem(
            name: p.lastEducationInstitution?.trim().isNotEmpty == true ? p.lastEducationInstitution! : education,
            meta: p.lastEducationInstitution?.trim().isNotEmpty == true ? p.lastEducationCity : null,
          ),
        ),
      if (p.profession != null)
        _Section(
          title: 'Profesi',
          child: Align(
            alignment: Alignment.centerLeft,
            child: TagChip(label: p.profession!.label),
          ),
        ),
      if (p.skills.isNotEmpty)
        _Section(
          title: 'Keahlian',
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
          child: _PhoneLink(
            phone: p.phone!,
            onCall: () => _open(Uri(scheme: 'tel', path: p.phone!.replaceAll(RegExp(r'[^0-9+]'), ''))),
            onCopy: () => _copy(p.phone!, 'Nomor telpon disalin.'),
          ),
        ),
      if (p.bio != null && p.bio!.trim().isNotEmpty)
        _Section(
          title: 'Tentang',
          child: Text(p.bio!, style: _valueStyle(context).copyWith(height: 1.5)),
        ),
      if (socialEntries.isNotEmpty)
        _Section(
          title: 'Media Sosial',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
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

    // [v2] Ikon status bar terang di atas pita hijau; area status bar tetap hijau saat pita tergulir.
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: kBrandStatusBarOverlay,
      child: Scaffold(
        backgroundColor: context.kc.surface,
        body: Column(
          children: [
            Expanded(
              child: Stack(
                children: [
                  Positioned.fill(
                    child: NotificationListener<ScrollNotification>(
                      onNotification: _onScroll,
                      child: CustomScrollView(
                        slivers: [
                          // [v2] Pita zamrud 132 bersudut bawah 24 (sama dengan header Beranda): tombol kaca, judul
                          // "Profil Alumni", avatar 96 bercincin emas menumpuk tepi pita sejauh 48; nama dan kontak
                          // terpusat di bawahnya. Pita global Offline/Pemeliharaan, bila ada, tampil tepat di bawah
                          // pita dan avatar tidak menumpuk.
                          SliverToBoxAdapter(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Stack(
                                  clipBehavior: Clip.none,
                                  children: [
                                    BrandHeader(
                                      rounded: true,
                                      minHeight: 132,
                                      padding: const EdgeInsets.fromLTRB(
                                        KapdhSpace.s1,
                                        KapdhSpace.s1,
                                        KapdhSpace.s1,
                                        0,
                                      ),
                                      child: Row(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          BrandIconButton(
                                            icon: KapdhIcons.arrowBack,
                                            tooltip: 'Kembali',
                                            onPressed: _back,
                                          ),
                                          Expanded(
                                            // Min 48 (setinggi tombol), judul di tengah; tumbuh ke bawah bila
                                            // baris > 48 (mockup: min-height 48 + align-items center), jadi tetap
                                            // sejajar tombol pada teks 200 %.
                                            child: ConstrainedBox(
                                              constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
                                              child: const Align(
                                                heightFactor: 1,
                                                child: Text(
                                                  'Profil Alumni',
                                                  textAlign: TextAlign.center,
                                                  style: TextStyle(
                                                    fontSize: 17,
                                                    fontWeight: FontWeight.w700,
                                                    height: 1.3,
                                                    color: KapdhColors.textOnDark,
                                                  ),
                                                ),
                                              ),
                                            ),
                                          ),
                                          if (!p.isMe)
                                            // MenuAnchor (bukan PopupMenuButton) agar InkWell kaca BrandIconButton
                                            // sendiri yang menangani ketukan: state layer tekan/fokus tampil di
                                            // tombol, sama dengan Kembali.
                                            MenuAnchor(
                                              menuChildren: [
                                                if (p.isBlockedByMe)
                                                  MenuItemButton(
                                                    onPressed: () => _onAction(_ProfileAction.unblock),
                                                    child: const Text('Buka blokir'),
                                                  )
                                                else
                                                  MenuItemButton(
                                                    onPressed: () => _onAction(_ProfileAction.block),
                                                    child: const Text('Blokir'),
                                                  ),
                                                MenuItemButton(
                                                  onPressed: () => _onAction(_ProfileAction.report),
                                                  child: const Text('Laporkan'),
                                                ),
                                              ],
                                              builder: (context, controller, _) => BrandIconButton(
                                                icon: KapdhIcons.moreVert,
                                                tooltip: 'Tindakan lain',
                                                onPressed: () =>
                                                    controller.isOpen ? controller.close() : controller.open(),
                                              ),
                                            )
                                          else
                                            const SizedBox(width: KapdhSize.touchTargetMin),
                                        ],
                                      ),
                                    ),
                                    if (banner == null)
                                      Positioned(
                                        left: 0,
                                        right: 0,
                                        bottom: -48,
                                        child: Center(
                                          child: _ProfileAvatarRing(name: p.fullName, url: p.avatarUrl),
                                        ),
                                      ),
                                  ],
                                ),
                                if (banner != null) ...[
                                  banner,
                                  const SizedBox(height: KapdhSpace.s4),
                                  Center(
                                    child: _ProfileAvatarRing(name: p.fullName, url: p.avatarUrl),
                                  ),
                                ] else
                                  const SizedBox(height: 48),
                                Padding(
                                  padding: EdgeInsets.fromLTRB(
                                    ContentWidth.inset(context, KapdhSpace.s5),
                                    KapdhSpace.s3,
                                    ContentWidth.inset(context, KapdhSpace.s5),
                                    KapdhSpace.s4,
                                  ),
                                  child: Column(
                                    children: [
                                      Semantics(
                                        header: true,
                                        child: Text(
                                          p.fullName,
                                          textAlign: TextAlign.center,
                                          style: const TextStyle(
                                            fontSize: KapdhFontSize.h2,
                                            fontWeight: FontWeight.w700,
                                          ),
                                        ),
                                      ),
                                      // Kunci email hanya ada bila show_email=true (AC F10-2).
                                      if (p.email != null && p.email!.isNotEmpty)
                                        _IconLine(
                                          icon: KapdhIcons.mailOutline,
                                          text: p.email!,
                                          onTap: () => _open(Uri(scheme: 'mailto', path: p.email)),
                                        ),
                                      if (p.city != null && p.city!.isNotEmpty)
                                        _IconLine(icon: KapdhIcons.placeOutlined, text: p.city!),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                          if (p.isMe)
                            SliverToBoxAdapter(
                              child: Padding(
                                padding: EdgeInsets.fromLTRB(
                                  ContentWidth.inset(context, KapdhSpace.s5),
                                  0,
                                  ContentWidth.inset(context, KapdhSpace.s5),
                                  KapdhSpace.s3,
                                ),
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
                            padding: EdgeInsets.fromLTRB(
                              ContentWidth.inset(context, KapdhSpace.s5),
                              0,
                              ContentWidth.inset(context, KapdhSpace.s5),
                              KapdhSpace.s4,
                            ),
                            sliver: SliverList.separated(
                              itemCount: sections.length,
                              separatorBuilder: (_, _) => const Divider(height: KapdhSpace.s6),
                              itemBuilder: (_, index) => sections[index],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  BrandStatusBarFill(scrollOffset: _scrollOffset),
                ],
              ),
            ),
            if (!p.isMe)
              // [v2] Bilah pesan bawah: permukaan + garis rambut divider + bayangan atas (--shadow-bar-top). Container
              // (bukan DecoratedBox) agar lebar border menjadi padding: isi dimulai di bawah garis 1 px.
              Container(
                decoration: BoxDecoration(
                  color: context.kc.surface,
                  border: Border(top: BorderSide(color: context.kc.divider)),
                  boxShadow: context.kc.shadowBarTop,
                ),
                child: SafeArea(
                  top: false,
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(
                      ContentWidth.inset(context, KapdhSpace.s5),
                      KapdhSpace.s2,
                      ContentWidth.inset(context, KapdhSpace.s5),
                      KapdhSpace.s4,
                    ),
                    child: _MessageArea(
                      profile: p,
                      opening: _opening,
                      onMessage: _message,
                      onUnblock: () => _onAction(_ProfileAction.unblock),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

TextStyle _valueStyle(BuildContext context) => TextStyle(fontSize: KapdhFontSize.body, color: context.kc.textMuted);

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
        icon: KapdhIcons.block,
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
      icon: KapdhIcons.chatBubbleOutline,
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
          child: Text(
            title,
            style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
          ),
        ),
        const SizedBox(height: KapdhSpace.s2),
        child,
      ],
    );
  }
}

/// Avatar 96 dengan cincin permukaan 4 (memisahkan dari pita) dan cincin emas 2 serta bayangan (v2).
class _ProfileAvatarRing extends StatelessWidget {
  const _ProfileAvatarRing({required this.name, this.url});

  final String name;
  final String? url;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      boxShadow: [
        const BoxShadow(offset: Offset(0, 12), blurRadius: 24, spreadRadius: -6, color: Color(0x730E280C)),
        const BoxShadow(color: KapdhColors.accent, spreadRadius: 6),
        BoxShadow(color: context.kc.surface, spreadRadius: 4),
      ],
    ),
    child: AlumniAvatar(name: name, url: url, size: 96),
  );
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
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 16, color: context.kc.textMuted),
          const SizedBox(width: KapdhSpace.s1),
          Flexible(
            child: Text(
              text,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
            ),
          ),
        ],
      ),
    );
    if (onTap == null) return row;
    // Baris email: target sentuh minimal 48 dp (sama dengan _PhoneLink), selebar isi baris, dan peran tautan.
    return Semantics(
      link: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(KapdhRadius.sm),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
          child: Center(widthFactor: 1, child: row),
        ),
      ),
    );
  }
}

/// Nomor telpon yang dapat diketuk untuk menelepon (tautan `tel:`) dan ditekan lama untuk disalin. Teks biasa, bukan
/// SelectableText, agar ketukan tidak ditelan gestur seleksi; target sentuh minimal 48 dp dan peran tautan bagi
/// pembaca layar (N-11).
class _PhoneLink extends StatelessWidget {
  const _PhoneLink({required this.phone, required this.onCall, required this.onCopy});

  final String phone;
  final VoidCallback onCall;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      link: true,
      label: 'Telepon $phone',
      onTapHint: 'menelepon',
      onLongPressHint: 'salin nomor',
      onTap: onCall,
      onLongPress: onCopy,
      excludeSemantics: true,
      child: InkWell(
        onTap: onCall,
        onLongPress: onCopy,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(KapdhIcons.callOutlined, size: 18, color: context.kc.primary),
              const SizedBox(width: KapdhSpace.s2),
              Flexible(
                child: Text(
                  phone,
                  style: _valueStyle(context).copyWith(color: context.kc.primary, decoration: TextDecoration.underline),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Baris media sosial (v2): logo platform dalam kotak tint 36, nama platform 12 abu + nama pengguna/tautan 14 primary,
/// ikon tautan luar; seluruh baris 56 dapat diketuk bila tautannya aman (https).
class _SocialLink extends StatelessWidget {
  const _SocialLink({required this.network, required this.value, required this.onTap});

  final SocialNetwork network;
  final String value;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.kc;
    // Bentuk ringkas tanpa skema/www dan garis miring akhir (mockup: "linkedin.com/in/…"), agar nama pengguna
    // tidak terpotong lebih dulu; nama pengguna seperti "@nama" tidak berubah.
    final display = value
        .trim()
        .replaceFirst(RegExp(r'^https?://(www\.)?', caseSensitive: false), '')
        .replaceFirst(RegExp(r'/+$'), '');
    return Semantics(
      label: '${network.label}: $value',
      link: onTap != null,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(KapdhRadius.md),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Row(
            children: [
              _TintIcon(icon: network.icon),
              const SizedBox(width: KapdhSpace.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      network.label,
                      style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.4, color: p.textMuted),
                    ),
                    Text(
                      display,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w500, color: p.primary),
                    ),
                  ],
                ),
              ),
              if (onTap != null) Icon(KapdhIcons.openInNew, size: KapdhIconSize.sm, color: p.textMuted),
            ],
          ),
        ),
      ),
    );
  }
}

/// Ikon 20 dalam kotak tint 36 radius 12 (baris Riwayat Pendidikan dan Media Sosial v2).
class _TintIcon extends StatelessWidget {
  const _TintIcon({required this.icon});

  final IconData icon;

  @override
  Widget build(BuildContext context) => Container(
    width: 36,
    height: 36,
    decoration: BoxDecoration(color: context.kc.tint, borderRadius: BorderRadius.circular(KapdhRadius.md)),
    child: Icon(icon, size: KapdhIconSize.md, color: context.kc.primary),
  );
}

/// Satu pendidikan (v2): ikon toga, nama institusi 14 w600, keterangan 12 abu (kota). Riwayat berulang menunggu
/// kontrak education[].
class _EducationItem extends StatelessWidget {
  const _EducationItem({required this.name, this.meta});

  final String name;
  final String? meta;

  @override
  Widget build(BuildContext context) {
    final extra = meta;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _TintIcon(icon: KapdhIcons.schoolOutlined),
        const SizedBox(width: KapdhSpace.s3),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                name,
                style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600, height: 1.4),
              ),
              if (extra != null && extra.trim().isNotEmpty)
                Text(
                  extra,
                  style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.45, color: context.kc.textMuted),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
