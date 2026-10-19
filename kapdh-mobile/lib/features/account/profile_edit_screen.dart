import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_palette.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/error_presenter.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import 'widgets/scroll_column.dart';
import 'account_repository.dart';
import 'avatar_image.dart';
import 'widgets/account_section.dart';
import 'widgets/master_picker.dart';
import 'widgets/profile_avatar.dart';

/// Pola nomor telepon kontrak C2 (`ProfileUpdate.phone`).
final RegExp _phonePattern = RegExp(r'^\+?[0-9][0-9 -]{5,22}$');

/// Aturan tunggal tautan sosial kontrak C2 (`SocialHandle`): nama pengguna atau URL https; skema lain ditolak.
final RegExp _socialPattern = RegExp(
  r'''^(?:@?[A-Za-z0-9._-]{1,100}|https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[/?#][^\s<>"'`]*)?)$''',
);

/// Ubah profil sendiri (F-10, PRD 4.6; guideline hal. 7): foto, kota, telepon, tentang saya, lulusan terakhir,
/// media sosial, satu profesi dan maksimal 10 keahlian dari master terkontrol. Identitas keanggotaan (nama, jenis
/// kelamin, angkatan, kelas, email, nomor anggota) hanya ditampilkan; koreksinya oleh pengurus (PRD 3.5,
/// AC F05-6). Hanya field yang berubah dikirim lewat PATCH /me/profile dengan If-Match versi profil (AC F15-4);
/// isian tidak hilang saat jaringan gagal (PRD 4.5).
class ProfileEditScreen extends ConsumerStatefulWidget {
  const ProfileEditScreen({super.key});

  @override
  ConsumerState<ProfileEditScreen> createState() => _ProfileEditScreenState();
}

class _ProfileEditScreenState extends ConsumerState<ProfileEditScreen> {
  final _city = TextEditingController();
  final _phone = TextEditingController();
  final _bio = TextEditingController();
  final _eduInstitution = TextEditingController();
  final _eduCity = TextEditingController();
  final _instagram = TextEditingController();
  final _x = TextEditingController();
  final _facebook = TextEditingController();
  final _linkedin = TextEditingController();

  Me? _me;
  bool _loading = true;
  ApiException? _error;

  MasterItem? _profession;
  List<MasterItem> _skills = const [];
  PickedAvatar? _newAvatar;

  /// Berkas foto yang sudah terunggah untuk [_newAvatar]; dipakai ulang saat simpan diulang (kuota unggah N-10).
  String? _uploadedAvatarId;
  bool _removeAvatar = false;

  bool _saving = false;
  bool _submitted = false;
  Map<String, List<String>> _fieldErrors = const {};

  List<MasterItem>? _professionMasters;
  List<MasterItem>? _skillMasters;

  AccountRepository get _repo => ref.read(accountRepositoryProvider);

  /// Field teks formulir beserta nilainya di profil server: dipakai untuk mengisi formulir dan untuk mengenali
  /// isian yang benar-benar diubah pengguna saat konflik versi (AC F15-4).
  List<(TextEditingController, String? Function(Profile))> get _textFields => [
    (_city, (p) => p.city),
    (_phone, (p) => p.phone),
    (_bio, (p) => p.bio),
    (_eduInstitution, (p) => p.lastEducationInstitution),
    (_eduCity, (p) => p.lastEducationCity),
    (_instagram, (p) => p.socialInstagram),
    (_x, (p) => p.socialX),
    (_facebook, (p) => p.socialFacebook),
    (_linkedin, (p) => p.socialLinkedin),
  ];

  List<TextEditingController> get _controllers => [for (final (controller, _) in _textFields) controller];

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    for (final controller in _controllers) {
      controller.dispose();
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

  /// Mengisi formulir dari profil server (memuat pertama atau "muat versi terbaru").
  void _fill(Me me) {
    final p = me.profile;
    _me = me;
    for (final (controller, value) in _textFields) {
      controller.text = value(p) ?? '';
    }
    _profession = p.profession;
    _skills = p.skills;
    _newAvatar = null;
    _uploadedAvatarId = null;
    _removeAvatar = false;
    _fieldErrors = const {};
  }

  /// "Pakai isian saya" setelah 409 VERSION_CONFLICT (AC F15-4, PRD 4.5): hanya field yang benar-benar diubah
  /// pengguna terhadap versi yang ia buka diterapkan di atas [latest]. Field lain mengikuti versi terbaru, sehingga
  /// simpan berikutnya (If-Match versi terbaru) tidak menimpa perubahan dari perangkat lain.
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
    final professionEdited = _profession?.id != base.profession?.id;
    final profession = _profession;
    final skillsEdited = !_sameSkills(_skills, base.skills);
    final skills = _skills;
    final newAvatar = _newAvatar;
    final uploadedAvatarId = _uploadedAvatarId;
    final removeAvatar = _removeAvatar;

    _fill(latest);
    for (final (controller, text) in textEdits) {
      controller.text = text;
    }
    if (professionEdited) _profession = profession;
    if (skillsEdited) _skills = skills;
    _newAvatar = newAvatar;
    _uploadedAvatarId = uploadedAvatarId;
    _removeAvatar = removeAvatar;
  }

  static String? _norm(String value) {
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }

  static bool _sameSkills(List<MasterItem> a, List<MasterItem> b) {
    final left = {for (final s in a) s.id};
    final right = {for (final s in b) s.id};
    return left.length == right.length && left.containsAll(right);
  }

