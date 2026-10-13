import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../core/realtime/realtime_client.dart';
import '../../core/ui/app_keys.dart';
import '../../design/design.dart';
import '../network/moderation_actions.dart';
import '../network/report_sheet.dart';
import '../network/widgets/alumni_avatar.dart';
import 'chat_image_picker.dart';
import 'chat_list_controller.dart';
import 'chat_message_widgets.dart';
import 'chat_outbox.dart';
import 'chat_realtime.dart';
import 'chat_room_controller.dart';
import 'chat_timeline.dart';
import 'outgoing_message.dart';
import 'presence_heartbeat.dart';

/// Ambang penghitung karakter: penghitung tampil saat teks mendekati batas 4.000 (D5 v3.2).
const int composerCounterThreshold = 3800;

/// Pesan konteks laporan: maksimal 5 pesan bukan sistem tepat sebelum pesan yang dilaporkan, di room yang sama
/// (moderation.yaml `context_message_ids`).
List<String> reportContextIds(ChatTimeline timeline, String messageId) {
  final index = timeline.indexOf(messageId);
  if (index <= 0) return const [];
  final before = timeline.messages.sublist(0, index).where((m) => m.kind != ChatMessageKind.system).toList();
  return before.sublist(before.length > 5 ? before.length - 5 : 0).map((m) => m.id).toList();
}

/// Percakapan (F-11; AC F11-2, F11-3, F11-4, F11-6; N-02): riwayat keyset, kirim teks/gambar dengan status
/// mengirim/gagal/kirim ulang, balasan, reaksi, status terbaca, indikator mengetik, sinkron setelah reconnect, dan
/// ajakan perpanjang saat keanggotaan berakhir.
class ChatRoomScreen extends ConsumerStatefulWidget {
  const ChatRoomScreen({super.key, required this.roomId});

  /// Parameter rute `roomId`.
  final String roomId;

  @override
  ConsumerState<ChatRoomScreen> createState() => _ChatRoomScreenState();
}

sealed class _Item {
  const _Item();
}

final class _DateItem extends _Item {
  const _DateItem(this.label);
  final String label;
}

final class _ServerItem extends _Item {
  const _ServerItem(this.message);
  final ChatMessage message;
}

final class _OutgoingItem extends _Item {
  const _OutgoingItem(this.entry);
  final OutgoingMessage entry;
}

class _ChatRoomScreenState extends ConsumerState<ChatRoomScreen> {
  final _scroll = ScrollController();
  final _text = TextEditingController();
  final _focus = FocusNode();
  late final PresenceHeartbeat _presence = PresenceHeartbeat(ref.read(chatRealtimeProvider));
  late final AppLifecycleListener _lifecycle;
  bool _foreground = true;
  bool _atBottom = true;
  bool _hasNewBelow = false;
  String? _seenNewestId;
  String? _readRequestedFor;
  OutgoingReply? _replyTo;
  Timer? _pruneTimer;

  ChatRoomController get _controller => ref.read(chatRoomControllerProvider(widget.roomId).notifier);

