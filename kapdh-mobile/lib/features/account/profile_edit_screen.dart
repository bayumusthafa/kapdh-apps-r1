import 'dart:async';

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_palette.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/api/error_presenter.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/profile_lists.dart';
import '../../design/design.dart';
import 'widgets/scroll_column.dart';
import 'account_repository.dart';
import 'avatar_image.dart';
import 'widgets/account_section.dart';
import 'widgets/master_picker.dart';
import 'widgets/profile_avatar.dart';

/// Pola nomor telepon kontrak C2 (`ProfileUpdate.phone`).
final RegExp _phonePattern = RegExp(r'^\+?[0-9][0-9 -]{5,22}$');

/// Kunci galat server per entri daftar berulang (`education.0.institution`, `social_links.1.value`, `education.2`).
final RegExp _rowErrorKey = RegExp(r'^(education|social_links)\.(\d+)(?:\.(\w+))?$');

/// Tahun tamat paling awal yang dapat dipilih (kontrak `EducationEntryInput.graduation_year` minimum).
const int _firstGraduationYear = 1950;

/// Selisih WIB (Asia/Jakarta, UTC+7, tanpa musim panas): server menilai tahun tamat terhadap tahun berjalan zona ini.
const Duration _wibOffset = Duration(hours: 7);

/// Bentuk pembanding satu riwayat pendidikan (urutan field kontrak EducationEntry).
typedef _EducationKey = (String, String?, EducationLevel?, int?);

/// Bentuk pembanding entri tersimpan, dinormalkan sama seperti isian ([_EducationDraft.key]).
_EducationKey _educationKeyOf(EducationEntry entry) {
  final major = entry.major?.trim() ?? '';
  return (entry.institution.trim(), major.isEmpty ? null : major, entry.level, entry.graduationYear);
}

/// Penggabungan tiga arah satu daftar berulang untuk "Pakai isian saya" (AC F15-4): [latest] dikurangi entri yang
/// dihapus pengguna terhadap [base], ditambah entri yang ia tambahkan; entri yang diubah dihitung sebagai hapus yang
/// lama dan tambah yang baru. Entri dikenali lewat [key] (nilai utuhnya). Urutan [latest] dipertahankan dan tambahan
/// disusulkan dalam urutan pengguna; tambahan yang sudah ada di [latest] menurut [sameAs] (aturan ganda server) tidak
/// digandakan. Bila daftar itu tidak berubah di versi terbaru, isian pengguna dipakai apa adanya beserta urutannya.
/// Batas jumlah sengaja tidak dipotong di sini: kelebihan ditandai validasi lokal sehingga pengguna sendiri yang
/// memilih entri yang dilepas.
List<T> _mergeList<T, K>({
  required List<K> base,
  required List<T> mine,
  required List<T> latest,
  required K Function(T item) key,
  Object? Function(T item)? sameAs,
}) {
  if (listEquals([for (final item in latest) key(item)], base)) return mine;
  // Entri dasar yang tidak ditemukan lagi di isian pengguna adalah yang ia hapus atau ubah.
  final removed = [...base];
  final added = [
    for (final item in mine)
      if (!removed.remove(key(item))) item,
  ];
  final merged = [
    for (final item in latest)
      if (!removed.remove(key(item))) item,
  ];
  final duplicateOf = sameAs ?? key;
  final present = {for (final item in merged) duplicateOf(item)};
  return [
    ...merged,
    for (final item in added)
      if (!present.contains(duplicateOf(item))) item,
  ];
}

/// Satu riwayat pendidikan yang sedang diisi ("Pendidikan n"). [id] stabil per baris agar field tidak bertukar isi
/// saat baris lain dihapus.
class _EducationDraft {
  _EducationDraft({String institution = '', String major = ''})
    : institution = TextEditingController(text: institution),
      major = TextEditingController(text: major),
      id = _nextId++;

  factory _EducationDraft.of(
    EducationEntry entry,
  ) => _EducationDraft(institution: entry.institution, major: entry.major ?? '')
    // Strata yang belum dikenal versi ini tidak punya pilihan di dropdown; daftarnya dikunci (lihat _educationLocked).
    ..level = entry.level == EducationLevel.unknown ? null : entry.level
    ..year = entry.graduationYear;

  static int _nextId = 0;

  final int id;
  final TextEditingController institution;
  final TextEditingController major;
  EducationLevel? level;
  int? year;

  /// Baris yang sama sekali belum diisi diabaikan saat menyimpan.
  bool get blank => institution.text.trim().isEmpty && major.text.trim().isEmpty && level == null && year == null;

  /// Bentuk pembanding (urutan field kontrak EducationEntry).
  _EducationKey get key {
    final m = major.text.trim();
    return (institution.text.trim(), m.isEmpty ? null : m, level, year);
  }

  void dispose() {
    institution.dispose();
    major.dispose();
  }
}

/// Satu tautan media sosial yang sedang diisi.
class _SocialDraft {
  _SocialDraft({required this.platform, String value = ''})
    : value = TextEditingController(text: value),
      id = _nextId++;

  static int _nextId = 0;

  final int id;
  final TextEditingController value;
  SocialPlatform platform;

  bool get blank => value.text.trim().isEmpty;

  /// Nilai seperti yang disimpan server (aturan SocialHandle: @ di depan nama pengguna dibuang).
  String get normalized {
    final v = value.text.trim();
    return v.startsWith('@') ? v.substring(1) : v;
  }

  /// Bentuk pembanding terhadap tautan tersimpan.
  (SocialPlatform, String) get key => (platform, normalized);

  /// Kunci tautan ganda menurut server: platform yang sama dengan nilai yang sama tanpa membedakan huruf besar.
  String get duplicateKey => '${platform.name}:${normalized.toLowerCase()}';

  void dispose() => value.dispose();
}

/// Ubah profil sendiri (F-10, PRD 4.6; guideline hal. 7; v2): foto, kota, telepon, tentang saya, profesi (lebih dari
/// satu, dari daftar atau ketik sendiri), maksimal 10 keahlian dari master terkontrol, riwayat pendidikan berulang dan
/// media sosial berulang (maksimal 10). Identitas keanggotaan (nama, jenis kelamin, angkatan, kelas, email, nomor
/// anggota) hanya ditampilkan; koreksinya oleh pengurus (PRD 3.5, AC F05-6). Hanya field yang berubah dikirim lewat
/// PATCH /me/profile dengan If-Match versi profil (AC F15-4); isian tidak hilang saat jaringan gagal (PRD 4.5).
class ProfileEditScreen extends ConsumerStatefulWidget {
  const ProfileEditScreen({super.key});

