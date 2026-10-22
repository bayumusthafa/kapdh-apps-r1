import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_palette.dart';
import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/ui/profile_lists.dart';
import 'alumni_avatar.dart';
import 'tag_chip.dart';

/// Kode angkatan sebagai tagar (guideline hal. 7 "#KAPDH01"): `KAPDH 29` menjadi `#KAPDH29`.
String cohortTag(String cohortCode) => '#${cohortCode.replaceAll(RegExp(r'\s+'), '')}';

/// "Profesi • Kota" (guideline hal. 7); profesi lebih dari satu dipisah koma; bagian yang kosong dilewati.
String professionCityLine(List<String> professions, String? city) =>
    [professions.where((s) => s.trim().isNotEmpty).join(', '), ?city].where((s) => s.trim().isNotEmpty).join(' • ');

/// "Institusi • Strata" untuk pendidikan teratas (terbaru).
String educationLine(NetworkEducationEntry? entry) {
  if (entry == null) return '';
  final level = entry.level;
  return [
    entry.institution,
    if (level != null) educationLevelLabel(level),
  ].where((s) => s.trim().isNotEmpty).join(' • ');
}

/// Kartu alumni di direktori (guideline hal. 7): avatar, nama, profesi • kota, pendidikan teratas, chip keahlian dan
/// kode angkatan. Kontak tidak pernah tampil di kartu karena tidak ada di payload pencarian (AC F10-2).
class DirectoryMemberCard extends StatelessWidget {
  const DirectoryMemberCard({super.key, required this.member, required this.onTap, this.trailing});

  final DirectoryMember member;
  final VoidCallback onTap;

  /// Kontrol tambahan di kanan (mis. kotak centang pemilih anggota grup).
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final subtitle = professionCityLine(member.professions, member.city);
    final education = educationLine(member.latestEducation);
    // Kartu v2 (.card card--md): garis rambut cardBorder + bayangan sm, sama dengan TappableCard/SummaryCard.
    final radius = BorderRadius.circular(KapdhRadius.md);
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: radius, boxShadow: context.kc.shadowSm),
      child: Material(
        color: context.kc.surface,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: radius,
          side: BorderSide(color: context.kc.cardBorder),
        ),
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(KapdhSpace.s3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AlumniAvatar(name: member.fullName, url: member.avatarUrl, size: 48),
                const SizedBox(width: KapdhSpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        member.fullName,
                        style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
                      ),
                      if (subtitle.isNotEmpty)
                        Text(
                          subtitle,
                          style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
                        ),
                      if (education.isNotEmpty)
                        Text(
                          education,
                          style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
                        ),
                      if (member.skills.isNotEmpty) ...[
                        const SizedBox(height: KapdhSpace.s2),
                        Wrap(
                          spacing: KapdhSpace.s1,
                          runSpacing: KapdhSpace.s1,
                          children: [for (final skill in member.skills) TagChip(label: skill.label)],
                        ),
                      ],
                      const SizedBox(height: KapdhSpace.s2),
                      Text(
                        cohortTag(member.cohortCode),
                        style: TextStyle(fontSize: KapdhFontSize.overline, color: context.kc.textMuted),
                      ),
                    ],
                  ),
                ),
                ?trailing,
              ],
            ),
          ),
        ),
      ),
    );
  }
}
