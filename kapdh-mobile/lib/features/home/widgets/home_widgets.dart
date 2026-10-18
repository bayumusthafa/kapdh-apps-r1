import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/kapdh_focus.dart';
import '../../../app/theme/kapdh_palette.dart';
import '../../../app/theme/kapdh_tokens.dart';
import '../../../design/design.dart';

/// Kepala Beranda (prototipe layar 4, 5; guideline hal. 7; redesain v2): pita mesh zamrud bersudut bawah 24 dengan
/// logo dalam bingkai kaca bercincin emas, "Assalamu'alaikum," dan nama anggota, serta lonceng notifikasi dalam tombol
/// kaca 48 dengan lencana emas jumlah belum dibaca (PRD 3.8). Berupa slot app bar agar pita global
/// Offline/Pemeliharaan tampil tepat di bawahnya seperti layar lain (prototipe 7).
class HomeHeader extends StatelessWidget implements PreferredSizeWidget {
  const HomeHeader({super.key, required this.name, this.unreadCount, required this.onNotifications});

  /// Tinggi kepala tanpa inset status bar.
  static const double height = 76;

  final String name;

  /// Jumlah notifikasi belum dibaca; null bila belum diketahui.
  final int? unreadCount;
  final VoidCallback onNotifications;

  @override
  Size get preferredSize => const Size.fromHeight(height);