  @override
  ConsumerState<ProfileEditScreen> createState() => _ProfileEditScreenState();
}

class _ProfileEditScreenState extends ConsumerState<ProfileEditScreen> {
  final _city = TextEditingController();
  final _phone = TextEditingController();
  final _bio = TextEditingController();

  Me? _me;
  bool _loading = true;
  ApiException? _error;

  List<String> _professions = const [];
  List<MasterItem> _skills = const [];
  List<_EducationDraft> _education = const [];
  List<_SocialDraft> _links = const [];
  PickedAvatar? _newAvatar;

  /// Berkas foto yang sudah terunggah untuk [_newAvatar]; dipakai ulang saat simpan diulang (kuota unggah N-10).
  String? _uploadedAvatarId;
  bool _removeAvatar = false;

  bool _saving = false;
  bool _submitted = false;
  Map<String, List<String>> _fieldErrors = const {};

  /// Galat server per baris daftar berulang, berkunci id draf yang benar-benar dikirim, sehingga galat tetap di baris
  /// yang salah walau baris lain kemudian diisi atau dihapus.
  Map<int, Map<String, String>> _rowErrors = const {};

  /// Daftar yang memuat nilai yang belum dikenal versi aplikasi ini (platform atau strata baru dari server). Daftar
  /// itu hanya ditampilkan dan tidak pernah dikirim: SDK mengodekan nilai tak dikenal sebagai '' yang ditolak server,
  /// dan membuangnya dari daftar pengganti akan menghapus entri itu (N-13).
  bool _educationLocked = false;
  bool _linksLocked = false;

  List<MasterItem>? _professionMasters;
  List<MasterItem>? _skillMasters;

  AccountRepository get _repo => ref.read(accountRepositoryProvider);

  /// Field teks formulir beserta nilainya di profil server: dipakai untuk mengisi formulir dan untuk mengenali
  /// isian yang benar-benar diubah pengguna saat konflik versi (AC F15-4).
  List<(TextEditingController, String? Function(Profile))> get _textFields => [
    (_city, (p) => p.city),
    (_phone, (p) => p.phone),
    (_bio, (p) => p.bio),
  ];

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    for (final (controller, _) in _textFields) {
      controller.dispose();
    }
    for (final draft in _education) {
      draft.dispose();
    }
    for (final draft in _links) {
      draft.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final me = await _repo.getMe();
      if (!mounted) return;
      _fill(me);
      setState(() => _loading = false);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  /// Mengganti baris daftar berulang. Pengendali baris lama dibuang setelah frame berikut, saat field-nya sudah
  /// dilepas dari pohon widget.
  void _replaceDrafts({List<_EducationDraft>? education, List<_SocialDraft>? links}) {
    final retired = [
      if (education != null) ..._education.where((d) => !education.contains(d)),
      if (links != null) ..._links.where((d) => !links.contains(d)),
    ];
    if (education != null) _education = education;
    if (links != null) _links = links;
    if (retired.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // Baris yang dipasang kembali (rebase konflik memakai baris isian sendiri) tidak dibuang.
      for (final draft in retired) {
        if (draft is _EducationDraft && !_education.contains(draft)) draft.dispose();
        if (draft is _SocialDraft && !_links.contains(draft)) draft.dispose();
      }
    });
  }

  /// Mengisi formulir dari profil server (memuat pertama atau "muat versi terbaru").
  void _fill(Me me) {
    final p = me.profile;
    _me = me;
    for (final (controller, value) in _textFields) {
      controller.text = value(p) ?? '';
    }
    _professions = p.professions;
    _skills = p.skills;
    _educationLocked = p.education.any((e) => e.level == EducationLevel.unknown);
    _linksLocked = p.socialLinks.any((l) => l.platform == SocialPlatform.unknown);
    _replaceDrafts(
      education: [for (final entry in p.education) _EducationDraft.of(entry)],
      links: [
        for (final link in p.socialLinks)
          if (link.platform != SocialPlatform.unknown) _SocialDraft(platform: link.platform, value: link.value),
      ],
    );
    _newAvatar = null;
    _uploadedAvatarId = null;
    _removeAvatar = false;
    _fieldErrors = const {};
    _rowErrors = const {};
  }

  /// "Pakai isian saya" setelah 409 VERSION_CONFLICT (AC F15-4, PRD 4.5): hanya field yang benar-benar diubah
  /// pengguna terhadap versi yang ia buka diterapkan di atas [latest]. Field lain mengikuti versi terbaru, sehingga
  /// simpan berikutnya (If-Match versi terbaru) tidak menimpa perubahan dari perangkat lain atau pengurus. Daftar
  /// berulang yang diubah di kedua sisi digabung per entri ([_mergeList]): entri yang ditambahkan atau diubah di tempat
  /// lain tetap ada, entri yang dihapus pengguna tetap terhapus.
  void _rebase(Me latest) {
    final base = _me?.profile;
    if (base == null) {
      _fill(latest);
      return;
    }
    final textEdits = [
      for (final (controller, value) in _textFields)
        if (_norm(controller.text) != value(base)) (controller, controller.text),
    ];
    final professions = _sameStrings(_professions, base.professions) ? null : _professions;
    final skills = _sameSkills(_skills, base.skills) ? null : _skills;
    final education = _sameEducation(base.education) ? null : _education;
    final links = _sameLinks(base.socialLinks) ? null : _links;
    final newAvatar = _newAvatar;
    final uploadedAvatarId = _uploadedAvatarId;
    final removeAvatar = _removeAvatar;

    _fill(latest);
    final next = latest.profile;
    for (final (controller, text) in textEdits) {
      controller.text = text;
    }
    if (professions != null) {
      _professions = _mergeList(
        base: base.professions,
        mine: professions,
        latest: next.professions,
        key: (label) => label,
        sameAs: (label) => label.trim().toLowerCase(),
      );
    }
    if (skills != null) {
      _skills = _mergeList(
        base: [for (final skill in base.skills) skill.id],
        mine: skills,
        latest: next.skills,
        key: (skill) => skill.id,
      );
    }
    // Baris isian sendiri dipertahankan (pengendali yang sama) di samping baris versi terbaru, kecuali daftar versi
    // terbaru kini memuat nilai yang belum dikenal (daftar terkunci, ikut versi terbaru).
    _replaceDrafts(
      education: education == null || _educationLocked
          ? null
          : _mergeList(
              base: [for (final entry in base.education) _educationKeyOf(entry)],
              mine: education,
              latest: _education,
              key: (draft) => draft.key,
            ),
      links: links == null || _linksLocked
          ? null
          : _mergeList(
              base: [for (final link in base.socialLinks) (link.platform, link.value)],
              mine: links,
              latest: _links,
              key: (draft) => draft.key,
              sameAs: (draft) => draft.duplicateKey,
            ),
    );
    _newAvatar = newAvatar;
    _uploadedAvatarId = uploadedAvatarId;
    _removeAvatar = removeAvatar;
  }

