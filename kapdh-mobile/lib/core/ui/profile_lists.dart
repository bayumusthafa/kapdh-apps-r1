import 'package:flutter/widgets.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../design/kapdh_icons.dart';

/// Batas daftar profil berulang (kontrak C2 `ProfileUpdate.professions/education/social_links` maxItems).
const int maxProfessions = 5;
const int maxEducationEntries = 10;
const int maxSocialLinks = 10;

/// Aturan tunggal tautan sosial kontrak C2 (`SocialHandle`): nama pengguna atau URL https; skema lain ditolak.
final RegExp socialHandlePattern = RegExp(
  r'''^(?:@?[A-Za-z0-9._-]{1,100}|https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[/?#][^\s<>"'`]*)?)$''',
);

/// Karakter kontrol Unicode (Cc): ditolak server pada profesi, pendidikan dan tautan (NUL tidak dapat disimpan).
bool hasControlCharacter(String value) => RegExp(r'\p{Cc}', unicode: true).hasMatch(value);

/// Platform tautan sosial (Ubah Profil v2): urutan menu, nama tampilan, logo Phosphor regular, petunjuk isian dan
/// domain untuk nama pengguna. Situs web hanya menerima URL.
extension SocialPlatformUi on SocialPlatform {
  /// Platform yang dapat dipilih, sesuai urutan menu mockup (tanpa [SocialPlatform.unknown]).
  static const List<SocialPlatform> choices = [
    SocialPlatform.instagram,
    SocialPlatform.tiktok,
    SocialPlatform.x,
    SocialPlatform.facebook,
    SocialPlatform.linkedin,
    SocialPlatform.youtube,
    SocialPlatform.threads,
    SocialPlatform.telegram,
    SocialPlatform.website,
  ];

  String get label => switch (this) {
    SocialPlatform.instagram => 'Instagram',
    SocialPlatform.tiktok => 'TikTok',
    SocialPlatform.x => 'X (Twitter)',
    SocialPlatform.facebook => 'Facebook',
    SocialPlatform.linkedin => 'LinkedIn',
    SocialPlatform.youtube => 'YouTube',
    SocialPlatform.threads => 'Threads',
    SocialPlatform.telegram => 'Telegram',
    SocialPlatform.website => 'Situs web',
    SocialPlatform.unknown => 'Tautan',
  };

  IconData get icon => switch (this) {
    SocialPlatform.instagram => KapdhIcons.instagramLogo,
    SocialPlatform.tiktok => KapdhIcons.tiktokLogo,
    SocialPlatform.x => KapdhIcons.xLogo,
    SocialPlatform.facebook => KapdhIcons.facebook,
    SocialPlatform.linkedin => KapdhIcons.linkedinLogo,
    SocialPlatform.youtube => KapdhIcons.youtubeLogo,
    SocialPlatform.threads => KapdhIcons.threadsLogo,
    SocialPlatform.telegram => KapdhIcons.telegramLogo,
    SocialPlatform.website || SocialPlatform.unknown => KapdhIcons.language,
  };

  /// Placeholder field nama pengguna/tautan.
  String get hint => switch (this) {
    SocialPlatform.linkedin => 'https://www.linkedin.com/in/...',
    SocialPlatform.facebook => 'nama pengguna atau tautan',
    SocialPlatform.website || SocialPlatform.unknown => 'https://...',
    _ => '@namapengguna',
  };

  /// Awalan tautan untuk nama pengguna; null bila platform hanya menerima URL.
  String? get _baseUrl => switch (this) {
    SocialPlatform.instagram => 'https://instagram.com/',
    SocialPlatform.tiktok => 'https://www.tiktok.com/@',
    SocialPlatform.x => 'https://x.com/',
    SocialPlatform.facebook => 'https://facebook.com/',
    SocialPlatform.linkedin => 'https://www.linkedin.com/in/',
    SocialPlatform.youtube => 'https://www.youtube.com/@',
    SocialPlatform.threads => 'https://www.threads.net/@',
    SocialPlatform.telegram => 'https://t.me/',
    SocialPlatform.website || SocialPlatform.unknown => null,
  };

  /// Tautan https dari nama pengguna atau URL tersimpan; null bila nilainya tidak dapat dibuka dengan aman (hanya
  /// https yang dibuka, bukan skema lain).
  Uri? linkFor(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) return null;
    if (trimmed.contains('://')) {
      final uri = Uri.tryParse(trimmed);
      return uri != null && uri.scheme == 'https' && uri.host.isNotEmpty ? uri : null;
    }
    final base = _baseUrl;
    final handle = trimmed.startsWith('@') ? trimmed.substring(1) : trimmed;
    // Hanya nama pengguna sederhana; nilai lain (mis. skema berbahaya) tidak dijadikan tautan.
    if (base == null || !RegExp(r'^[A-Za-z0-9._-]{1,100}$').hasMatch(handle)) return null;
    return Uri.parse('$base${Uri.encodeComponent(handle)}');
  }

  /// Galat isian lokal sesuai aturan server (SocialHandle; situs web hanya https), atau null bila sah.
  String? problemOf(String value) {
    if (value.length > 200 || !socialHandlePattern.hasMatch(value)) {
      return 'Isi nama pengguna atau tautan yang diawali https://';
    }
    if (this == SocialPlatform.website && !value.startsWith('https://')) return 'Isi tautan yang diawali https://';
    return null;
  }
}

/// Strata pendidikan (kontrak EducationLevel) dalam urutan pilihan.
const List<EducationLevel> educationLevelChoices = [
  EducationLevel.d3,
  EducationLevel.s1,
  EducationLevel.s2,
  EducationLevel.s3,
  EducationLevel.otherValue,
];

String educationLevelLabel(EducationLevel level) => switch (level) {
  EducationLevel.d3 => 'D3',
  EducationLevel.s1 => 'S1',
  EducationLevel.s2 => 'S2',
  EducationLevel.s3 => 'S3',
  EducationLevel.otherValue || EducationLevel.unknown => 'Lainnya',
};

/// Keterangan satu riwayat pendidikan (Profil Alumni v2): "S1 · Pendidikan Bahasa Arab · Tamat 2019"; bagian yang
/// kosong dilewati.
String educationMetaLine({EducationLevel? level, String? major, int? graduationYear}) => [
  if (level != null) educationLevelLabel(level),
  if (major != null && major.trim().isNotEmpty) major.trim(),
  if (graduationYear != null) 'Tamat $graduationYear',
].join(' · ');
