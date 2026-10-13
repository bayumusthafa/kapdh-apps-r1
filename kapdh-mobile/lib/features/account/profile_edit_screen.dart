import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/error_presenter.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
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

  List<TextEditingController> get _controllers => [
    _city,
    _phone,
    _bio,
    _eduInstitution,
    _eduCity,
    _instagram,
    _x,
    _facebook,
    _linkedin,
  ];

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
    _city.text = p.city ?? '';
    _phone.text = p.phone ?? '';
    _bio.text = p.bio ?? '';
    _eduInstitution.text = p.lastEducationInstitution ?? '';
    _eduCity.text = p.lastEducationCity ?? '';
    _instagram.text = p.socialInstagram ?? '';
    _x.text = p.socialX ?? '';
    _facebook.text = p.socialFacebook ?? '';
    _linkedin.text = p.socialLinkedin ?? '';
    _profession = p.profession;
    _skills = p.skills;
    _newAvatar = null;
    _uploadedAvatarId = null;
    _removeAvatar = false;
    _fieldErrors = const {};
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
    if ((_norm(_eduInstitution.text)?.length ?? 0) > 120)
      errors['last_education_institution'] = 'Maksimal 120 karakter.';
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
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Ambil foto'),
              onTap: () => Navigator.of(sheetContext).pop(AvatarSource.camera),
            ),
            ListTile(
              key: const ValueKey('avatar-source-gallery'),
              leading: const Icon(Icons.photo_library_outlined),
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
      if (error.code == ErrorCode.versionConflict) {
        await _onConflict(error);
      } else if (error.fieldErrors.isNotEmpty) {
        setState(() => _fieldErrors = error.fieldErrors);
        _snack(error.message);
      } else {
        if (error.code == ErrorCode.fileInvalid) setState(() => _uploadedAvatarId = null);
        await ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_save()));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// 409 VERSION_CONFLICT (AC F15-4, PRD 4.5): profil diubah di perangkat lain. Pengguna memilih memuat versi
  /// terbaru (isian dibuang) atau menerapkan isiannya di atas versi terbaru.
  Future<void> _onConflict(ApiException error) async {
    final current = error.current;
    final latest = current is Map<String, Object?> ? Me.fromJson(current) : await _repo.getMe();
    if (!mounted) return;
    final keepMine = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Profil diubah di perangkat lain'),
        content: const Text(
          'Profil Anda baru saja diubah dari perangkat lain. Muat versi terbaru, atau terapkan isian Anda di atas '
          'versi terbaru lalu simpan lagi.',
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
        _me = latest;
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
      String? helper,
      Iterable<String>? autofill,
    }) => Padding(
      padding: const EdgeInsets.only(bottom: KapdhSpace.s4),
      child: KapdhTextField(
        key: ValueKey('profile-$key'),
        label: label,
        controller: controller,
        hint: hint,
        prefixIcon: icon,
        keyboardType: keyboard,
        maxLines: maxLines,
        helperText: helper,
        autofillHints: autofill,
        errorText: fieldError(key),
        onChanged: (_) => setState(() {}),
      ),
    );

    return ListView(
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
                    icon: Icons.photo_camera_outlined,
                    onPressed: _saving ? null : _pickAvatar,
                  ),
                  if (_newAvatar != null || (profile.avatarFileId != null && !_removeAvatar))
                    KapdhLinkButton(
                      key: const ValueKey('avatar-delete'),
                      label: 'Hapus foto',
                      icon: Icons.delete_outline,
                      onPressed: _saving ? null : _removePhoto,
                    ),
                ],
              ),
              if (fieldError('avatar_file_id') case final message?)
                Text(
                  message,
                  style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.danger),
                ),
              const Text(
                'JPG, PNG atau WebP maksimal 5 MB. Data lokasi foto dihapus otomatis.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
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
          icon: Icons.location_on_outlined,
          helper: 'Hanya kota, bukan alamat lengkap. Tampil di KTA.',
        ),
        field(
          'phone',
          'Nomor telepon',
          _phone,
          hint: '+62 812 3456 7890',
          icon: Icons.phone_outlined,
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
          helper: '${_bio.text.trim().length}/500 karakter',
        ),
        const SizedBox(height: KapdhSpace.s2),
        _PickerField(
          key: const ValueKey('profile-profession'),
          label: 'Profesi',
          value: _profession == null
              ? null
              : _profession!.active == false
              ? '${_profession!.label} (tidak aktif)'
              : _profession!.label,
          placeholder: 'Pilih profesi',
          errorText: fieldError('profession_id'),
          onTap: _saving ? null : _chooseProfession,
        ),
        const SizedBox(height: KapdhSpace.s4),
        _PickerField(
          key: const ValueKey('profile-skills'),
          label: 'Keahlian (maksimal $maxSkills)',
          value: _skills.isEmpty ? null : '${_skills.length} keahlian dipilih',
          placeholder: 'Pilih keahlian',
          errorText: fieldError('skill_ids'),
          onTap: _saving ? null : _chooseSkills,
          chips: [for (final skill in _skills) skill.active == false ? '${skill.label} (tidak aktif)' : skill.label],
        ),
        const SizedBox(height: KapdhSpace.s5),
        AccountSection(
          title: 'LULUSAN TERAKHIR',
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(KapdhSpace.s4, KapdhSpace.s4, KapdhSpace.s4, 0),
              child: Column(
                children: [
                  field('last_education_institution', 'Institusi', _eduInstitution, hint: 'Mis. Universitas Indonesia'),
                  field('last_education_city', 'Kota', _eduCity, hint: 'Mis. Jakarta'),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: KapdhSpace.s5),
        AccountSection(
          title: 'MEDIA SOSIAL',
          footnote: 'Isi nama pengguna (mis. ahmad.islam) atau tautan https://. Disembunyikan kecuali diizinkan.',
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(KapdhSpace.s4, KapdhSpace.s4, KapdhSpace.s4, 0),
              child: Column(
                children: [
                  field(
                    'social_instagram',
                    'Instagram',
                    _instagram,
                    hint: 'nama pengguna',
                    icon: Icons.camera_alt_outlined,
                  ),
                  field('social_x', 'X', _x, hint: 'nama pengguna', icon: Icons.alternate_email),
                  field('social_facebook', 'Facebook', _facebook, hint: 'nama pengguna', icon: Icons.facebook),
                  field(
                    'social_linkedin',
                    'LinkedIn',
                    _linkedin,
                    hint: 'https://www.linkedin.com/in/...',
                    icon: Icons.work_outline,
                  ),
                ],
              ),
            ),
          ],
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
              child: Text(label, style: const TextStyle(fontSize: 13, color: KapdhColors.textMuted)),
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

/// Field pilihan master dengan label di atas (gaya KapdhTextField) dan cip pilihan (guideline hal. 7: profesi hijau,
/// keahlian biru).
class _PickerField extends StatelessWidget {
  const _PickerField({
    super.key,
    required this.label,
    required this.value,
    required this.placeholder,
    required this.onTap,
    this.errorText,
    this.chips = const [],
  });

  final String label;
  final String? value;
  final String placeholder;
  final VoidCallback? onTap;
  final String? errorText;
  final List<String> chips;

  @override
  Widget build(BuildContext context) {
    final error = errorText;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ExcludeSemantics(
          child: Text(
            label,
            style: const TextStyle(fontSize: KapdhFontSize.label, fontWeight: FontWeight.w500),
          ),
        ),
        const SizedBox(height: KapdhSpace.s2),
        Semantics(
          button: true,
          label: '$label, ${value ?? placeholder}',
          excludeSemantics: true,
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(KapdhRadius.md),
            child: Container(
              constraints: const BoxConstraints(minHeight: KapdhSize.inputHeight),
              padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s3),
              decoration: BoxDecoration(
                color: KapdhColors.surface,
                border: Border.all(color: error != null ? KapdhColors.danger : KapdhColors.border),
                borderRadius: BorderRadius.circular(KapdhRadius.md),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      value ?? placeholder,
                      style: TextStyle(
                        fontSize: KapdhFontSize.body,
                        color: value == null ? KapdhColors.textMuted : KapdhColors.text,
                      ),
                    ),
                  ),
                  const Icon(Icons.keyboard_arrow_down),
                ],
              ),
            ),
          ),
        ),
        if (chips.isNotEmpty) ...[
          const SizedBox(height: KapdhSpace.s2),
          Wrap(
            spacing: KapdhSpace.s2,
            runSpacing: KapdhSpace.s2,
            children: [
              for (final chip in chips)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s2, vertical: KapdhSpace.s1),
                  decoration: BoxDecoration(
                    color: KapdhColors.infoBg,
                    borderRadius: BorderRadius.circular(KapdhRadius.sm),
                  ),
                  child: Text(
                    chip,
                    style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.info),
                  ),
                ),
            ],
          ),
        ],
        if (error != null) ...[
          const SizedBox(height: KapdhSpace.s1),
          Text(
            error,
            style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.danger),
          ),
        ],
      ],
    );
  }
}