  static String? _norm(String value) {
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }

  static bool _sameStrings(List<String> a, List<String> b) =>
      a.length == b.length && [for (var i = 0; i < a.length; i++) a[i] == b[i]].every((same) => same);

  static bool _sameSkills(List<MasterItem> a, List<MasterItem> b) {
    final left = {for (final s in a) s.id};
    final right = {for (final s in b) s.id};
    return left.length == right.length && left.containsAll(right);
  }

  List<_EducationDraft> get _filledEducation => [
    for (final draft in _education)
      if (!draft.blank) draft,
  ];

  List<_SocialDraft> get _filledLinks => [
    for (final draft in _links)
      if (!draft.blank) draft,
  ];

  bool _sameEducation(List<EducationEntry> base) {
    if (_educationLocked) return true;
    final drafts = _filledEducation;
    if (drafts.length != base.length) return false;
    for (var i = 0; i < base.length; i++) {
      if (drafts[i].key != _educationKeyOf(base[i])) return false;
    }
    return true;
  }

  bool _sameLinks(List<SocialLink> base) {
    if (_linksLocked) return true;
    final drafts = _filledLinks;
    if (drafts.length != base.length) return false;
    for (var i = 0; i < base.length; i++) {
      if (drafts[i].key != (base[i].platform, base[i].value)) return false;
    }
    return true;
  }

  /// Indeks entri pada body yang dikirim (baris kosong tidak ikut), untuk memetakan galat server
  /// (`education.0.institution`, `social_links.1.value`) ke baris formulir.
  int? _sentIndexOf<T>(List<T> all, T draft, bool Function(T) blank) {
    if (blank(draft)) return null;
    var index = 0;
    for (final d in all) {
      if (identical(d, draft)) return index;
      if (!blank(d)) index++;
    }
    return null;
  }

  /// Galat validasi lokal per field (kunci = path field kontrak), sama dengan aturan server C2.
  Map<String, String> _localErrors() {
    final errors = <String, String>{};
    final profile = _me?.profile;
    final city = _norm(_city.text);
    if (city == null && profile?.city != null) errors['city'] = 'Kota domisili tidak boleh dikosongkan.';
    if (city != null && city.length > 80) errors['city'] = 'Maksimal 80 karakter.';
    final phone = _norm(_phone.text);
    if (phone != null && (phone.length > 24 || !_phonePattern.hasMatch(phone))) {
      errors['phone'] = 'Gunakan angka, boleh diawali + (mis. +62 812 3456 7890).';
    }
    if (_bio.text.trim().length > 500) errors['bio'] = 'Maksimal 500 karakter.';
    if (_skills.length > maxSkills) errors['skill_ids'] = 'Maksimal $maxSkills keahlian.';
    if (_professions.length > maxProfessions) errors['professions'] = 'Maksimal $maxProfessions profesi.';
    for (final label in _professions) {
      if (label.length > 100) errors['professions'] = 'Profesi "$label" melebihi 100 karakter.';
      if (hasControlCharacter(label)) errors['professions'] = 'Profesi "$label" memuat karakter yang tidak diizinkan.';
    }
    final education = _filledEducation;
    // Melebihi batas hanya mungkin setelah "Pakai isian saya" menggabungkan entri dari perangkat lain: ditandai, tidak
    // dipotong, agar pengguna memilih sendiri yang dihapus.
    if (education.length > maxEducationEntries) {
      errors['education'] = 'Maksimal $maxEducationEntries riwayat pendidikan.';
    }
    for (final (i, draft) in education.indexed) {
      final institution = draft.institution.text.trim();
      if (institution.isEmpty) {
        errors['education.$i.institution'] = 'Isi universitas/instansi atau hapus riwayat ini.';
      } else if (institution.length > 120) {
        errors['education.$i.institution'] = 'Maksimal 120 karakter.';
      }
      if (draft.major.text.trim().length > 120) errors['education.$i.major'] = 'Maksimal 120 karakter.';
    }
    final links = _filledLinks;
    if (links.length > maxSocialLinks) errors['social_links'] = 'Maksimal $maxSocialLinks tautan.';
    final seen = <String>{};
    for (final (i, draft) in links.indexed) {
      final problem = draft.platform.problemOf(draft.value.text.trim());
      if (problem != null) {
        errors['social_links.$i.value'] = problem;
      } else if (!seen.add(draft.duplicateKey)) {
        errors['social_links.$i.value'] = 'Tautan ini sudah ada.';
      }
    }
    return errors;
  }

  /// Perubahan terhadap profil [base]; hanya field yang berbeda dikirim (PATCH).
  ProfileUpdate? _diff(Me base, {String? avatarFileId}) {
    final p = base.profile;
    Optional<String?> text(String value, String? current) {
      final next = _norm(value);
      return next == current ? const Optional.absent() : Optional(next);
    }

    final city = _norm(_city.text);
    final update = ProfileUpdate(
      city: city != null && city != p.city ? city : null,
      phone: text(_phone.text, p.phone),
      bio: text(_bio.text, p.bio),
      professions: _sameStrings(_professions, p.professions) ? null : _professions,
      education: _sameEducation(p.education)
          ? null
          : [
              for (final draft in _filledEducation)
                EducationEntryInput(
                  institution: draft.institution.text.trim(),
                  major: Optional(draft.key.$2),
                  level: Optional(draft.level),
                  graduationYear: Optional(draft.year),
                ),
            ],
      socialLinks: _sameLinks(p.socialLinks)
          ? null
          : [
              for (final draft in _filledLinks)
                SocialLinkInput(platform: draft.platform, value: draft.value.text.trim()),
            ],
      skillIds: _sameSkills(_skills, p.skills) ? null : [for (final s in _skills) s.id],
      avatarFileId: avatarFileId != null
          ? Optional(avatarFileId)
          : (_removeAvatar && p.avatarFileId != null ? const Optional(null) : const Optional.absent()),
    );
    return update.toJson().isEmpty ? null : update;
  }

