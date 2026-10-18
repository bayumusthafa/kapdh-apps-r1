import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';
import '../network/directory_tab.dart';
import '../network/paged_list.dart';
import '../network/widgets/alumni_avatar.dart';
import 'chat_list_controller.dart';
import 'chat_realtime.dart';
import 'chat_repository.dart';

/// Undangan grup tertunda milik sendiri (chat.yaml listChatInvitations), terbaru dulu. Undangan baru atau yang
/// dibatalkan admin/sistem tiba lewat `room.member_changed` di kanal user sendiri.
final chatInvitationsProvider = NotifierProvider.autoDispose<ChatInvitationsController, PagedState<ChatInvitation>>(
  ChatInvitationsController.new,
);

class ChatInvitationsController extends PagedController<ChatInvitation> {
  @override
  PagedState<ChatInvitation> build() {
    final events = ref.watch(chatRealtimeProvider).events.listen((event) {
      if (event is RoomMemberChangedEvent &&
          event.payload.userId == ref.read(chatMyUserIdProvider) &&
          (event.payload.change == RoomMemberChangedPayloadChange.invited ||
              event.payload.change == RoomMemberChangedPayloadChange.invitationCancelled)) {
        unawaited(refresh(silent: true));
      }
    });
    ref.onDispose(() => unawaited(events.cancel()));
    return super.build();
  }

  @override
  Future<PageResult<ChatInvitation>> fetchPage(String? cursor) async {
    final page = await ref.read(chatRepositoryProvider).listInvitations(cursor: cursor);
    return PageResult(page.items, page.nextCursor);
  }

  @override
  String keyOf(ChatInvitation item) => item.roomId;
}

/// Undangan Grup (F-11, PRD 3.11): pengguna tidak dipaksa masuk; undangan tetap tertunda sampai diterima, ditolak,
/// atau dibatalkan admin grup.
class ChatInvitationsScreen extends ConsumerStatefulWidget {
  const ChatInvitationsScreen({super.key});

  @override
  ConsumerState<ChatInvitationsScreen> createState() => _ChatInvitationsScreenState();
}

class _ChatInvitationsScreenState extends ConsumerState<ChatInvitationsScreen> {
  final Set<String> _busy = {};

  Future<void> _accept(ChatInvitation invitation) async {
    setState(() => _busy.add(invitation.roomId));
    try {
      final room = await ref.read(chatRepositoryProvider).acceptInvitation(invitation.roomId);
      if (!mounted) return;
      ref.read(chatListRefreshProvider.notifier).request();
      ref.read(chatInvitationsProvider.notifier).removeWhere((i) => i.roomId == invitation.roomId);
      context.pushReplacement(AppRoutes.chat(room.id));
    } on ApiException catch (error) {
      if (!mounted) return;
      await ref.read(errorPresenterProvider).present(error, onRetry: () => _accept(invitation));
      if (error.code == ErrorCode.notFound) {
        // Undangan dibatalkan atau grup ditutup.
        ref.read(chatInvitationsProvider.notifier).removeWhere((i) => i.roomId == invitation.roomId);
      }
    } finally {
      if (mounted) setState(() => _busy.remove(invitation.roomId));
    }
  }

  Future<void> _decline(ChatInvitation invitation) async {
    final confirmed = await showDialog<bool>(
      context: context,
      useRootNavigator: true,
      builder: (dialogContext) => AlertDialog(
        title: Text('Tolak undangan ${invitation.roomName}?'),
        content: const Text('Admin grup dapat mengundang Anda lagi di kemudian hari.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Batal')),
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: const Text('Tolak')),
        ],
      ),
    );
    if (!(confirmed ?? false) || !mounted) return;
    setState(() => _busy.add(invitation.roomId));
    try {
      await ref.read(chatRepositoryProvider).declineInvitation(invitation.roomId);
      if (!mounted) return;
      ref.read(chatInvitationsProvider.notifier).removeWhere((i) => i.roomId == invitation.roomId);
      ref.read(chatListRefreshProvider.notifier).request();
    } on ApiException catch (error) {
      if (!mounted) return;
      await ref.read(errorPresenterProvider).present(error, onRetry: () => _decline(invitation));
      if (error.code == ErrorCode.notFound) {
        ref.read(chatInvitationsProvider.notifier).removeWhere((i) => i.roomId == invitation.roomId);
      }
    } finally {
      if (mounted) setState(() => _busy.remove(invitation.roomId));
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(chatInvitationsProvider);
    final controller = ref.read(chatInvitationsProvider.notifier);
    final now = ref.read(clockProvider)();

    Widget body;
    if (!state.loaded && state.error == null) {
      body = const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat undangan');
    } else if (!state.loaded) {
      body = ErrorState.fromException(state.error!, onRetry: controller.refresh);
    } else if (state.isEmpty) {
      body = const EmptyState(
        icon: KapdhIcons.mailOutline,
        title: 'Tidak ada undangan',
        message: 'Undangan grup dari admin grup akan tampil di sini.',
      );
    } else {
      body = RefreshIndicator(
        onRefresh: () => controller.refresh(silent: true),
        child: ListView.separated(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(KapdhSpace.s4),
          itemCount: state.items.length + 1,
          separatorBuilder: (_, _) => const SizedBox(height: KapdhSpace.s3),
          itemBuilder: (context, index) {
            if (index == state.items.length) {
              return PagedFooter(state: state, onRetry: controller.loadMore, onLoadMore: controller.loadMore);
            }
            final invitation = state.items[index];
            final busy = _busy.contains(invitation.roomId);
            final inviter = invitation.invitedBy?.fullName;
            return DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(KapdhRadius.md),
                boxShadow: context.kc.shadowSm,
              ),
              child: Card(
                margin: EdgeInsets.zero,
                elevation: 0,
                color: context.kc.surface,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(KapdhRadius.md),
                  side: BorderSide(color: context.kc.cardBorder),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(KapdhSpace.s4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          AlumniAvatar(
                            name: invitation.roomName,
                            url: invitation.roomAvatarUrl,
                            size: 48,
                            icon: invitation.roomAvatarUrl == null ? KapdhIcons.groups : null,
                          ),
                          const SizedBox(width: KapdhSpace.s3),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(invitation.roomName, style: const TextStyle(fontWeight: FontWeight.w600)),
                                Text(
                                  '${invitation.memberCount} anggota · ${inviter == null ? 'Diundang' : 'Diundang oleh $inviter'}'
                                  ' · ${formatRelative(invitation.invitedAt, now: now)}',
                                  style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: KapdhSpace.s3),
                      Row(
                        children: [
                          Expanded(
                            child: KapdhButton.outlined(
                              label: 'Tolak',
                              onPressed: busy ? null : () => _decline(invitation),
                            ),
                          ),
                          const SizedBox(width: KapdhSpace.s3),
                          Expanded(
                            child: KapdhButton.solid(
                              label: 'Terima',
                              busy: busy,
                              busyLabel: 'Memproses',
                              onPressed: busy ? null : () => _accept(invitation),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      );
    }
    return AppScaffold(title: 'Undangan Grup', fallbackLocation: AppRoutes.network, body: body);
  }
}