  @override
  void initState() {
    super.initState();
    _presence.start();
    _lifecycle = AppLifecycleListener(
      onStateChange: (state) => _foreground = state == AppLifecycleState.resumed,
      // Kembali aktif: event selama di latar belakang mungkin terlewat (AC F11-3).
      onResume: () => unawaited(_controller.resync()),
    );
    _scroll.addListener(_onScroll);
    _text.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _pruneTimer?.cancel();
    _presence.dispose();
    _lifecycle.dispose();
    _scroll.dispose();
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scroll.hasClients) return;
    final position = _scroll.position;
    // Daftar terbalik: offset 0 = pesan terbaru di bawah; extentAfter kecil = mendekati awal riwayat.
    if (position.extentAfter < 300) unawaited(_controller.loadOlder());
    final atBottom = position.pixels <= 48;
    if (atBottom != _atBottom) {
      setState(() {
        _atBottom = atBottom;
        if (atBottom) _hasNewBelow = false;
      });
      if (atBottom) _requestRead(force: true);
    }
  }

  void _requestRead({bool force = false}) {
    final state = ref.read(chatRoomControllerProvider(widget.roomId));
    final newest = state.timeline.newest?.id;
    if (newest == null || !_atBottom || !_foreground) return;
    if (!force && _readRequestedFor == newest) return;
    _readRequestedFor = newest;
    unawaited(_controller.markLatestRead());
  }

  void _scrollToBottom() {
    if (!_scroll.hasClients) return;
    unawaited(_scroll.animateTo(0, duration: const Duration(milliseconds: 250), curve: Curves.easeOut));
  }

  void _schedulePrune(ChatRoomViewState state) {
    _pruneTimer?.cancel();
    final expiries = [...state.typing.values, ...state.online.values];
    if (expiries.isEmpty) return;
    final now = ref.read(clockProvider)().toUtc();
    final earliest = expiries.reduce((a, b) => a.isBefore(b) ? a : b);
    final wait = earliest.difference(now) + const Duration(milliseconds: 50);
    _pruneTimer = Timer(wait.isNegative ? Duration.zero : wait, () {
      if (mounted) _controller.pruneEphemeral();
    });
  }

  void _send() {
    final text = _text.text;
    final error = _controller.sendText(text, replyTo: _replyTo);
    if (error != null) {
      _snack(error);
      return;
    }
    _text.clear();
    setState(() => _replyTo = null);
    _scrollToBottom();
  }

  Future<void> _pickImage() async {
    final source = await showModalBottomSheet<ChatImageSource>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Kamera'),
              onTap: () => Navigator.of(sheetContext).pop(ChatImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Galeri'),
              onTap: () => Navigator.of(sheetContext).pop(ChatImageSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (source == null || !mounted) return;
    try {
      final image = await ref.read(chatImagePickerProvider)(source);
      if (image == null || !mounted) return;
      final caption = _text.text.trim().isEmpty ? null : _text.text;
      final error = _controller.sendImage(image, caption: caption, replyTo: _replyTo);
      if (error != null) {
        _snack(error);
        return;
      }
      _text.clear();
      setState(() => _replyTo = null);
      _scrollToBottom();
    } on ChatImageException catch (error) {
      _snack(error.message);
    } on PlatformException {
      _snack('Foto tidak dapat dibuka. Periksa izin kamera/galeri di pengaturan perangkat.');
    }
  }

  void _snack(String message) {
    ref.read(scaffoldMessengerKeyProvider).currentState
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
    } on ApiException catch (error) {
      if (!mounted) return;
      await ref.read(errorPresenterProvider).present(error);
    }
  }

  Future<void> _messageActions(ChatMessage message, ChatRoomViewState state) async {
    final me = ref.read(chatMyUserIdProvider);
    final mine = message.sender?.userId == me;
    final deleted = message.deletedAt != null;
    final canInteract = state.room?.canSend == true && !state.membershipLapsed && !deleted;
    final action = await showModalBottomSheet<String>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (canInteract)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4),
                child: Wrap(
                  alignment: WrapAlignment.center,
                  spacing: KapdhSpace.s1,
                  children: [
                    for (final emoji in quickReactions)
                      IconButton(
                        tooltip: 'Reaksi $emoji',
                        onPressed: () => Navigator.of(sheetContext).pop('react:$emoji'),
                        icon: Text(emoji, style: const TextStyle(fontSize: 24)),
                      ),
                  ],
                ),
              ),
            if (canInteract)
              ListTile(
                leading: const Icon(Icons.reply),
                title: const Text('Balas'),
                onTap: () => Navigator.of(sheetContext).pop('reply'),
              ),
            if (!deleted && (message.body?.isNotEmpty ?? false))
              ListTile(
                leading: const Icon(Icons.copy),
                title: const Text('Salin teks'),
                onTap: () => Navigator.of(sheetContext).pop('copy'),
              ),
            if (mine && !deleted)
              ListTile(
                leading: const Icon(Icons.delete_outline, color: KapdhColors.danger),
                title: const Text('Hapus pesan'),
                onTap: () => Navigator.of(sheetContext).pop('delete'),
              ),
            if (!mine && message.sender != null)
              ListTile(
                leading: const Icon(Icons.flag_outlined),
                title: const Text('Laporkan pesan'),
                onTap: () => Navigator.of(sheetContext).pop('report'),
              ),
          ],
        ),
      ),
    );
    if (action == null || !mounted) return;
    if (action.startsWith('react:')) {
      await _run(() => _controller.toggleReaction(message, action.substring('react:'.length)));
      return;
    }
    switch (action) {
      case 'reply':
        setState(() => _replyTo = replyFrom(message));
        _focus.requestFocus();
      case 'copy':
        await Clipboard.setData(ClipboardData(text: message.body ?? ''));
        _snack('Teks disalin.');
      case 'delete':
        final confirmed = await showDialog<bool>(
          context: context,
          useRootNavigator: true,
          builder: (dialogContext) => AlertDialog(
            title: const Text('Hapus pesan?'),
            content: const Text('Isi pesan dihapus untuk semua anggota dan diganti keterangan "Pesan ini telah dihapus".'),
            actions: [
              TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Batal')),
              TextButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: const Text('Hapus')),
            ],
          ),
        );
        if (confirmed ?? false) await _run(() => _controller.deleteMessage(message.id));
      case 'report':
        await showReportSheet(
          context,
          MessageReportTarget(
            messageId: message.id,
            senderName: message.sender?.fullName ?? 'Anggota',
            preview: messagePreviewText(message),
            contextMessageIds: reportContextIds(state.timeline, message.id),
          ),
        );
    }
  }

  Future<void> _outgoingActions(OutgoingMessage entry, bool lapsed) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (entry.status == OutgoingStatus.failed && !lapsed)
              ListTile(
                leading: const Icon(Icons.refresh),
                title: const Text('Kirim ulang'),
                onTap: () => Navigator.of(sheetContext).pop('retry'),
              ),
            if (entry.status != OutgoingStatus.sending)
              ListTile(
                leading: const Icon(Icons.delete_outline, color: KapdhColors.danger),
                title: const Text('Buang pesan'),
                onTap: () => Navigator.of(sheetContext).pop('discard'),
              ),
          ],
        ),
      ),
    );
    if (!mounted) return;
    switch (action) {
      case 'retry':
        _controller.retry(entry.clientMessageId);
      case 'discard':
        _controller.discard(entry.clientMessageId);
    }
  }

  List<_Item> _items(ChatTimeline timeline, List<OutgoingMessage> outgoing) {
    final items = <_Item>[];
    String? lastDate;
    void addDate(DateTime at) {
      final label = formatDate(at);
      if (label != lastDate) {
        items.add(_DateItem(label));
        lastDate = label;
      }
    }

    for (final message in timeline.messages) {
      addDate(message.createdAt);
      items.add(_ServerItem(message));
    }
    for (final entry in [...outgoing]..sort((a, b) => a.createdAt.compareTo(b.createdAt))) {
      addDate(entry.createdAt);
      items.add(_OutgoingItem(entry));
    }
    return items;
  }

  String _subtitle(ChatRoomViewState state) {
    final room = state.room!;
    final me = ref.read(chatMyUserIdProvider);
    final typing = state.typing.keys.where((id) => id != me).toList();
    if (typing.isNotEmpty) {
      if (room.kind == ChatRoomKind.direct) return 'sedang mengetik…';
      if (typing.length == 1) {
        final name = state.members[typing.first]?.fullName ?? 'Seseorang';
        return '$name sedang mengetik…';
      }
      return '${typing.length} orang sedang mengetik…';
    }
    if (room.kind == ChatRoomKind.group) {
      return room.closedAt != null ? 'Grup ditutup' : '${room.memberCount} anggota';
    }
    final peer = room.peer;
    if (peer == null || !peer.available) return 'Tidak tersedia';
    return state.online.containsKey(peer.userId) ? 'Daring' : '';
  }

  /// "Terkirim"/"Dibaca" untuk pesan sendiri; di grup "Dibaca N" = anggota lain yang read cursor-nya sudah melewati
  /// pesan ini. Presence/typing bukan bukti baca (PRD 3.11).
  (DeliveryStatus, String?) _readStatus(ChatMessage message, ChatRoomViewState state, String? me) {
    final room = state.room!;
    final timeline = state.timeline;
    if (room.kind == ChatRoomKind.direct) {
      return timeline.isReadBy(room.peerLastReadMessageId, message)
          ? (DeliveryStatus.read, null)
          : (DeliveryStatus.sent, null);
    }
    final readers = state.members.values
        .where((m) => m.userId != me && timeline.isReadBy(m.lastReadMessageId, message))
        .length;
    return readers > 0 ? (DeliveryStatus.read, 'Dibaca $readers') : (DeliveryStatus.sent, null);
  }

  Widget _serverBubble(ChatMessage message, ChatRoomViewState state, String? me) {
    if (message.kind == ChatMessageKind.system) {
      return SystemMessageView(text: message.body ?? '', time: message.createdAt);
    }
    final room = state.room!;
    final mine = message.sender != null && message.sender!.userId == me;
    final deleted = message.deletedAt != null;
    final (status, detail) = mine && !deleted ? _readStatus(message, state, me) : (null, null);
    final senderName = mine || room.kind == ChatRoomKind.direct ? null : (message.sender?.fullName ?? 'Akun dihapus');
    final reply = message.replyTo;
    final canReact = room.canSend && !state.membershipLapsed && !deleted;
    final time = formatTime(message.createdAt);
    final label = [
      mine ? 'Anda' : (message.sender?.fullName ?? 'Akun dihapus'),
      time,
      if (deleted) 'Pesan ini telah dihapus' else messagePreviewText(message),
      if (status != null) detail ?? status.label,
    ].join(', ');
    return ChatBubble(
      key: ValueKey('msg-${message.id}'),
      mine: mine,
      time: time,
      semanticsLabel: label,
      senderName: senderName,
      reply: reply == null
          ? null
          : ReplyQuote.fromReply(reply, localCopy: state.timeline.byId(reply.id), onDark: mine),
      image: message.image == null || deleted
          ? null
          : ChatImageView(
              image: message.image!,
              onReload: () => unawaited(_controller.resync()),
              onOpen: () => _openImage(message.image!.url),
            ),
      body: message.body,
      deleted: deleted,
      status: status,
      statusDetail: detail,
      reactions: message.reactions,
      onToggleReaction: canReact ? (emoji) => _run(() => _controller.toggleReaction(message, emoji)) : null,
      onLongPress: () => _messageActions(message, state),
    );
  }

  Widget _outgoingBubble(OutgoingMessage entry, ChatRoomViewState state) {
    final status = deliveryOf(entry.status);
    final reply = entry.replyTo;
    final image = entry.image;
    final time = formatTime(entry.createdAt);
    final failure = entry.status == OutgoingStatus.sending ? null : entry.failureMessage;
    final hint = switch (entry.status) {
      OutgoingStatus.failed => 'Ketuk untuk kirim ulang atau buang.',
      OutgoingStatus.held => 'Dikirim setelah KTA diperpanjang.',
      OutgoingStatus.sending => null,
    };
    return ChatBubble(
      key: ValueKey('out-${entry.clientMessageId}'),
      mine: true,
      time: time,
      semanticsLabel: [
        'Anda',
        time,
        if (image != null) 'Foto',
        entry.body ?? '',
        status.label,
        ?failure,
        ?hint,
      ].join(', '),
      reply: reply == null
          ? null
          : ReplyQuote(
              senderName: reply.senderName,
              preview: reply.preview,
              hasImage: reply.hasImage,
              available: true,
              onDark: true,
            ),
      image: image == null
          ? null
          : ClipRRect(
              borderRadius: BorderRadius.circular(KapdhRadius.sm),
              child: Image.memory(
                image.bytes,
                width: ChatImageView.maxWidth,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => const SizedBox(
                  width: ChatImageView.maxWidth,
                  height: 120,
                  child: ColoredBox(color: KapdhColors.neutral100, child: Icon(Icons.image_outlined)),
                ),
              ),
            ),
      body: entry.body,
      status: status,
      onTap: entry.status == OutgoingStatus.sending ? null : () => _outgoingActions(entry, state.membershipLapsed),
      onLongPress: entry.status == OutgoingStatus.sending ? null : () => _outgoingActions(entry, state.membershipLapsed),
      footer: failure == null && hint == null
          ? null
          : Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                [?failure, ?hint].join(' '),
                textAlign: TextAlign.end,
                style: TextStyle(
                  fontSize: KapdhFontSize.overline,
                  color: entry.status == OutgoingStatus.failed ? KapdhColors.danger : KapdhColors.warning,
                ),
              ),
            ),
    );
  }

  void _openImage(String url) {
    unawaited(
      showDialog<void>(
        context: context,
        useRootNavigator: true,
        builder: (dialogContext) => Dialog.fullscreen(
          backgroundColor: Colors.black,
          child: Stack(
            children: [
              Center(
                child: InteractiveViewer(
                  child: Image.network(
                    url,
                    errorBuilder: (_, _, _) => const Text(
                      'Foto tidak dapat dimuat.',
                      style: TextStyle(color: KapdhColors.onPrimary),
                    ),
                  ),
                ),
              ),
              SafeArea(
                child: IconButton(
                  tooltip: 'Tutup',
                  color: KapdhColors.onPrimary,
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.of(dialogContext).pop(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _historyHeader(ChatRoomViewState state) {
    if (state.loadingOlder) {
      return const Padding(
        padding: EdgeInsets.all(KapdhSpace.s3),
        child: Center(
          child: SizedBox(
            width: 24,
            height: 24,
            child: CircularProgressIndicator(strokeWidth: 2, semanticsLabel: 'Memuat pesan lama'),
          ),
        ),
      );
    }
    final olderError = state.olderError;
    if (olderError != null) {
      return Padding(
        padding: const EdgeInsets.all(KapdhSpace.s2),
        child: InfoBox(
          tone: InfoBoxTone.warning,
          message: 'Pesan lama belum dapat dimuat. ${olderError.message}',
          trailing: TextButton(onPressed: () => unawaited(_controller.loadOlder()), child: const Text('Coba lagi')),
        ),
      );
    }
    if (state.timeline.hasOlder) {
      return Center(
        child: TextButton(onPressed: () => unawaited(_controller.loadOlder()), child: const Text('Muat pesan lama')),
      );
    }
    final visibleFrom = state.room?.historyVisibleFrom;
    return Padding(
      padding: const EdgeInsets.all(KapdhSpace.s3),
      child: Text(
        visibleFrom == null
            ? 'Awal percakapan'
            : 'Anda melihat pesan sejak bergabung pada ${formatDateTime(visibleFrom)}.',
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
      ),
    );
  }

  Widget _composerArea(ChatRoomViewState state) {
    final room = state.room!;
    if (state.membershipLapsed) {
      // PRD 4.5 "Keanggotaan berakhir saat chat": tampilkan ajakan perpanjang dan tahan pengiriman.
      return _NoticeBar(
        icon: Icons.lock_clock_outlined,
        message:
            'Masa keanggotaan Anda tidak aktif, sehingga pesan baru tidak dapat dikirim. Perpanjang KTA untuk '
            'melanjutkan percakapan; pesan yang tertunda tetap tersimpan.',
        actionLabel: 'Perpanjang KTA',
        onAction: () => context.push(AppRoutes.renewal),
      );
    }
    if (!room.canSend) {
      final peerName = room.peer?.fullName ?? room.title;
      return switch (room.sendRestriction) {
        ChatSendRestriction.blocked => _NoticeBar(
          icon: Icons.block,
          message: 'Anda memblokir $peerName. Buka blokir untuk kembali mengirim pesan.',
          actionLabel: 'Buka blokir',
          onAction: () async {
            final peer = room.peer;
            if (peer == null) return;
            final done = await unblockWithConfirmation(context, ref, userId: peer.userId, name: peer.fullName);
            if (done) unawaited(_controller.refreshRoom());
          },
        ),
        ChatSendRestriction.roomClosed => const _NoticeBar(
          icon: Icons.lock_outline,
          message: 'Grup ini sudah ditutup. Riwayat pesan tetap dapat dibaca.',
        ),
        // peer_unavailable: alasan sengaja tidak dibedakan (N-09, AC F12-1).
        _ => const _NoticeBar(
          icon: Icons.person_off_outlined,
          message: 'Anggota ini tidak dapat menerima pesan saat ini. Riwayat pesan tetap dapat dibaca.',
        ),
      };
    }
    final length = chatTextLength(_text.text);
    final tooLong = length > maxChatTextChars;
    final canSend = _text.text.trim().isNotEmpty && !tooLong;
    final reply = _replyTo;
    return SafeArea(
      top: false,
      child: Container(
        decoration: const BoxDecoration(
          color: KapdhColors.surface,
          border: Border(top: BorderSide(color: KapdhColors.divider)),
        ),
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s2, KapdhSpace.s2, KapdhSpace.s2, KapdhSpace.s2),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (reply != null)
              Row(
                children: [
                  Expanded(
                    child: ReplyQuote(
                      senderName: reply.senderName,
                      preview: reply.preview,
                      hasImage: reply.hasImage,
                      available: true,
                    ),
                  ),
                  IconButton(
                    tooltip: 'Batalkan balasan',
                    icon: const Icon(Icons.close),
                    onPressed: () => setState(() => _replyTo = null),
                  ),
                ],
              ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                IconButton(tooltip: 'Kirim foto', icon: const Icon(Icons.add_photo_alternate_outlined), onPressed: _pickImage),
                Expanded(
                  child: TextField(
                    controller: _text,
                    focusNode: _focus,
                    minLines: 1,
                    maxLines: 5,
                    keyboardType: TextInputType.multiline,
                    textCapitalization: TextCapitalization.sentences,
                    onChanged: (_) => _controller.notifyTyping(),
                    decoration: InputDecoration(
                      hintText: 'Tulis pesan…',
                      isDense: true,
                      errorText: tooLong ? 'Pesan maksimal $maxChatTextChars karakter.' : null,
                      counterText: length >= composerCounterThreshold ? '$length/$maxChatTextChars' : null,
                    ),
                  ),
                ),
                IconButton.filled(
                  tooltip: 'Kirim',
                  style: IconButton.styleFrom(
                    backgroundColor: KapdhColors.primary,
                    foregroundColor: KapdhColors.onPrimary,
                    minimumSize: const Size(48, 48),
                  ),
                  icon: const Icon(Icons.send),
                  onPressed: canSend ? _send : null,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  PreferredSizeWidget _appBar(ChatRoomViewState state) {
    final room = state.room!;
    final subtitle = _subtitle(state);
    return AppBar(
      automaticallyImplyLeading: false,
      titleSpacing: 0,
      leading: IconButton(
        tooltip: 'Kembali',
        icon: const Icon(Icons.arrow_back),
        onPressed: () {
          final router = GoRouter.of(context);
          if (router.canPop()) {
            router.pop();
          } else {
            router.go(AppRoutes.network);
          }
        },
      ),
      title: Semantics(
        button: true,
        label: 'Info percakapan ${room.title}${subtitle.isEmpty ? '' : ', $subtitle'}',
        excludeSemantics: true,
        child: InkWell(
          onTap: () => context.push(AppRoutes.chatInfo(room.id)),
          child: Row(
            children: [
              AlumniAvatar(
                name: room.title,
                url: room.avatarUrl,
                size: 36,
                icon: room.kind == ChatRoomKind.group && room.avatarUrl == null ? Icons.groups : null,
              ),
              const SizedBox(width: KapdhSpace.s2),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(room.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                    if (subtitle.isNotEmpty)
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        if (room.muted)
          const Padding(
            padding: EdgeInsets.only(right: KapdhSpace.s1),
            child: Icon(Icons.notifications_off_outlined, semanticLabel: 'Dibisukan'),
          ),
        IconButton(
          tooltip: 'Info percakapan',
          icon: const Icon(Icons.info_outline),
          onPressed: () => context.push(AppRoutes.chatInfo(room.id)),
        ),
      ],
      bottom: const PreferredSize(preferredSize: Size.fromHeight(1), child: Divider(height: 1)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(chatRoomControllerProvider(widget.roomId));
    final outgoing = ref.watch(chatOutboxProvider.select((s) => s[widget.roomId] ?? const <OutgoingMessage>[]));
    final me = ref.watch(chatMyUserIdProvider);
    final realtime = ref.watch(chatRealtimeProvider);

    if (state.gone) {
      return AppScaffold(
        title: 'Percakapan',
        fallbackLocation: AppRoutes.network,
        body: EmptyState(
          icon: Icons.speaker_notes_off_outlined,
          title: 'Percakapan tidak tersedia',
          message: 'Anda bukan lagi anggota percakapan ini, sehingga riwayatnya tidak dapat dibuka.',
          actionLabel: 'Ke Jejaring',
          onAction: () => context.go(AppRoutes.network),
        ),
      );
    }
    if (!state.loaded) {
      final error = state.loadError;
      Widget body;
      if (error == null) {
        body = const LoadingSkeleton(showCard: false, lines: 8, semanticsLabel: 'Memuat percakapan');
      } else if (isMembershipError(error)) {
        body = EmptyState(
          icon: Icons.lock_clock_outlined,
          title: 'Keanggotaan tidak aktif',
          message: '${error.message} Perpanjang KTA untuk membuka kembali percakapan.',
          actionLabel: 'Perpanjang KTA',
          onAction: () => context.push(AppRoutes.renewal),
        );
      } else {
        body = ErrorState.fromException(error, onRetry: () => unawaited(_controller.reload()));
      }
      return AppScaffold(title: 'Percakapan', fallbackLocation: AppRoutes.network, body: body);
    }

    final newestId = state.timeline.newest?.id;
    if (newestId != _seenNewestId) {
      final newest = state.timeline.newest;
      final fromOther = newest != null && newest.sender?.userId != me;
      if (_seenNewestId != null && !_atBottom && fromOther) _hasNewBelow = true;
      _seenNewestId = newestId;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _requestRead();
      _schedulePrune(ref.read(chatRoomControllerProvider(widget.roomId)));
    });

    final items = _items(state.timeline, outgoing).reversed.toList();
    final banner = AppBannerScope.of(context);

    return Scaffold(
      backgroundColor: KapdhColors.background,
      appBar: _appBar(state),
      body: Column(
        children: [
          ?banner,
          ValueListenableBuilder<RealtimeConnectionState>(
            valueListenable: realtime.connection,
            builder: (_, connection, _) {
              if (connection == RealtimeConnectionState.connected) {
                return state.syncError == null
                    ? const SizedBox.shrink()
                    : _ConnectionNotice(
                        message: 'Pesan terbaru belum tersinkron. ${state.syncError!.message}',
                        onRetry: () => unawaited(_controller.resync()),
                      );
              }
              return const _ConnectionNotice(
                message: 'Menyambungkan ulang… Pesan yang terlewat disinkronkan setelah tersambung.',
              );
            },
          ),
          Expanded(
            child: Stack(
              children: [
                ListView.builder(
                  controller: _scroll,
                  reverse: true,
                  padding: const EdgeInsets.fromLTRB(KapdhSpace.s3, KapdhSpace.s2, KapdhSpace.s3, KapdhSpace.s2),
                  itemCount: items.length + 1,
                  itemBuilder: (context, index) {
                    if (index == items.length) return _historyHeader(state);
                    final item = items[index];
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: switch (item) {
                        _DateItem(:final label) => DateSeparator(label: label),
                        _ServerItem(:final message) => _serverBubble(message, state, me),
                        _OutgoingItem(:final entry) => _outgoingBubble(entry, state),
                      },
                    );
                  },
                ),
                if (_hasNewBelow)
                  Positioned(
                    bottom: KapdhSpace.s3,
                    right: KapdhSpace.s3,
                    child: FloatingActionButton.small(
                      tooltip: 'Pesan baru, gulir ke bawah',
                      backgroundColor: KapdhColors.primary,
                      foregroundColor: KapdhColors.onPrimary,
                      onPressed: _scrollToBottom,
                      child: const Icon(Icons.arrow_downward),
                    ),
                  ),
              ],
            ),
          ),
          _composerArea(state),
        ],
      ),
    );
  }
}

class _ConnectionNotice extends StatelessWidget {
  const _ConnectionNotice({required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        color: KapdhColors.warningBg,
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s2),
        child: Row(
          children: [
            const Icon(Icons.sync_problem, size: 18, color: KapdhColors.warning),
            const SizedBox(width: KapdhSpace.s2),
            Expanded(
              child: Text(message, style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.warning)),
            ),
            if (onRetry != null) TextButton(onPressed: onRetry, child: const Text('Coba lagi')),
          ],
        ),
      ),
    );
  }
}

class _NoticeBar extends StatelessWidget {
  const _NoticeBar({required this.icon, required this.message, this.actionLabel, this.onAction});

  final IconData icon;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        decoration: const BoxDecoration(
          color: KapdhColors.surface,
          border: Border(top: BorderSide(color: KapdhColors.divider)),
        ),
        padding: const EdgeInsets.all(KapdhSpace.s3),
        child: InfoBox(
          tone: InfoBoxTone.warning,
          icon: icon,
          message: message,
          trailing: actionLabel == null || onAction == null
              ? null
              : TextButton(onPressed: onAction, child: Text(actionLabel!)),
        ),
      ),
    );
  }
}