  bool get _dirty {
    final me = _me;
    if (me == null) return false;
    return _newAvatar != null || _diff(me) != null;
  }

  Future<void> _pickAvatar() async {
    final source = await showModalBottomSheet<AvatarSource>(
      context: context,
      useRootNavigator: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(KapdhIcons.photoCameraOutlined),
              title: const Text('Ambil foto'),
              onTap: () => Navigator.of(sheetContext).pop(AvatarSource.camera),
            ),
            ListTile(
              key: const ValueKey('avatar-source-gallery'),
              leading: const Icon(KapdhIcons.photoLibraryOutlined),
              title: const Text('Pilih dari galeri'),
              onTap: () => Navigator.of(sheetContext).pop(AvatarSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (!mounted || source == null) return;
    final PickedAvatar? picked;
    try {
      picked = await ref.read(avatarPickerProvider)(source);
    } on Object {
      if (mounted) _snack('Foto tidak dapat dibuka. Periksa izin kamera/galeri lalu coba lagi.');
      return;
    }
    if (picked == null || !mounted) return;
    final problem = avatarProblem(picked);
    if (problem != null) {
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Foto tidak dapat dipakai'),
          content: Text('$problem\n\nGunakan foto JPG, PNG atau WebP maksimal 5 MB.'),
          actions: [TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Tutup'))],
        ),
      );
      return;
    }
    setState(() {
      _newAvatar = picked;
      _uploadedAvatarId = null;
      _removeAvatar = false;
    });
  }

  void _removePhoto() {
    setState(() {
      _newAvatar = null;
      _uploadedAvatarId = null;
      _removeAvatar = true;
    });
  }

  Future<void> _chooseProfessions() async {
    final professions = await showProfessionsPicker(
      context,
      load: () async => _professionMasters ??= await _repo.listMasters(MasterKind.professions),
      selected: _professions,
    );
    if (professions != null && mounted) setState(() => _professions = professions);
  }

  Future<void> _chooseSkills() async {
    final skills = await showSkillsPicker(
      context,
      load: () async => _skillMasters ??= await _repo.listMasters(MasterKind.skills),
      selected: _skills,
    );
    if (skills != null && mounted) setState(() => _skills = skills);
  }

  void _addEducation() => setState(() => _replaceDrafts(education: [..._education, _EducationDraft()]));

  void _removeEducation(_EducationDraft draft) =>
      setState(() => _replaceDrafts(education: [..._education]..remove(draft)));

  /// Tautan baru memakai platform pertama yang belum dipakai (Situs web bila semua sudah ada).
  void _addLink() {
    final used = {for (final d in _links) d.platform};
    final platform = SocialPlatformUi.choices.firstWhere(
      (p) => !used.contains(p),
      orElse: () => SocialPlatform.website,
    );
    setState(
      () => _replaceDrafts(
        links: [
          ..._links,
          _SocialDraft(platform: platform),
        ],
      ),
    );
  }

  void _removeLink(_SocialDraft draft) => setState(() => _replaceDrafts(links: [..._links]..remove(draft)));

  Future<void> _save() async {
    final me = _me;
    if (me == null || _saving) return;
    setState(() => _submitted = true);
    if (_localErrors().isNotEmpty) {
      _snack('Periksa kembali isian yang ditandai.');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _saving = true;
      _fieldErrors = const {};
    });
    var sentEducation = const <_EducationDraft>[];
    var sentLinks = const <_SocialDraft>[];
    try {
      var avatarId = _uploadedAvatarId;
      final picked = _newAvatar;
      if (picked != null && avatarId == null) {
        final file = await _repo.uploadAvatar(avatarMultipart(picked));
        avatarId = file.id;
        if (mounted) setState(() => _uploadedAvatarId = avatarId);
      }
      final update = _diff(me, avatarFileId: avatarId);
      // Draf yang ikut terkirim, untuk memetakan galat server berindeks ke barisnya.
      sentEducation = _filledEducation;
      sentLinks = _filledLinks;
      if (update == null) {
        _snack('Tidak ada perubahan untuk disimpan.');
        return;
      }
      final updated = await _repo.updateProfile(update, version: me.version);
      if (!mounted) return;
      setState(() => _fill(updated));
      unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
      _snack('Profil tersimpan.');
      await _leave();
    } on ApiException catch (error) {
      if (!mounted) return;
      // Tombol kembali aktif sebelum dialog galat/konflik tampil.
      setState(() => _saving = false);
      if (error.code == ErrorCode.versionConflict) {
        await _onConflict(error);
      } else if (error.fieldErrors.isNotEmpty) {
        setState(() {
          _fieldErrors = error.fieldErrors;
          _rowErrors = _rowErrorsOf(error.fieldErrors, sentEducation, sentLinks);
        });
        _snack(error.message);
      } else {
        if (error.code == ErrorCode.fileInvalid) setState(() => _uploadedAvatarId = null);
        unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_save())));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// Galat server `education.N.*` dan `social_links.N.*` berkunci id draf ke-N yang dikirim. Galat seluruh entri
  /// (`education.N`) ditampilkan pada field utama barisnya.
  static Map<int, Map<String, String>> _rowErrorsOf(
    Map<String, List<String>> fieldErrors,
    List<_EducationDraft> education,
    List<_SocialDraft> links,
  ) {
    final rows = <int, Map<String, String>>{};
    for (final MapEntry(:key, :value) in fieldErrors.entries) {
      final match = _rowErrorKey.firstMatch(key);
      if (match == null) continue;
      final index = int.parse(match.group(2)!);
      final isEducation = match.group(1) == 'education';
      final ids = isEducation ? [for (final d in education) d.id] : [for (final d in links) d.id];
      if (index >= ids.length) continue;
      final field = match.group(3) ?? (isEducation ? 'institution' : 'value');
      (rows[ids[index]] ??= {})[field] = value.join(' ');
    }
    return rows;
  }

