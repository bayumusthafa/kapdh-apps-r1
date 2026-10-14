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
import '../network/moderation_actions.dart';
import '../network/report_sheet.dart';
import '../network/widgets/alumni_avatar.dart';
import 'chat_image_picker.dart';
import 'chat_info_controller.dart';
import 'chat_repository.dart';
import 'member_picker.dart';
import 'new_group_screen.dart';

/// Info Percakapan (F-11, F-12): untuk room direct lihat profil, bisukan, blokir dan laporkan; untuk grup anggota,
/// undangan tertunda (admin), ubah nama/foto, kelola peran, keluarkan anggota, undang, bisukan, laporkan dan keluar
/// grup (admin terakhir menunjuk pengganti, AC F11-5).
class ChatInfoScreen extends ConsumerStatefulWidget {
  const ChatInfoScreen({super.key, required this.roomId});

  /// Parameter rute `roomId`.
  final String roomId;

  @override
  ConsumerState<ChatInfoScreen> createState() => _ChatInfoScreenState();
}

enum _MemberAction { profile, promote, demote, remove }

class _ChatInfoScreenState extends ConsumerState<ChatInfoScreen> {
  bool _busy = false;

  ChatInfoController get _controller => ref.read(chatInfoProvider(widget.roomId).notifier);

  void _snack(String message) {
    ref.read(scaffoldMessengerKeyProvider).currentState
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<bool> _run(Future<void> Function() action, {VoidCallback? onReload}) async {
    setState(() => _busy = true);
    try {
      await action();
      return true;
    } on ApiException catch (error) {
      if (!mounted) return false;
      await ref
          .read(errorPresenterProvider)
          .present(error, onReload: onReload ?? () => _controller.load(), onRetry: () => _run(action));
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<bool> _confirm(String title, String message, String action) async {
    final result = await showDialog<bool>(
      context: context,
      useRootNavigator: true,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Batal')),
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: Text(action)),
        ],
      ),
    );
    return result ?? false;
  }

  Future<void> _rename(ChatRoom room) async {
    final name = await showDialog<String>(
      context: context,
      useRootNavigator: true,
      builder: (_) => _RenameGroupDialog(initial: room.name ?? room.title),
    );
    if (name == null || !mounted) return;
    if (name.isEmpty) {
      _snack('Nama grup wajib diisi.');
      return;
    }
    if (await _run(() => _controller.updateGroup(ChatRoomUpdate(name: name)))) _snack('Nama grup diperbarui.');
  }

  Future<void> _changePhoto() async {
    try {
      final image = await ref.read(chatImagePickerProvider)(ChatImageSource.gallery);
      if (image == null || !mounted) return;
      await _run(() async {
        final file = await ref
            .read(chatRepositoryProvider)
            .uploadChatImage(image.bytes, filename: image.filename, mime: image.mime);
        await _controller.updateGroup(ChatRoomUpdate(avatarFileId: Optional(file.id)));
      });
    } on ChatImageException catch (error) {
      _snack(error.message);
    } on PlatformException {
      _snack('Foto tidak dapat dibuka. Periksa izin galeri di pengaturan perangkat.');
    }
  }

  /// Penghapusan foto grup dikonfirmasi dulu (PRD 4.5).
  Future<void> _removePhoto() async {
    if (!await _confirm(
      'Hapus foto grup?',
      'Foto grup dihapus untuk semua anggota dan diganti ikon grup.',
      'Hapus foto',
    )) {
      return;
    }
    if (await _run(() => _controller.updateGroup(const ChatRoomUpdate(avatarFileId: Optional(null))))) {
      _snack('Foto grup dihapus.');
    }
  }

