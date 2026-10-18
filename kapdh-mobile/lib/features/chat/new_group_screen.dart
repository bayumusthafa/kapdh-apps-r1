import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/error_presenter.dart';
import '../../core/ui/app_keys.dart';
import '../../design/design.dart';
import '../network/widgets/alumni_avatar.dart';
import 'chat_image_picker.dart';
import 'chat_list_controller.dart';
import 'chat_repository.dart';
import 'member_picker.dart';
import 'outgoing_message.dart';

/// Kapasitas grup termasuk pembuat (v3.2: 100 anggota; undangan tertunda ikut dihitung).
const int maxGroupMembers = 100;

/// Panjang maksimum nama grup (chat.yaml ChatGroupCreateRequest.name).
const int maxGroupNameChars = 80;

/// Label alasan undangan dilewati (chat.yaml ChatInviteSkipReason); not_invitable sengaja tidak dirinci (N-09).
String inviteSkipLabel(ChatInviteSkipReason reason) => switch (reason) {
  ChatInviteSkipReason.alreadyMember => 'sudah menjadi anggota',
  ChatInviteSkipReason.alreadyInvited => 'sudah diundang',
  ChatInviteSkipReason.roomFull => 'grup sudah penuh ($maxGroupMembers anggota)',
  _ => 'tidak dapat diundang',
};

/// Ringkasan undangan yang dilewati (nama dari pilihan pengguna bila ada).
String inviteSkipSummary(List<ChatInviteSkip> skipped, Map<String, String> names) =>
    [for (final skip in skipped) '${names[skip.userId] ?? 'Alumni'}: ${inviteSkipLabel(skip.reason)}'].join('\n');

/// Grup Baru (F-11, PRD 3.11): nama, foto opsional dan calon anggota. Pembuat menjadi admin; calon anggota menerima
/// undangan dan harus menerimanya sendiri (tidak dipaksa masuk).
class NewGroupScreen extends ConsumerStatefulWidget {
  const NewGroupScreen({super.key});

  @override
  ConsumerState<NewGroupScreen> createState() => _NewGroupScreenState();
}