  /// Galat validasi lokal per field (kunci = nama field kontrak), sama dengan aturan server C2.
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
    if ((_norm(_eduInstitution.text)?.length ?? 0) > 120) {
      errors['last_education_institution'] = 'Maksimal 120 karakter.';
    }
    if ((_norm(_eduCity.text)?.length ?? 0) > 80) errors['last_education_city'] = 'Maksimal 80 karakter.';
    for (final (key, controller) in [
      ('social_instagram', _instagram),
      ('social_x', _x),
      ('social_facebook', _facebook),
      ('social_linkedin', _linkedin),
    ]) {
      final value = _norm(controller.text);
      if (value != null && (value.length > 200 || !_socialPattern.hasMatch(value))) {
        errors[key] = 'Isi nama pengguna atau tautan yang diawali https://';
      }
    }
    if (_skills.length > maxSkills) errors['skill_ids'] = 'Maksimal $maxSkills keahlian.';
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
      lastEducationInstitution: text(_eduInstitution.text, p.lastEducationInstitution),
      lastEducationCity: text(_eduCity.text, p.lastEducationCity),
      socialInstagram: text(_instagram.text, p.socialInstagram),
      socialX: text(_x.text, p.socialX),
      socialFacebook: text(_facebook.text, p.socialFacebook),
      socialLinkedin: text(_linkedin.text, p.socialLinkedin),
      professionId: _profession?.id == p.profession?.id ? const Optional.absent() : Optional(_profession?.id),
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

  Future<void> _chooseProfession() async {
    final choice = await showProfessionPicker(
      context,
      load: () async => _professionMasters ??= await _repo.listMasters(MasterKind.professions),
      selected: _profession,
    );
    if (choice != null && mounted) setState(() => _profession = choice.item);
  }

  Future<void> _chooseSkills() async {
    final skills = await showSkillsPicker(
      context,
      load: () async => _skillMasters ??= await _repo.listMasters(MasterKind.skills),
      selected: _skills,
    );
    if (skills != null && mounted) setState(() => _skills = skills);
  }

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
    try {
      var avatarId = _uploadedAvatarId;
      final picked = _newAvatar;
      if (picked != null && avatarId == null) {
        final file = await _repo.uploadAvatar(avatarMultipart(picked));
        avatarId = file.id;
        if (mounted) setState(() => _uploadedAvatarId = avatarId);
      }
      final update = _diff(me, avatarFileId: avatarId);
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
        setState(() => _fieldErrors = error.fieldErrors);
        _snack(error.message);
      } else {
        if (error.code == ErrorCode.fileInvalid) setState(() => _uploadedAvatarId = null);
        unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_save())));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
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
        // [v2] Tiga kartu berkepala ikon. Isiannya data profil yang ada sekarang (satu profesi, satu pendidikan, empat
        // media sosial tetap); isian berulang menunggu perubahan kontrak profil (REDESAIN.md).
        AccountFormCard(
          icon: KapdhIcons.workOutline,
          title: 'Profesi & Keahlian',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _TagPickerField(
                key: const ValueKey('profile-profession'),
                label: 'Profesi',
                kind: 'profesi',
                tags: [
                  if (_profession case final profession?)
                    profession.active == false ? '${profession.label} (tidak aktif)' : profession.label,
                ],
                placeholder: 'Pilih profesi',
                helper: 'Pekerjaan utama saat ini. Pilih dari daftar.',
                errorText: fieldError('profession_id'),
                onTap: _saving ? null : _chooseProfession,
                onRemove: _saving ? null : (_) => setState(() => _profession = null),
              ),
              const SizedBox(height: KapdhSpace.s5),
              _TagPickerField(
                key: const ValueKey('profile-skills'),
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
          description: 'Pendidikan terakhir setelah pondok: universitas/instansi dan kotanya.',
          child: Column(
            children: [
              field(
                'last_education_institution',
                'Universitas/Instansi',
                _eduInstitution,
                hint: 'Mis. Universitas Indonesia',
              ),
              field('last_education_city', 'Kota', _eduCity, hint: 'Mis. Jakarta', bottom: 0),
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
              field(
                'social_instagram',
                'Instagram',
                _instagram,
                hint: '@namapengguna atau tautan',
                icon: KapdhIcons.instagramLogo,
              ),
              field('social_x', 'X (Twitter)', _x, hint: '@namapengguna atau tautan', icon: KapdhIcons.xLogo),
              field(
                'social_facebook',
                'Facebook',
                _facebook,
                hint: 'nama pengguna atau tautan',
                icon: KapdhIcons.facebook,
              ),
              field(
                'social_linkedin',
                'LinkedIn',
                _linkedin,
                hint: 'https://www.linkedin.com/in/...',
                icon: KapdhIcons.linkedinLogo,
                bottom: KapdhSpace.s3,
              ),
              Text(
                'Tempel tautan atau ketik nama pengguna, mis. @kapdh. Disembunyikan dari anggota lain kecuali diizinkan '
                'di Privasi.',
                style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.45, color: context.kc.textMuted),
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

/// Field pilihan master (Ubah Profil v2): label, cip terpilih bernada tint yang seluruhnya menghapus (pil 36 dalam
/// target 48), pemilih bergaya field ("Pilih profesi") yang membuka lembar master, helper dan galat.
class _TagPickerField extends StatelessWidget {
  const _TagPickerField({
    super.key,
    required this.label,
    required this.kind,
    required this.tags,
    required this.placeholder,
    required this.onTap,
    required this.onRemove,
    this.helper,
    this.errorText,
  });

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
