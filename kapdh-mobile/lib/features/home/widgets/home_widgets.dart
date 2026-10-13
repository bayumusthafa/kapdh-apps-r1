import 'package:flutter/material.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../design/design.dart';

/// Kepala Beranda (prototipe layar 4, 5; guideline hal. 7): logo, "Assalamu'alaikum," dan nama anggota, serta
/// pintasan notifikasi dengan jumlah belum dibaca (PRD 3.8 akses cepat notifikasi).
class HomeHeader extends StatelessWidget {
  const HomeHeader({super.key, required this.name, this.unreadCount, required this.onNotifications});

  final String name;

  /// Jumlah notifikasi belum dibaca; null bila belum diketahui.
  final int? unreadCount;
  final VoidCallback onNotifications;

  @override
  Widget build(BuildContext context) {
    final count = unreadCount ?? 0;
    final tooltip = count > 0 ? 'Notifikasi, $count belum dibaca' : 'Notifikasi';
    return BrandHeader(
      pattern: false,
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s2, KapdhSpace.s5),
      child: Row(
        children: [
          Image.asset('assets/logo-kapdh.png', width: 44, height: 44, semanticLabel: 'Logo KAPDH'),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Semantics(
              header: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    "Assalamu'alaikum,",
                    style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.green100),
                  ),
                  Text(
                    name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: KapdhFontSize.bodyLg,
                      fontWeight: FontWeight.w600,
                      color: KapdhColors.textOnDark,
                    ),
                  ),
                ],
              ),
            ),
          ),
          IconButton(
            key: const ValueKey('home-notifications'),
            tooltip: tooltip,
            onPressed: onNotifications,
            icon: Badge(
              isLabelVisible: count > 0,
              backgroundColor: KapdhColors.accent,
              textColor: KapdhColors.onAccent,
              label: Text(count > 99 ? '99+' : '$count'),
              child: const Icon(Icons.notifications_outlined, color: KapdhColors.textOnDark),
            ),
          ),
        ],
      ),
    );
  }
}

/// Satu pintasan Beranda (KTA, Notifikasi, Tiket, Berita).
@immutable
class QuickAction {
  const QuickAction({required this.icon, required this.label, required this.onTap, this.detail, this.key});

  final IconData icon;
  final String label;
  final String? detail;
  final VoidCallback onTap;
  final Key? key;
}

/// Baris akses cepat (PRD 3.8 "akses cepat KTA/notifikasi"); target sentuh minimal 48 px (N-11).
class QuickAccessRow extends StatelessWidget {
  const QuickAccessRow({super.key, required this.actions});

  final List<QuickAction> actions;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: KapdhSpace.s3, horizontal: KapdhSpace.s1),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [for (final action in actions) Expanded(child: _QuickTile(action: action))],
      ),
    );
  }
}

class _QuickTile extends StatelessWidget {
  const _QuickTile({required this.action});

  final QuickAction action;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      key: action.key,
      button: true,
      label: [action.label, ?action.detail].join(', '),
      excludeSemantics: true,
      onTap: action.onTap,
      child: InkWell(
        onTap: action.onTap,
        borderRadius: BorderRadius.circular(KapdhRadius.md),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2, vertical: KapdhSpace.s1),
            child: Column(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: const BoxDecoration(color: KapdhColors.green50, shape: BoxShape.circle),
                  child: Icon(action.icon, color: KapdhColors.primary, size: 22),
                ),
                const SizedBox(height: 6),
                Text(
                  action.label,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: KapdhFontSize.caption, fontWeight: FontWeight.w600),
                ),
                if (action.detail != null)
                  Text(
                    action.detail!,
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: KapdhFontSize.overline, color: KapdhColors.textMuted),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Teks kecil untuk bagian Beranda yang kosong.
class SectionEmpty extends StatelessWidget {
  const SectionEmpty({super.key, required this.message, this.icon = Icons.inbox_outlined});

  final String message;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(KapdhSpace.s4),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Row(
        children: [
          Icon(icon, color: KapdhColors.textMuted, size: 20),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Text(message, style: const TextStyle(fontSize: 13, color: KapdhColors.textMuted, height: 1.4)),
          ),
        ],
      ),
    );
  }
}