  /// 409 VERSION_CONFLICT (AC F15-4, PRD 4.5): profil diubah di perangkat lain. Pengguna memilih memuat versi
  /// terbaru (isian dibuang) atau menerapkan perubahannya sendiri di atas versi terbaru ([_rebase]).
  Future<void> _onConflict(ApiException error) async {
    // "Coba lagi" pada snackbar dapat diketuk setelah layar ditutup.
    if (!mounted) return;
    final current = error.current;
    final Me latest;
    if (current is Map<String, Object?>) {
      latest = Me.fromJson(current);
    } else {
      try {
        latest = await _repo.getMe();
      } on ApiException catch (loadError) {
        if (!mounted) return;
        // Versi terbaru gagal dimuat (offline, 5xx): isian tetap utuh dan galat ditampilkan dengan "Coba lagi"
        // yang memuat ulang versi terbaru lalu menawarkan pilihan konflik lagi (PRD 4.5).
        unawaited(ref.read(errorPresenterProvider).present(loadError, onRetry: () => unawaited(_onConflict(error))));
        return;
      }
    }
    if (!mounted) return;
    final keepMine = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Profil diubah di perangkat lain'),
        content: const Text(
          'Profil Anda baru saja diubah dari perangkat lain. Muat versi terbaru, atau terapkan hanya isian yang '
          'Anda ubah di atas versi terbaru lalu simpan lagi.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Muat terbaru')),
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: const Text('Pakai isian saya')),
        ],
      ),
    );
    if (!mounted) return;
    setState(() {
      if (keepMine ?? false) {
        _rebase(latest);
      } else {
        _fill(latest);
      }
    });
  }

  void _snack(String message) => ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(message)));

  /// Kembali setelah formulir bersih; menunggu frame berikut agar PopScope sudah mengizinkan pop.
  Future<void> _leave() async {
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted) return;
    final router = GoRouter.of(context);
    if (router.canPop()) {
      router.pop();
    } else {
      router.go(AppRoutes.account);
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_dirty || _saving,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final leave = await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: const Text('Buang perubahan?'),
            content: const Text('Perubahan profil yang belum disimpan akan hilang.'),
            actions: [
              TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Lanjut mengubah')),
              TextButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: const Text('Buang')),
            ],
          ),
        );
        final me = _me;
        if ((leave ?? false) && mounted && me != null) {
          setState(() => _fill(me));
          await _leave();
        }
      },
      child: AppScaffold(title: 'Ubah Profil', fallbackLocation: AppRoutes.account, body: _body()),
    );
  }

  Widget _body() {
    if (_loading) return const LoadingSkeleton(showCard: false, lines: 8, semanticsLabel: 'Memuat profil');
    final error = _error;
    final me = _me;
    if (error != null || me == null) {
      return ErrorState.fromException(
        error ?? const ApiException(kind: ApiFailureKind.unexpected, operationId: 'getMe'),
        onRetry: _load,
      );
    }
    final local = _submitted ? _localErrors() : const <String, String>{};
    String? fieldError(String key) => _fieldErrors[key]?.join(' ') ?? local[key];
    final profile = me.profile;
    final showAvatarUrl = _removeAvatar ? null : profile.avatarUrl;
    // Tahun berjalan menurut WIB seperti validasi server, bukan zona waktu perangkat.
    final currentYear = ref.read(clockProvider)().toUtc().add(_wibOffset).year;

    Widget field(
      String key,
      String label,
      TextEditingController controller, {
      String? hint,
      IconData? icon,
      TextInputType? keyboard,
      int maxLines = 1,
      int? minLines,
      String? helper,
      Iterable<String>? autofill,
      double bottom = KapdhSpace.s4,
    }) => Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: KapdhTextField(
        key: ValueKey('profile-$key'),
        label: label,
        controller: controller,
        hint: hint,
        prefixIcon: icon,
        keyboardType: keyboard,
        maxLines: maxLines,
        minLines: minLines,
        helperText: helper,
        autofillHints: autofill,
        errorText: fieldError(key),
        onChanged: (_) => setState(() {}),
      ),
    );

    return ScrollColumn(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s8),
      children: [
        Center(
          child: Column(
            children: [
              ProfileAvatar(name: profile.fullName, url: showAvatarUrl, bytes: _newAvatar?.bytes, size: 96),
              const SizedBox(height: KapdhSpace.s2),
              Wrap(
                alignment: WrapAlignment.center,
                children: [
                  KapdhLinkButton(
                    key: const ValueKey('avatar-change'),
                    label: 'Ganti foto',
                    icon: KapdhIcons.photoCameraOutlined,
                    onPressed: _saving ? null : _pickAvatar,
                  ),
                  if (_newAvatar != null || (profile.avatarFileId != null && !_removeAvatar))
                    KapdhLinkButton(
                      key: const ValueKey('avatar-delete'),
                      label: 'Hapus foto',
                      icon: KapdhIcons.deleteOutline,
                      onPressed: _saving ? null : _removePhoto,
                    ),
                ],
              ),
              if (fieldError('avatar_file_id') case final message?)
                Text(
                  message,
                  style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.danger),
                ),
              Text(
                'JPG, PNG atau WebP maksimal 5 MB. Data lokasi foto dihapus otomatis.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
              ),
            ],
          ),
        ),
        const SizedBox(height: KapdhSpace.s5),
        AccountSection(
          title: 'DATA KEANGGOTAAN',
          footnote:
              'Data keanggotaan hanya dapat dikoreksi pengurus. Hubungi pengurus bila ada yang keliru; email diubah '
              'lewat alur verifikasi email.',
          children: [
            _ReadOnlyRow(label: 'Nama lengkap', value: profile.fullName),
            _ReadOnlyRow(label: 'Email', value: me.email),
            if (me.memberNumber case final number?) _ReadOnlyRow(label: 'Nomor anggota', value: number),
            _ReadOnlyRow(label: 'Angkatan', value: '${me.cohortCode} · lulus ${profile.graduationYear}'),
            _ReadOnlyRow(label: 'Tahun masuk - keluar', value: '${profile.entryYear} - ${profile.exitYear}'),
          ],
        ),
        const SizedBox(height: KapdhSpace.s5),
        field(
          'city',
          'Kota domisili',
          _city,
          hint: 'Mis. Pekanbaru',
          icon: KapdhIcons.locationOnOutlined,
          helper: 'Hanya kota, bukan alamat lengkap. Tampil di KTA.',
        ),
        field(
          'phone',
          'Nomor telepon',
          _phone,
          hint: '+62 812 3456 7890',
          icon: KapdhIcons.phoneOutlined,
          keyboard: TextInputType.phone,
          autofill: const [AutofillHints.telephoneNumber],
          helper: 'Disembunyikan dari anggota lain kecuali Anda mengizinkannya di Privasi.',
        ),
        field(
          'bio',
          'Tentang saya',
          _bio,
          hint: 'Ceritakan singkat tentang Anda',
          maxLines: 4,
          minLines: 1,
          helper: '${_bio.text.trim().length}/500 karakter',
        ),
        const SizedBox(height: KapdhSpace.s2),
        // [v2] Tiga kartu berkepala ikon: Profesi & Keahlian, Riwayat Pendidikan dan Media Sosial (daftar berulang).
        AccountFormCard(
          icon: KapdhIcons.workOutline,
          title: 'Profesi & Keahlian',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _TagPickerField(
                key: const ValueKey('profile-professions'),
                pickerKey: const ValueKey('profile-professions-picker'),
                label: 'Profesi',
                kind: 'profesi',
                tags: _professions,
                placeholder: 'Pilih atau tambah…',
                helper:
                    'Pekerjaan utama saat ini; boleh lebih dari satu (maksimal $maxProfessions). Pilih dari daftar atau '
                    'ketik sendiri.',
                // Galat daftar (`professions`) dan per label (`professions.N`) dari server, atau validasi lokal.
                errorText:
                    [
                      for (final MapEntry(:key, :value) in _fieldErrors.entries)
                        if (key == 'professions' || key.startsWith('professions.')) ...value,
                    ].join(' ').nullIfEmpty ??
                    local['professions'],
                onTap: _saving ? null : _chooseProfessions,
                onRemove: _saving ? null : (index) => setState(() => _professions = [..._professions]..removeAt(index)),
              ),
              const SizedBox(height: KapdhSpace.s5),
              _TagPickerField(
                key: const ValueKey('profile-skills'),
                pickerKey: const ValueKey('profile-skills-picker'),
                label: 'Keahlian',
                kind: 'keahlian',
                tags: [
                  for (final skill in _skills) skill.active == false ? '${skill.label} (tidak aktif)' : skill.label,
                ],
                placeholder: _skills.isEmpty ? 'Pilih keahlian' : '${_skills.length} dari $maxSkills dipilih',
                helper: 'Bidang yang Anda kuasai (maksimal $maxSkills), agar alumni lain mudah menemukan Anda.',
                errorText: fieldError('skill_ids'),
                onTap: _saving ? null : _chooseSkills,
                onRemove: _saving ? null : (index) => setState(() => _skills = [..._skills]..removeAt(index)),
              ),
            ],
          ),
        ),
        const SizedBox(height: KapdhSpace.s5),
        AccountFormCard(
          icon: KapdhIcons.schoolOutlined,
          title: 'Riwayat Pendidikan',
          description: 'Pendidikan setelah pondok: universitas/instansi, jenjang, jurusan, tahun tamat.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (fieldError('education') case final message?) _ListError(message: message),
              if (_educationLocked) const _LockedListNote(),
              for (final (index, draft) in _education.indexed) ...[
                if (index > 0) const SizedBox(height: KapdhSpace.s3),
                _EducationItem(
                  key: ValueKey('profile-education-${draft.id}'),
                  number: index + 1,
                  draft: draft,
                  currentYear: currentYear,
                  enabled: !_saving && !_educationLocked,
                  errorOf: (name) {
                    if (_rowErrors[draft.id]?[name] case final message?) return message;
                    final sent = _sentIndexOf(_education, draft, (d) => d.blank);
                    return sent == null ? null : local['education.$sent.$name'];
                  },
                  onChanged: () => setState(() {}),
                  onRemove: () => _removeEducation(draft),
                ),
              ],
              if (_education.length < maxEducationEntries && !_educationLocked)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    key: const ValueKey('profile-education-add'),
                    onPressed: _saving ? null : _addEducation,
                    icon: const Icon(KapdhIcons.add),
                    label: const Text('Tambah Riwayat'),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: KapdhSpace.s5),
        AccountFormCard(
          icon: KapdhIcons.share,
          title: 'Media Sosial',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (fieldError('social_links') case final message?) _ListError(message: message),
              if (_linksLocked) const _LockedListNote(),
              for (final (index, draft) in _links.indexed) ...[
                if (index > 0) ...[
                  const SizedBox(height: KapdhSpace.s4),
                  Divider(height: 1, color: context.kc.divider),
                  const SizedBox(height: KapdhSpace.s4),
                ],
                _SocialItem(
                  key: ValueKey('profile-link-${draft.id}'),
                  number: index + 1,
                  draft: draft,
                  enabled: !_saving && !_linksLocked,
                  errorText:
                      _rowErrors[draft.id]?['value'] ??
                      _rowErrors[draft.id]?['platform'] ??
                      switch (_sentIndexOf(_links, draft, (d) => d.blank)) {
                        final sent? => local['social_links.$sent.value'],
                        null => null,
                      },
                  onChanged: () => setState(() {}),
                  onRemove: () => _removeLink(draft),
                ),
              ],
              Padding(
                padding: EdgeInsets.only(top: _links.isEmpty ? 0 : KapdhSpace.s3),
                child: Text(
                  'Tempel tautan atau ketik nama pengguna, mis. @kapdh. Maksimal $maxSocialLinks tautan. '
                  'Disembunyikan dari anggota lain kecuali diizinkan di Privasi.',
                  style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.45, color: context.kc.textMuted),
                ),
              ),
              if (_links.length < maxSocialLinks && !_linksLocked)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    key: const ValueKey('profile-link-add'),
                    onPressed: _saving ? null : _addLink,
                    icon: const Icon(KapdhIcons.add),
                    label: const Text('Tambah tautan'),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: KapdhSpace.s6),
        KapdhButton(
          key: const ValueKey('profile-save'),
          label: 'Simpan profil',
          busyLabel: 'Menyimpan...',
          busy: _saving,
          onPressed: _dirty ? _save : null,
        ),
      ],
    );
  }
}