  Future<void> _invite(ChatInfoState state) async {
    final room = state.room!;
    final exclude = {...state.joined.map((m) => m.userId), ...state.invited.map((m) => m.userId)};
    final capacity = maxGroupMembers - state.joined.length - state.invited.length;
    if (capacity <= 0) {
      _snack('Grup sudah penuh ($maxGroupMembers anggota termasuk undangan tertunda).');
      return;
    }
    final picked = await showMemberPicker(
      context,
      title: 'Undang ke ${room.title}',
      maxSelection: capacity < 50 ? capacity : 50,
      excludeUserIds: exclude,
    );
    if (picked == null || picked.isEmpty || !mounted) return;
    ChatInviteOutcome? outcome;
    await _run(() async => outcome = await _controller.invite([for (final m in picked) m.userId]));
    final result = outcome;
    if (result == null || !mounted) return;
    if (result.skipped.isEmpty) {
      _snack('${result.invitedUserIds.length} undangan terkirim.');
      return;
    }
    await showDialog<void>(
      context: context,
      useRootNavigator: true,
      builder: (dialogContext) => AlertDialog(
        title: Text('${result.invitedUserIds.length} undangan terkirim'),
        content: Text(inviteSkipSummary(result.skipped, {for (final m in picked) m.userId: m.fullName})),
        actions: [TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Tutup'))],
      ),
    );
  }

  Future<void> _memberAction(ChatRoomMember member, _MemberAction action) async {
    switch (action) {
      case _MemberAction.profile:
        await context.push(AppRoutes.member(member.userId));
      // Perubahan izin wajib dikonfirmasi (PRD 4.5).
      case _MemberAction.promote:
        if (!await _confirm(
          'Jadikan ${member.fullName} admin?',
          '${member.fullName} dapat mengubah nama dan foto grup, mengundang, mengeluarkan anggota dan mengatur admin.',
          'Jadikan admin',
        )) {
          return;
        }
        if (await _run(() => _controller.setRole(member.userId, ChatMemberRole.admin))) {
          _snack('${member.fullName} sekarang admin grup.');
        }
      case _MemberAction.demote:
        final self = member.isMe;
        if (!await _confirm(
          self ? 'Berhenti menjadi admin?' : 'Jadikan ${member.fullName} anggota biasa?',
          self
              ? 'Anda akan kehilangan hak admin: tidak dapat lagi mengubah grup, mengundang, mengeluarkan anggota atau '
                    'mengatur admin. Hak ini hanya dapat dikembalikan oleh admin lain.'
              : '${member.fullName} tidak lagi dapat mengubah grup, mengundang, mengeluarkan anggota atau mengatur admin.',
          self ? 'Berhenti jadi admin' : 'Jadikan anggota biasa',
        )) {
          return;
        }
        if (await _run(() => _controller.setRole(member.userId, ChatMemberRole.member))) {
          _snack(self ? 'Anda sekarang anggota biasa.' : '${member.fullName} sekarang anggota biasa.');
        }
      case _MemberAction.remove:
        if (!await _confirm(
          'Keluarkan ${member.fullName}?',
          '${member.fullName} tidak lagi dapat membaca riwayat atau mengirim pesan di grup ini.',
          'Keluarkan',
        )) {
          return;
        }
        if (await _run(() => _controller.remove(member.userId))) _snack('${member.fullName} dikeluarkan dari grup.');
    }
  }

  Future<void> _cancelInvitation(ChatRoomMember member) async {
    if (!await _confirm('Batalkan undangan?', 'Undangan untuk ${member.fullName} dibatalkan.', 'Batalkan undangan')) {
      return;
    }
    if (await _run(() => _controller.remove(member.userId))) _snack('Undangan dibatalkan.');
  }

  /// Memilih admin pengganti saat admin terakhir keluar (AC F11-5).
  Future<String?> _pickSuccessor(List<ChatRoomMember> candidates) => showDialog<String>(
    context: context,
    useRootNavigator: true,
    builder: (dialogContext) {
      String? selected;
      return StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Pilih admin pengganti'),
          content: SizedBox(
            width: double.maxFinite,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Anda admin terakhir. Tunjuk anggota lain sebagai admin sebelum keluar dari grup.'),
                const SizedBox(height: KapdhSpace.s2),
                Flexible(
                  child: RadioGroup<String>(
                    groupValue: selected,
                    onChanged: (value) => setDialogState(() => selected = value),
                    child: ListView(
                      shrinkWrap: true,
                      children: [
                        for (final member in candidates)
                          RadioListTile<String>(
                            value: member.userId,
                            contentPadding: EdgeInsets.zero,
                            title: Text(member.fullName),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Batal')),
            TextButton(
              onPressed: selected == null ? null : () => Navigator.of(dialogContext).pop(selected),
              child: const Text('Keluar grup'),
            ),
          ],
        ),
      );
    },
  );

  Future<void> _leave(ChatInfoState state) async {
    String? successor;
    if (state.mustChooseSuccessor) {
      successor = await _pickSuccessor(state.others);
      if (successor == null || !mounted) return;
    } else {
      final last = state.others.isEmpty;
      if (!await _confirm(
        'Keluar dari grup?',
        last
            ? 'Anda anggota terakhir. Grup akan ditutup dan undangan tertunda dibatalkan.'
            : 'Anda tidak lagi menerima pesan dan riwayat grup tidak dapat dibuka lagi.',
        'Keluar',
      )) {
        return;
      }
    }
    setState(() => _busy = true);
    try {
      await _controller.leave(successorUserId: successor);
      if (!mounted) return;
      _snack('Anda keluar dari grup.');
      context.go(AppRoutes.network);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _busy = false);
      final needsSuccessor = error.error?.fieldErrors?.containsKey('successor_user_id') ?? false;
      if (needsSuccessor) {
        // Daftar admin berubah sejak dimuat: muat ulang lalu minta pengganti (AC F11-5).
        await _controller.load();
        final fresh = ref.read(chatInfoProvider(widget.roomId));
        if (!mounted) return;
        final picked = await _pickSuccessor(fresh.others);
        if (picked == null || !mounted) return;
        await _run(() async {
          await _controller.leave(successorUserId: picked);
          if (mounted) context.go(AppRoutes.network);
        });
        return;
      }
      await ref.read(errorPresenterProvider).present(error, onRetry: () => _leave(state));
    }
  }

  Future<void> _toggleBlock(ChatRoom room) async {
    final peer = room.peer;
    if (peer == null) return;
    final blocked = room.sendRestriction == ChatSendRestriction.blocked;
    final done = blocked
        ? await unblockWithConfirmation(context, ref, userId: peer.userId, name: peer.fullName)
        : await blockWithConfirmation(context, ref, userId: peer.userId, name: peer.fullName);
    if (done) await _controller.load();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(chatInfoProvider(widget.roomId));
    if (state.gone) {
      return AppScaffold(
        title: 'Info Percakapan',
        fallbackLocation: AppRoutes.network,
        body: EmptyState(
          icon: Icons.speaker_notes_off_outlined,
          title: 'Percakapan tidak tersedia',
          message: 'Anda bukan lagi anggota percakapan ini.',
          actionLabel: 'Ke Jejaring',
          onAction: () => context.go(AppRoutes.network),
        ),
      );
    }
    final room = state.room;
    if (room == null) {
      return AppScaffold(
        title: 'Info Percakapan',
        fallbackLocation: AppRoutes.chat(widget.roomId),
        body: state.error == null
            ? const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat info percakapan')
            : ErrorState.fromException(state.error!, onRetry: _controller.load),
      );
    }
    final group = room.kind == ChatRoomKind.group;
    final closed = room.closedAt != null;
    final peer = room.peer;

    final children = <Widget>[
      Center(
        child: AlumniAvatar(
          name: room.title,
          url: room.avatarUrl,
          size: 88,
          icon: group && room.avatarUrl == null ? Icons.groups : null,
        ),
      ),
      const SizedBox(height: KapdhSpace.s3),
      Semantics(
        header: true,
        child: Text(
          room.title,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w700),
        ),
      ),
      Text(
        group ? 'Grup · ${room.memberCount} anggota' : 'Percakapan langsung',
        textAlign: TextAlign.center,
        style: const TextStyle(color: KapdhColors.textMuted),
      ),
      if (group && room.canManage) ...[
        const SizedBox(height: KapdhSpace.s2),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: KapdhSpace.s2,
          children: [
            TextButton.icon(
              onPressed: _busy ? null : () => _rename(room),
              icon: const Icon(Icons.edit_outlined),
              label: const Text('Ubah nama'),
            ),
            TextButton.icon(
              onPressed: _busy ? null : _changePhoto,
              icon: const Icon(Icons.photo_camera_outlined),
              label: const Text('Ubah foto'),
            ),
            if (room.avatarFileId != null)
              TextButton.icon(
                onPressed: _busy ? null : _removePhoto,
                icon: const Icon(Icons.hide_image_outlined),
                label: const Text('Hapus foto'),
              ),
          ],
        ),
      ],
      if (closed) ...[
        const SizedBox(height: KapdhSpace.s3),
        const InfoBox(
          tone: InfoBoxTone.warning,
          icon: Icons.lock_outline,
          message: 'Grup ini sudah ditutup. Riwayat tetap dapat dibaca.',
        ),
      ],
      const SizedBox(height: KapdhSpace.s4),
      if (state.error != null)
        Padding(
          padding: const EdgeInsets.only(bottom: KapdhSpace.s3),
          child: InfoBox(
            tone: InfoBoxTone.warning,
            message: 'Data terbaru belum dapat dimuat. ${state.error!.message}',
            trailing: TextButton(onPressed: _controller.load, child: const Text('Coba lagi')),
          ),
        ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        value: room.muted,
        onChanged: _busy ? null : (value) => _run(() => _controller.setMuted(value)),
        title: const Text('Bisukan notifikasi'),
        subtitle: const Text('Pesan tetap masuk; hanya notifikasi push yang ditahan.'),
      ),
      const Divider(),
    ];

    if (!group) {
      final blocked = room.sendRestriction == ChatSendRestriction.blocked;
      children.addAll([
        if (peer != null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.person_outline),
            title: const Text('Lihat profil'),
            onTap: () => context.push(AppRoutes.member(peer.userId)),
          ),
        if (peer != null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.block),
            title: Text(blocked ? 'Buka blokir ${peer.fullName}' : 'Blokir ${peer.fullName}'),
            onTap: _busy ? null : () => _toggleBlock(room),
          ),
        if (peer != null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.flag_outlined),
            title: const Text('Laporkan pengguna'),
            onTap: () => showReportSheet(context, UserReportTarget(userId: peer.userId, name: peer.fullName)),
          ),
      ]);
    } else {
      children.addAll([
        SectionHeader(
          title: 'Anggota (${state.joined.length})',
          actionLabel: room.canManage && !closed ? 'Undang' : null,
          onAction: room.canManage && !closed && !_busy ? () => _invite(state) : null,
        ),
        for (final member in state.joined) _memberTile(member, room),
        if (room.canManage && state.invited.isNotEmpty) ...[
          const SizedBox(height: KapdhSpace.s3),
          SectionHeader(title: 'Undangan tertunda (${state.invited.length})'),
          for (final member in state.invited)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: AlumniAvatar(name: member.fullName, url: member.avatarUrl, size: 40),
              title: Text(member.fullName),
              subtitle: const Text('Menunggu jawaban'),
              trailing: TextButton(
                onPressed: _busy ? null : () => _cancelInvitation(member),
                child: const Text('Batalkan'),
              ),
            ),
        ],
        const Divider(),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.flag_outlined),
          title: const Text('Laporkan grup'),
          onTap: () => showReportSheet(context, RoomReportTarget(roomId: room.id, name: room.title)),
        ),
        if (!closed)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.logout, color: KapdhColors.danger),
            title: const Text('Keluar grup', style: TextStyle(color: KapdhColors.danger)),
            onTap: _busy ? null : () => _leave(state),
          ),
      ]);
    }

    return AppScaffold(
      title: 'Info Percakapan',
      fallbackLocation: AppRoutes.chat(widget.roomId),
      body: RefreshIndicator(
        onRefresh: _controller.load,
        // Grup maksimal 100 anggota: seluruh baris dibangun sekaligus agar dapat dijangkau pembaca layar.
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(KapdhSpace.s5),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
        ),
      ),
    );
  }

  Widget _memberTile(ChatRoomMember member, ChatRoom room) {
    final admin = member.role == ChatMemberRole.admin;
    final actions = <PopupMenuEntry<_MemberAction>>[
      if (!member.isMe) const PopupMenuItem(value: _MemberAction.profile, child: Text('Lihat profil')),
      if (room.canManage && !member.isMe && !admin)
        const PopupMenuItem(value: _MemberAction.promote, child: Text('Jadikan admin')),
      if (room.canManage && admin)
        const PopupMenuItem(value: _MemberAction.demote, child: Text('Jadikan anggota biasa')),
      if (room.canManage && !member.isMe)
        const PopupMenuItem(value: _MemberAction.remove, child: Text('Keluarkan dari grup')),
    ];
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: AlumniAvatar(name: member.fullName, url: member.avatarUrl, size: 40),
      title: Text(member.isMe ? '${member.fullName} (Anda)' : member.fullName),
      subtitle: admin ? const Text('Admin grup') : null,
      trailing: actions.isEmpty
          ? null
          : PopupMenuButton<_MemberAction>(
              tooltip: 'Tindakan untuk ${member.fullName}',
              enabled: !_busy,
              onSelected: (action) => _memberAction(member, action),
              itemBuilder: (_) => actions,
            ),
    );
  }
}

/// Dialog ubah nama grup; pengendali teks dimiliki dialog sehingga dibuang setelah animasi tutup selesai.
class _RenameGroupDialog extends StatefulWidget {
  const _RenameGroupDialog({required this.initial});

  final String initial;

  @override
  State<_RenameGroupDialog> createState() => _RenameGroupDialogState();
}

class _RenameGroupDialogState extends State<_RenameGroupDialog> {
  late final TextEditingController _name = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Ubah nama grup'),
      content: TextField(
        controller: _name,
        autofocus: true,
        inputFormatters: [LengthLimitingTextInputFormatter(maxGroupNameChars)],
        decoration: const InputDecoration(hintText: 'Nama grup'),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Batal')),
        TextButton(onPressed: () => Navigator.of(context).pop(_name.text.trim()), child: const Text('Simpan')),
      ],
    );
  }
}
