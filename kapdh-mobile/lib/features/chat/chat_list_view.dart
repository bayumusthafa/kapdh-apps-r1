import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';
import '../network/directory_tab.dart';
import '../network/paged_list.dart';
import '../network/widgets/alumni_avatar.dart';
import 'chat_list_controller.dart';
import 'chat_outbox.dart';

/// Teks pratinjau pesan terakhir di daftar room (tanpa isi pesan yang dihapus).
String lastMessageText(ChatRoomSummary room, {required String? myUserId}) {
  final last = room.lastMessage;
  if (last == null) return room.kind == ChatRoomKind.group ? 'Belum ada pesan' : '';
  if (last.deleted) return 'Pesan dihapus';
  final content = last.preview ?? (last.hasImage ? 'Foto' : '');
  final text = last.hasImage && last.preview != null ? 'Foto · $content' : content;
  if (last.kind == ChatMessageKind.system) return text;
  if (last.senderUserId != null && last.senderUserId == myUserId) return 'Anda: $text';
  if (room.kind == ChatRoomKind.group && last.senderName != null) return '${last.senderName}: $text';
  return text;
}

/// Isi tab "Pesan" (direct) dan "Pesan Grup" (group) di Jejaring (guideline hal. 7; F-11): room milik sendiri dengan
/// pratinjau terakhir, jumlah belum dibaca, penanda bisu dan pesan yang belum terkirim.
class ChatRoomListView extends ConsumerWidget {
  const ChatRoomListView({super.key, required this.kind});

  final ChatRoomKind kind;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(chatRoomListProvider(kind));
    final controller = ref.read(chatRoomListProvider(kind).notifier);
    final counts = ref.watch(chatBadgeCountsProvider);
    final outbox = ref.watch(chatOutboxProvider);
    final me = ref.watch(chatMyUserIdProvider);
    final group = kind == ChatRoomKind.group;

    final header = <Widget>[
      if (group) ...[
        _GroupActions(pendingInvitations: counts.pendingInvitations),
        const SizedBox(height: KapdhSpace.s2),
      ],
    ];

    Widget content;
    if (!state.loaded && state.error == null) {
      content = const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat percakapan');
    } else if (!state.loaded) {
      content = ErrorState.fromException(state.error!, onRetry: controller.refresh);
    } else if (state.isEmpty) {
      content = EmptyState(
        icon: group ? KapdhIcons.groupsOutlined : KapdhIcons.chatBubbleOutline,
        title: group ? 'Belum ada grup' : 'Belum ada percakapan',
        message: group
            ? 'Buat grup lalu undang alumni, atau terima undangan grup yang masuk.'
            : 'Buka profil alumni di tab Jejaring lalu ketuk Kirim Pesan untuk memulai percakapan.',
      );
    } else {
      final now = ref.read(clockProvider)();
      content = RefreshIndicator(
        onRefresh: () => controller.refresh(silent: true),
        child: NotificationListener<ScrollNotification>(
          onNotification: (notification) {
            // Setelah gagal, halaman berikut hanya lewat "Coba lagi" (PRD 4.5, N-01).
            if (notification.metrics.extentAfter < 300 &&
                state.hasMore &&
                !state.loadingMore &&
                state.moreError == null) {
              controller.loadMore();
            }
            return false;
          },
          child: ListView.separated(
            physics: const AlwaysScrollableScrollPhysics(),
            itemCount: state.items.length + 1,
            separatorBuilder: (_, _) => const Divider(height: 1, indent: 76),
            itemBuilder: (context, index) {
              if (index == state.items.length) {
                return PagedFooter(state: state, onRetry: controller.loadMore, onLoadMore: controller.loadMore);
              }
              final room = state.items[index];
              final unsent = hasUnsentMessages(outbox[room.id] ?? const []);
              return ChatRoomTile(
                room: room,
                myUserId: me,
                now: now,
                hasUnsent: unsent,
                onTap: () => context.push(AppRoutes.chat(room.id)),
              );
            },
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ...header,
        if (state.loaded && state.error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4),
            child: InfoBox(
              tone: InfoBoxTone.warning,
              message: 'Daftar terbaru belum dapat dimuat. ${state.error!.message}',
              trailing: TextButton(onPressed: controller.refresh, child: const Text('Coba lagi')),
            ),
          ),
        Expanded(child: content),
      ],
    );
  }
}

class _GroupActions extends StatelessWidget {
  const _GroupActions({required this.pendingInvitations});