extension on String {
  String? get nullIfEmpty => isEmpty ? null : this;
}

/// Keterangan daftar terkunci: memuat isian dari versi aplikasi yang lebih baru.
class _LockedListNote extends StatelessWidget {
  const _LockedListNote();

  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.only(bottom: KapdhSpace.s3),
    child: InfoBox(
      message: 'Bagian ini memuat isian dari versi aplikasi yang lebih baru. Perbarui aplikasi untuk mengubahnya.',
    ),
  );
}

class _ListError extends StatelessWidget {
  const _ListError({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: KapdhSpace.s3),
    child: Text(
      message,
      style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.danger),
    ),
  );
}

/// Tombol hapus baris daftar berulang (Pendidikan, tautan): ikon tempat sampah merah, target 48 (v2: satu makna satu
/// warna di kedua daftar).
class _RemoveButton extends StatelessWidget {
  const _RemoveButton({super.key, required this.tooltip, required this.onPressed});

  final String tooltip;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: tooltip,
    color: context.kc.danger,
    icon: const Icon(KapdhIcons.deleteOutline, size: KapdhIconSize.md),
    onPressed: onPressed,
  );
}

/// "Pendidikan n" (v2): kotak latar bergaris dengan judul dan tombol hapus merah, Universitas/Instansi, Jurusan/Program
/// Studi, Strata (D3/S1/S2/S3/Lainnya) dan Tahun Tamat (helper "Tahun ijazah terbit.").
class _EducationItem extends StatelessWidget {
  const _EducationItem({
    super.key,
    required this.number,
    required this.draft,
    required this.currentYear,
    required this.enabled,
    required this.errorOf,
    required this.onChanged,
    required this.onRemove,
  });