  @override
  Widget build(BuildContext context) {
    final count = unreadCount ?? 0;
    final tooltip = count > 0 ? 'Notifikasi, $count belum dibaca' : 'Notifikasi';
    final top = MediaQuery.paddingOf(context).top;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: kBrandStatusBarOverlay,
      child: BrandHeader(
        rounded: true,
        includeTopInset: false,
        minHeight: height + top,
        padding: EdgeInsets.fromLTRB(KapdhSpace.s5, top, KapdhSpace.s4, 0),
        // Seperti judul AppBar Material: skala teks kepala dibatasi 1,3 agar sapaan dan nama tetap muat di tinggi 76.
        child: MediaQuery.withClampedTextScaling(
          maxScaleFactor: 1.3,
          child: SizedBox(
            height: height,
            child: Row(
              children: [
                const BrandLogoFrame(),
                const SizedBox(width: KapdhSpace.s3),
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          "Assalamu'alaikum,",
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: KapdhFontSize.caption,
                            fontWeight: FontWeight.w500,
                            letterSpacing: 0.3,
                            color: KapdhColors.green100,
                          ),
                        ),
                        Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w700,
                            color: KapdhColors.textOnDark,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: KapdhSpace.s2),
                BrandIconButton(
                  key: const ValueKey('home-notifications'),
                  icon: KapdhIcons.notificationsOutlined,
                  tooltip: tooltip,
                  onPressed: onNotifications,
                  // [v2] Lencana emas 18 x 18 bercincin 2 px green800 (mockup .home-header .badge--accent): posisi
                  // mengikuti .badge, kiri = lebar ikon - 12, atas -6. Jumlah sudah dibacakan lewat tooltip.
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      const Icon(KapdhIcons.notificationsOutlined, color: KapdhColors.textOnDark),
                      if (count > 0)
                        Positioned(
                          left: 12,
                          top: -6,
                          child: ExcludeSemantics(
                            child: Container(
                              constraints: const BoxConstraints(minWidth: 18),
                              height: 18,
                              padding: const EdgeInsets.symmetric(horizontal: 4),
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: KapdhColors.accent,
                                borderRadius: BorderRadius.circular(9),
                                // Cincin 2 px di luar kotak 18, sama dengan box-shadow 0 0 0 2px green800 di mockup.
                                border: Border.all(
                                  color: KapdhColors.green800,
                                  width: 2,
                                  strokeAlign: BorderSide.strokeAlignOutside,
                                ),
                              ),
                              child: Text(
                                count > 99 ? '99+' : '$count',
                                style: const TextStyle(
                                  fontSize: KapdhFontSize.overline,
                                  fontWeight: FontWeight.w700,
                                  height: 1,
                                  color: KapdhColors.onAccent,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Satu pintasan Beranda (Pesan, Notifikasi, Tiket, Berita; KTA pada Beranda terkunci).
@immutable
class QuickAction {
  const QuickAction({
    required this.icon,
    required this.label,
    required this.onTap,
    this.detail,
    this.badgeCount,
    this.key,
  });

  /// Ikon Phosphor fill (KapdhIcons.*); diisi gradasi hijau di dalam lingkaran.
  final IconData icon;
  final String label;

  /// Teks kecil di bawah label (mis. status KTA). Jumlah belum dibaca memakai [badgeCount], bukan teks.
  final String? detail;

  /// Jumlah belum dibaca sebagai lencana emas di pojok lingkaran (null/0 = tanpa lencana).
  final int? badgeCount;
  final VoidCallback onTap;
  final Key? key;

  /// Label pembaca layar: "Pesan, 2 belum dibaca", "Notifikasi, Semua terbaca", "KTA, KTA Tidak Aktif".
  String get semanticsLabel {
    final count = badgeCount;
    final parts = [label, if (count != null) count > 0 ? '$count belum dibaca' : 'Semua terbaca', ?detail];
    return parts.join(', ');
  }
}

/// Baris akses cepat (PRD 3.8; redesain v2): kartu bergaris rambut berbayangan, empat ubin berikon lingkaran 56. Saat
/// teks diperbesar lebih dari 1,3 kali, ubin disusun 2 x 2 agar label tidak saling himpit (N-11).
class QuickAccessRow extends StatelessWidget {
  const QuickAccessRow({super.key, required this.actions});

  final List<QuickAction> actions;

  @override
  Widget build(BuildContext context) {
    final p = context.kc;
    final large = MediaQuery.textScalerOf(context).scale(KapdhFontSize.body) > KapdhFontSize.body * 1.3;
    final tiles = [for (final action in actions) _QuickTile(action: action)];
    return Container(
      padding: const EdgeInsets.fromLTRB(3, 15, 3, 13),
      decoration: BoxDecoration(
        color: p.surface,
        border: Border.all(color: p.cardBorder),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
        boxShadow: p.shadowSm,
      ),
      // Material transparan: tinta InkWell tiap ubin (ripple, hover, sorotan fokus) dilukis di atas latar kartu, bukan
      // di Material Scaffold di bawahnya.
      child: Material(
        type: MaterialType.transparency,
        child: large
            ? LayoutBuilder(
                builder: (context, constraints) => Wrap(
                  runSpacing: KapdhSpace.s3,
                  children: [for (final tile in tiles) SizedBox(width: constraints.maxWidth / 2, child: tile)],
                ),
              )
            : Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [for (final tile in tiles) Expanded(child: tile)],
              ),
      ),
    );
  }
}

class _QuickTile extends StatelessWidget {
  const _QuickTile({required this.action});

  final QuickAction action;

  @override
  Widget build(BuildContext context) {
    final p = context.kc;
    final count = action.badgeCount ?? 0;
    // [v2] Cincin fokus mengikuti seluruh area ketuk ubin (bukan hanya lingkaran 56) agar tidak terpotong lencana atau
    // label; radius sama dengan tinta InkWell.
    const radius = BorderRadius.all(Radius.circular(KapdhRadius.md));
    return Semantics(
      key: action.key,
      button: true,
      label: action.semanticsLabel,
      excludeSemantics: true,
      onTap: action.onTap,
      child: KapdhFocusRing(
        radius: radius,
        builder: (onFocusChange) => InkWell(
          onTap: action.onTap,
          onFocusChange: onFocusChange,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2, vertical: KapdhSpace.s1),
              child: Column(
                children: [
                  // [v2] Lingkaran 56 bergradasi lembut (sorot kiri atas), garis tipis, bayangan halus; ikon fill 28
                  // berisi gradasi hijau (mockup --qa-circle-bg / --qa-icon).
                  Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Container(
                        width: 56,
                        height: 56,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          gradient: p.qaCircle,
                          border: Border.all(color: p.qaCircleBorder),
                          boxShadow: [
                            BoxShadow(
                              offset: const Offset(0, 3),
                              blurRadius: 8,
                              spreadRadius: -2,
                              color: p.isDark ? const Color(0x73000000) : const Color(0x290E280C),
                            ),
                          ],
                        ),
                        alignment: Alignment.center,
                        child: ShaderMask(
                          blendMode: BlendMode.srcIn,
                          shaderCallback: (rect) => p.qaIcon.createShader(rect),
                          child: Icon(action.icon, size: KapdhIconSize.xl, color: KapdhColors.green800),
                        ),
                      ),
                      if (count > 0)
                        Positioned(
                          top: -3,
                          right: -5,
                          child: Container(
                            constraints: const BoxConstraints(minWidth: 20),
                            height: 20,
                            padding: const EdgeInsets.symmetric(horizontal: 5),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: KapdhColors.accent,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(color: p.surface, width: 2),
                            ),
                            child: Text(
                              count > 99 ? '99+' : '$count',
                              textScaler: MediaQuery.textScalerOf(context).clamp(maxScaleFactor: 1.3),
                              style: const TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                height: 1,
                                color: KapdhColors.onAccent,
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s2),
                  Text(
                    action.label,
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, height: 1.3),
                  ),
                  if (action.detail != null)
                    Text(
                      action.detail!,
                      textAlign: TextAlign.center,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: KapdhFontSize.overline, color: p.textMuted),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Teks kecil untuk bagian Beranda yang kosong. [v2] Garis putus-putus neutral300: "belum ada isi" dibedakan dari
/// kartu.
class SectionEmpty extends StatelessWidget {
  const SectionEmpty({super.key, required this.message, this.icon = KapdhIcons.inboxOutlined});

  final String message;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final p = context.kc;
    return CustomPaint(
      foregroundPainter: DashedBorderPainter(color: p.neutral300, radius: KapdhRadius.lg),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(KapdhSpace.s4),
        decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(KapdhRadius.lg)),
        child: Row(
          children: [
            Icon(icon, color: p.textMuted, size: KapdhIconSize.md),
            const SizedBox(width: KapdhSpace.s3),
            Expanded(
              child: Text(message, style: TextStyle(fontSize: 13, color: p.textMuted, height: 1.4)),
            ),
          ],
        ),
      ),
    );
  }
}