class _NewGroupScreenState extends ConsumerState<NewGroupScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  List<DirectoryMember> _invitees = const [];
  OutgoingImage? _avatar;
  String? _uploadedAvatarId;
  String? _nameError;
  bool _busy = false;

  /// Grup sudah dibuat: formulir terkunci agar ketukan ulang tidak membuat grup kedua.
  bool _created = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _pickAvatar() async {
    try {
      final image = await ref.read(chatImagePickerProvider)(ChatImageSource.gallery);
      if (image == null || !mounted) return;
      setState(() {
        _avatar = image;
        _uploadedAvatarId = null;
      });
    } on ChatImageException catch (error) {
      _snack(error.message);
    } on PlatformException {
      _snack('Foto tidak dapat dibuka. Periksa izin galeri di pengaturan perangkat.');
    }
  }

  Future<void> _pickInvitees() async {
    final picked = await showMemberPicker(
      context,
      title: 'Undang alumni',
      maxSelection: maxGroupMembers - 1,
      initial: _invitees,
    );
    if (picked != null && mounted) setState(() => _invitees = picked);
  }

  void _remove(DirectoryMember member) =>
      setState(() => _invitees = _invitees.where((m) => m.userId != member.userId).toList());

  void _snack(String message) {
    ref.read(scaffoldMessengerKeyProvider).currentState
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  String? _validateName(String? value) {
    final trimmed = value?.trim() ?? '';
    if (trimmed.isEmpty) return 'Nama grup wajib diisi.';
    if (trimmed.runes.length > maxGroupNameChars) return 'Nama grup maksimal $maxGroupNameChars karakter.';
    return null;
  }

  Future<void> _create() async {
    setState(() => _nameError = null);
    if (_busy || _created || !(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    final repo = ref.read(chatRepositoryProvider);
    try {
      final avatar = _avatar;
      if (avatar != null && _uploadedAvatarId == null) {
        final file = await repo.uploadChatImage(avatar.bytes, filename: avatar.filename, mime: avatar.mime);
        _uploadedAvatarId = file.id;
      }
      final created = await repo.createGroup(
        ChatGroupCreateRequest(
          name: _name.text.trim(),
          avatarFileId: _uploadedAvatarId == null ? const Optional.absent() : Optional(_uploadedAvatarId),
          inviteeUserIds: _invitees.isEmpty ? null : [for (final m in _invitees) m.userId],
        ),
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _created = true;
      });
      ref.read(chatListRefreshProvider.notifier).request();
      final skipped = created.invitations.skipped;
      if (skipped.isNotEmpty) {
        await showDialog<void>(
          context: context,
          useRootNavigator: true,
          builder: (dialogContext) => AlertDialog(
            title: const Text('Sebagian undangan tidak terkirim'),
            content: Text(inviteSkipSummary(skipped, {for (final m in _invitees) m.userId: m.fullName})),
            actions: [TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Tutup'))],
          ),
        );
        if (!mounted) return;
      } else if (created.invitations.invitedUserIds.isNotEmpty) {
        _snack('Grup dibuat. ${created.invitations.invitedUserIds.length} undangan terkirim.');
      }
      context.pushReplacement(AppRoutes.chat(created.room.id));
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _busy = false);
      final nameErrors = error.error?.fieldErrors?['name'];
      if (nameErrors != null && nameErrors.isNotEmpty) {
        setState(() => _nameError = nameErrors.join(' '));
        return;
      }
      await ref.read(errorPresenterProvider).present(error, onRetry: _create);
    }
  }

  @override
  Widget build(BuildContext context) {
    final avatar = _avatar;
    return AppScaffold(
      title: 'Grup Baru',
      fallbackLocation: AppRoutes.network,
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(KapdhSpace.s5),
          children: [
            Center(
              child: Semantics(
                button: true,
                label: avatar == null ? 'Pilih foto grup' : 'Ganti foto grup',
                excludeSemantics: true,
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: _busy ? null : _pickAvatar,
                  child: avatar == null
                      ? const AlumniAvatar(name: 'Grup', size: 88, icon: KapdhIcons.addAPhotoOutlined)
                      : ClipOval(
                          child: Image.memory(
                            avatar.bytes,
                            width: 88,
                            height: 88,
                            fit: BoxFit.cover,
                            errorBuilder: (_, _, _) =>
                                const AlumniAvatar(name: 'Grup', size: 88, icon: KapdhIcons.brokenImageOutlined),
                          ),
                        ),
                ),
              ),
            ),
            const SizedBox(height: KapdhSpace.s1),
            const Center(
              child: Text(
                'Foto grup (opsional)',
                style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
              ),
            ),
            const SizedBox(height: KapdhSpace.s5),
            KapdhTextField(
              label: 'Nama grup',
              controller: _name,
              hint: 'Contoh: Angkatan 29',
              requiredMark: true,
              errorText: _nameError,
              validator: _validateName,
              textCapitalization: TextCapitalization.sentences,
              inputFormatters: [LengthLimitingTextInputFormatter(maxGroupNameChars)],
            ),
            const SizedBox(height: KapdhSpace.s5),
            SectionHeader(
              title: 'Undang alumni (${_invitees.length})',
              actionLabel: 'Pilih alumni',
              onAction: _busy ? null : _pickInvitees,
            ),
            if (_invitees.isEmpty)
              const Text(
                'Belum ada alumni yang dipilih. Anda juga dapat mengundang setelah grup dibuat.',
                style: TextStyle(color: KapdhColors.textMuted),
              )
            else
              Wrap(
                spacing: KapdhSpace.s2,
                runSpacing: KapdhSpace.s1,
                children: [
                  for (final member in _invitees)
                    InputChip(
                      label: Text(member.fullName),
                      deleteButtonTooltipMessage: 'Hapus ${member.fullName}',
                      onDeleted: _busy ? null : () => _remove(member),
                      // Seluruh chip menghapus undangan (area ketuk 48 dp), bukan hanya ikon silang.
                      onPressed: _busy ? null : () => _remove(member),
                    ),
                ],
              ),
            const SizedBox(height: KapdhSpace.s4),
            const InfoBox(
              message:
                  'Alumni yang diundang bergabung setelah menerima undangan. Anggota baru hanya melihat pesan sejak '
                  'bergabung. Grup maksimal 100 anggota termasuk Anda.',
            ),
            const SizedBox(height: KapdhSpace.s6),
            KapdhButton(
              label: 'Buat grup',
              icon: KapdhIcons.groupAdd,
              busy: _busy,
              busyLabel: 'Membuat grup',
              onPressed: _busy || _created ? null : _create,
            ),
          ],
        ),
      ),
    );
  }
}