  final int number;
  final _EducationDraft draft;

  /// Tahun tamat terakhir yang dapat dipilih (server menolak tahun setelah tahun berjalan WIB).
  final int currentYear;
  final bool enabled;
  final String? Function(String field) errorOf;
  final VoidCallback onChanged;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final p = context.kc;
    final year = draft.year;
    return Semantics(
      container: true,
      label: 'Pendidikan $number',
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: p.background,
          border: Border.all(color: p.cardBorder),
          borderRadius: BorderRadius.circular(KapdhRadius.md),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s3, 0, KapdhSpace.s1, KapdhSpace.s3),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Pendidikan $number',
                        style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
                      ),
                    ),
                    _RemoveButton(
                      key: ValueKey('profile-education-remove-${draft.id}'),
                      tooltip: 'Hapus Pendidikan $number',
                      onPressed: enabled ? onRemove : null,
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(right: KapdhSpace.s2),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    KapdhTextField(
                      key: ValueKey('profile-education-institution-${draft.id}'),
                      label: 'Universitas/Instansi',
                      controller: draft.institution,
                      hint: 'Mis. Universitas Indonesia',
                      enabled: enabled,
                      inputFormatters: [LengthLimitingTextInputFormatter(120)],
                      errorText: errorOf('institution'),
                      onChanged: (_) => onChanged(),
                    ),
                    const SizedBox(height: KapdhSpace.s4),
                    KapdhTextField(
                      key: ValueKey('profile-education-major-${draft.id}'),
                      label: 'Jurusan/Program Studi',
                      controller: draft.major,
                      hint: 'Mis. Pendidikan Bahasa Arab',
                      enabled: enabled,
                      inputFormatters: [LengthLimitingTextInputFormatter(120)],
                      errorText: errorOf('major'),
                      onChanged: (_) => onChanged(),
                    ),
                    const SizedBox(height: KapdhSpace.s4),
                    KapdhDropdownField<EducationLevel?>(
                      key: ValueKey('profile-education-level-${draft.id}'),
                      label: 'Strata',
                      value: draft.level,
                      hint: 'Pilih strata',
                      errorText: errorOf('level'),
                      items: [
                        const DropdownMenuItem(value: null, child: Text('Tidak diisi')),
                        for (final level in educationLevelChoices)
                          DropdownMenuItem(value: level, child: Text(educationLevelLabel(level))),
                      ],
                      onChanged: enabled
                          ? (level) {
                              draft.level = level;
                              onChanged();
                            }
                          : null,
                    ),
                    const SizedBox(height: KapdhSpace.s4),
                    KapdhDropdownField<int?>(
                      key: ValueKey('profile-education-year-${draft.id}'),
                      label: 'Tahun Tamat',
                      value: year,
                      hint: 'Pilih tahun',
                      helperText: 'Tahun ijazah terbit.',
                      errorText: errorOf('graduation_year'),
                      items: [
                        const DropdownMenuItem(value: null, child: Text('Tidak diisi')),
                        // Tahun tersimpan di luar rentang (jam perangkat melenceng, data lama) tetap menjadi pilihan:
                        // nilai tanpa item tidak dapat ditampilkan dropdown.
                        if (year != null && year > currentYear) DropdownMenuItem(value: year, child: Text('$year')),
                        for (var choice = currentYear; choice >= _firstGraduationYear; choice--)
                          DropdownMenuItem(value: choice, child: Text('$choice')),
                        if (year != null && year < _firstGraduationYear)
                          DropdownMenuItem(value: year, child: Text('$year')),
                      ],
                      onChanged: enabled
                          ? (year) {
                              draft.year = year;
                              onChanged();
                            }
                          : null,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Satu tautan media sosial (v2): pemilih platform berlogo Phosphor (menu Instagram … Situs web) dan tombol hapus
/// merah, lalu field nama pengguna/tautan.
class _SocialItem extends StatelessWidget {
  const _SocialItem({
    super.key,
    required this.number,
    required this.draft,
    required this.enabled,
    required this.errorText,
    required this.onChanged,
    required this.onRemove,
  });

  final int number;
  final _SocialDraft draft;
  final bool enabled;
  final String? errorText;
  final VoidCallback onChanged;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final platform = draft.platform;
    return Semantics(
      container: true,
      label: 'Tautan $number',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: KapdhDropdownField<SocialPlatform>(
                  key: ValueKey('profile-link-platform-${draft.id}'),
                  label: 'Platform tautan $number',
                  labelVisible: false,
                  value: platform,
                  items: [
                    for (final choice in SocialPlatformUi.choices)
                      DropdownMenuItem(
                        value: choice,
                        child: Row(
                          children: [
                            Icon(choice.icon, size: KapdhIconSize.md),
                            const SizedBox(width: KapdhSpace.s3),
                            Flexible(child: Text(choice.label, overflow: TextOverflow.ellipsis)),
                          ],
                        ),
                      ),
                  ],
                  onChanged: enabled
                      ? (choice) {
                          if (choice == null) return;
                          draft.platform = choice;
                          onChanged();
                        }
                      : null,
                ),
              ),
              _RemoveButton(
                key: ValueKey('profile-link-remove-${draft.id}'),
                tooltip: 'Hapus tautan ${platform.label}',
                onPressed: enabled ? onRemove : null,
              ),
            ],
          ),
          const SizedBox(height: KapdhSpace.s2),
          Padding(
            padding: const EdgeInsets.only(right: KapdhSize.touchTargetMin),
            child: KapdhTextField(
              key: ValueKey('profile-link-value-${draft.id}'),
              label: 'Nama pengguna atau tautan ${platform.label}',
              labelVisible: false,
              controller: draft.value,
              hint: platform.hint,
              enabled: enabled,
              keyboardType: TextInputType.url,
              inputFormatters: [LengthLimitingTextInputFormatter(200)],
              errorText: errorText,
              onChanged: (_) => onChanged(),
            ),
          ),
        ],
      ),
    );
  }
}