  final int pendingInvitations;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s4, KapdhSpace.s2, KapdhSpace.s4, 0),
      child: Wrap(
        spacing: KapdhSpace.s2,
        runSpacing: KapdhSpace.s2,
        children: [
          OutlinedButton.icon(
            onPressed: () => context.push(AppRoutes.chatNewGroup),
            icon: const Icon(KapdhIcons.groupAddOutlined),
            label: const Text('Buat grup'),
          ),
          OutlinedButton.icon(
            onPressed: () => context.push(AppRoutes.chatInvitations),
            icon: Badge(
              isLabelVisible: pendingInvitations > 0,
              label: Text('$pendingInvitations'),
              child: const Icon(KapdhIcons.mailOutline),
            ),
            label: Text(pendingInvitations > 0 ? 'Undangan ($pendingInvitations)' : 'Undangan grup'),
          ),
        ],
      ),
    );
  }
}

/// Baris room: avatar, judul, pratinjau terakhir, waktu, jumlah belum dibaca dan ikon bisu. Status tidak hanya
/// dibedakan warna (N-11): jumlah unread dan bisu diumumkan pembaca layar.
class ChatRoomTile extends StatelessWidget {
  const ChatRoomTile({
    super.key,
    required this.room,
    required this.myUserId,
    required this.now,
    required this.onTap,
    this.hasUnsent = false,
  });

  final ChatRoomSummary room;
  final String? myUserId;
  final DateTime now;
  final VoidCallback onTap;
  final bool hasUnsent;

  @override
  Widget build(BuildContext context) {
    final unread = room.unreadCount;
    final preview = lastMessageText(room, myUserId: myUserId);
    final lastAt = room.lastMessageAt;
    final semantics = [
      room.title,
      if (unread > 0) '$unread pesan belum dibaca',
      if (room.muted) 'dibisukan',
      if (hasUnsent) 'ada pesan belum terkirim',
      if (preview.isNotEmpty) preview,
    ].join(', ');
    return Semantics(
      button: true,
      label: semantics,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 72),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s3),
            child: Row(
              children: [
                AlumniAvatar(
                  name: room.title,
                  url: room.avatarUrl,
                  size: 48,
                  icon: room.kind == ChatRoomKind.group && room.avatarUrl == null ? KapdhIcons.groups : null,
                ),
                const SizedBox(width: KapdhSpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              room.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontWeight: unread > 0 ? FontWeight.w700 : FontWeight.w600),
                            ),
                          ),
                          if (lastAt != null)
                            Text(
                              formatRelative(lastAt, now: now),
                              style: TextStyle(
                                fontSize: KapdhFontSize.overline,
                                color: unread > 0 ? context.kc.primary : context.kc.textMuted,
                              ),
                            ),
                        ],
                      ),
                      const SizedBox(height: 2),
                      Row(
                        children: [
                          if (hasUnsent)
                            Padding(
                              padding: const EdgeInsets.only(right: KapdhSpace.s1),
                              child: Icon(KapdhIcons.errorOutline, size: 16, color: context.kc.danger),
                            ),
                          Expanded(
                            child: Text(
                              preview,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: KapdhFontSize.caption,
                                color: unread > 0 ? context.kc.text : context.kc.textMuted,
                                fontStyle: room.lastMessage?.deleted ?? false ? FontStyle.italic : FontStyle.normal,
                              ),
                            ),
                          ),
                          if (room.muted)
                            Padding(
                              padding: const EdgeInsets.only(left: KapdhSpace.s1),
                              child: Icon(KapdhIcons.notificationsOffOutlined, size: 16, color: context.kc.textMuted),
                            ),
                          if (unread > 0)
                            Container(
                              margin: const EdgeInsets.only(left: KapdhSpace.s2),
                              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                              decoration: BoxDecoration(
                                // Dibisukan: neutral700 (9,3:1 dengan teks putih; dulu neutral500 3,3:1 gagal WCAG).
                                color: room.muted ? KapdhColors.neutral700 : context.kc.primary,
                                borderRadius: BorderRadius.circular(KapdhRadius.pill),
                              ),
                              child: Text(
                                unread > 99 ? '99+' : '$unread',
                                style: TextStyle(
                                  color: room.muted ? KapdhColors.onPrimary : context.kc.onPrimary,
                                  fontSize: KapdhFontSize.overline,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Jumlah room berpesan belum dibaca per jenis, untuk lencana tab (dari halaman yang dimuat).
int unreadRoomsIn(PagedState<ChatRoomSummary> state) => state.items.where((room) => room.unreadCount > 0).length;
