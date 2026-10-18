import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';
import 'app_scaffold.dart';
import 'info_box.dart';
import 'kapdh_icons.dart';

/// Penanda layar yang rutenya sudah terdaftar tetapi isinya dibangun pada irisan fitur berikutnya (BUILD_PLAN fase
/// C). Ditandai jelas "Sedang dibangun" agar tidak dikira fitur yang gagal.
class UnderConstructionScreen extends StatelessWidget {
  const UnderConstructionScreen({
    super.key,
    required this.title,
    required this.feature,
    required this.description,
    this.showBack = true,
    this.fallbackLocation = '/',
    this.actions = const [],
  });

  final String title;

  /// ID fitur PRD, mis. "F-08".
  final String feature;

  /// Isi layar yang akan dibangun.
  final String description;
  final bool showBack;
  final String fallbackLocation;

  /// Tindakan yang sudah tersedia di layar ini (mis. "Keluar" di Akun).
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: title,
      showBack: showBack,
      fallbackLocation: fallbackLocation,
      body: ListView(
        padding: const EdgeInsets.all(KapdhSpace.s5),
        children: [
          const SizedBox(height: KapdhSpace.s6),
          const ExcludeSemantics(child: Icon(KapdhIcons.construction, size: 56, color: KapdhColors.primary)),
          const SizedBox(height: KapdhSpace.s4),
          Text('Sedang dibangun', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: KapdhSpace.s2),
          Text(
            '$title ($feature)',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: KapdhFontSize.body, color: KapdhColors.textMuted),
          ),
          const SizedBox(height: KapdhSpace.s5),
          InfoBox(message: description),
          for (final action in actions) ...[const SizedBox(height: KapdhSpace.s4), action],
        ],
      ),
    );
  }
}