class _ReadOnlyRow extends StatelessWidget {
  const _ReadOnlyRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return MergeSemantics(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Text(label, style: TextStyle(fontSize: 13, color: context.kc.textMuted)),
            ),
            const SizedBox(width: KapdhSpace.s3),
            Flexible(
              child: Text(
                value,
                textAlign: TextAlign.right,
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Field pilihan berlabel (Ubah Profil v2): label, cip terpilih bernada tint yang seluruhnya menghapus (pil 36 dalam
/// target 48), pemilih bergaya field ("Pilih atau tambah…") yang membuka lembar pilihan, helper dan galat.
class _TagPickerField extends StatelessWidget {
  const _TagPickerField({
    super.key,
    required this.label,
    required this.kind,
    required this.tags,
    required this.placeholder,
    required this.onTap,
    required this.onRemove,
    this.pickerKey,
    this.helper,
    this.errorText,
  });

  /// Kunci kotak pemilih (uji mengetuk pemilihnya, bukan tengah seluruh field yang dapat jatuh di helper).
  final Key? pickerKey;
  final String label;

  /// "profesi" / "keahlian" untuk label pembaca layar ("Hapus keahlian Bahasa Arab").
  final String kind;
  final List<String> tags;
  final String placeholder;
  final String? helper;
  final VoidCallback? onTap;
  final ValueChanged<int>? onRemove;
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    final p = context.kc;
    final error = errorText;
    // Material bening lokal: dekorasi Ink dan riak InkWell dilukis di sini, di atas latar
    // AccountFormCard (Container berwarna), bukan di Material Scaffold di bawahnya.
    // textStyle meneruskan gaya teks induk agar tampilan teks tidak berubah.
    return Material(
      type: MaterialType.transparency,
      textStyle: DefaultTextStyle.of(context).style,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ExcludeSemantics(
            child: Text(
              label,
              style: const TextStyle(fontSize: KapdhFontSize.label, fontWeight: FontWeight.w500),
            ),
          ),
          if (tags.isNotEmpty) ...[
            const SizedBox(height: KapdhSpace.s1),
            Wrap(
              spacing: KapdhSpace.s2,
              children: [
                for (final (index, tag) in tags.indexed)
                  Semantics(
                    button: true,
                    label: 'Hapus $kind $tag',
                    excludeSemantics: true,
                    onTap: onRemove == null ? null : () => onRemove!(index),
                    child: InkWell(
                      onTap: onRemove == null ? null : () => onRemove!(index),
                      borderRadius: BorderRadius.circular(KapdhRadius.pill),
                      child: Padding(
                        // Pil 36 dalam area ketuk 48.
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        // Ink (bukan Container) agar riak tekan & sorotan fokus tidak tertutup warna pil.
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(minHeight: 36),
                          child: Ink(
                            padding: const EdgeInsets.fromLTRB(KapdhSpace.s4, 6, KapdhSpace.s3, 6),
                            decoration: BoxDecoration(
                              color: p.tint,
                              borderRadius: BorderRadius.circular(KapdhRadius.pill),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Flexible(
                                  child: Text(
                                    tag,
                                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: p.primary),
                                  ),
                                ),
                                const SizedBox(width: KapdhSpace.s2),
                                Icon(KapdhIcons.close, size: KapdhIconSize.sm, color: p.primary),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ],
          const SizedBox(height: KapdhSpace.s1),
          Semantics(
            button: true,
            label: '$label, $placeholder',
            excludeSemantics: true,
            child: InkWell(
              key: pickerKey,
              onTap: onTap,
              borderRadius: BorderRadius.circular(KapdhRadius.md),
              // Ink (bukan Container) agar riak tekan & sorotan fokus tidak tertutup warna kotak pemilih.
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: KapdhSize.inputHeight),
                child: Ink(
                  padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s3),
                  decoration: BoxDecoration(
                    color: p.surface,
                    border: Border.all(color: error != null ? p.danger : p.border),
                    borderRadius: BorderRadius.circular(KapdhRadius.md),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          placeholder,
                          style: TextStyle(fontSize: KapdhFontSize.body, color: p.textMuted),
                        ),
                      ),
                      Icon(KapdhIcons.keyboardArrowDown, color: onTap == null ? p.textMuted : p.text),
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (helper != null && error == null) ...[
            const SizedBox(height: KapdhSpace.s2),
            Text(
              helper!,
              style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.45, color: p.textMuted),
            ),
          ],
          if (error != null) ...[
            const SizedBox(height: KapdhSpace.s1),
            Text(
              error,
              style: TextStyle(fontSize: KapdhFontSize.caption, color: p.danger),
            ),
          ],
        ],
      ),
    );
  }
}
