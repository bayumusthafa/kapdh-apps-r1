import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_tokens.dart';
import 'alumni_avatar.dart';
import 'tag_chip.dart';

/// Kode angkatan sebagai tagar (guideline hal. 7 "#KAPDH01"): `KAPDH 29` menjadi `#KAPDH29`.
String cohortTag(String cohortCode) => '#${cohortCode.replaceAll(RegExp(r'\s+'), '')}';

/// "Profesi • Kota" (guideline hal. 7); bagian yang kosong dilewati.
String professionCityLine(String? profession, String? city) =>
    [profession, city].whereType<String>().where((s) => s.trim().isNotEmpty).join(' • ');

/// "Institusi • Kota" untuk lulusan terakhir.
String educationLine(String? institution, String? city) =>
    [institution, city].whereType<String>().where((s) => s.trim().isNotEmpty).join(' • ');

/// Kartu alumni di direktori (guideline hal. 7): avatar, nama, profesi • kota, lulusan terakhir, chip keahlian dan
/// kode angkatan. Kontak tidak pernah tampil di kartu karena tidak ada di payload pencarian (AC F10-2).
class DirectoryMemberCard extends StatelessWidget {
  const DirectoryMemberCard({super.key, required this.member, required this.onTap, this.trailing});

  final DirectoryMember member;
  final VoidCallback onTap;

  /// Kontrol tambahan di kanan (mis. kotak centang pemilih anggota grup).
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final subtitle = professionCityLine(member.profession?.label, member.city);
    final education = educationLine(member.lastEducationInstitution, member.lastEducationCity);
    return Card(
      margin: EdgeInsets.zero,
      color: KapdhColors.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(KapdhRadius.md),
        side: const BorderSide(color: KapdhColors.divider),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(KapdhRadius.md),
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
                        style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                      ),
                    if (education.isNotEmpty)
                      Text(
                        education,
                        style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
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
                      style: const TextStyle(fontSize: KapdhFontSize.overline, color: KapdhColors.textMuted),
                    ),
                  ],
                ),
              ),
              ?trailing,
            ],
          ),
        ),
      ),
    );
  }
}
