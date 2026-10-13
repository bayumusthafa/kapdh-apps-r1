import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';
import 'directory_tab.dart';
import 'moderation_actions.dart';
import 'moderation_repository.dart';
import 'paged_list.dart';
import 'widgets/alumni_avatar.dart';

/// Daftar anggota yang diblokir pemanggil (moderation.yaml listBlocks), terbaru dulu.
final blockedMembersProvider = NotifierProvider.autoDispose<BlockedMembersController, PagedState<BlockedMember>>(
  BlockedMembersController.new,
);

class BlockedMembersController extends PagedController<BlockedMember> {
  @override
  Future<PageResult<BlockedMember>> fetchPage(String? cursor) async {
    final page = await ref.read(moderationRepositoryProvider).listBlocks(cursor: cursor);
    return PageResult(page.items, page.nextCursor);
  }

  @override
  String keyOf(BlockedMember item) => item.userId;
}

/// Akun > Pengguna Diblokir (F-12): blokir milik sendiri dan buka blokir. Pemanggil tidak pernah diberi tahu siapa
/// yang memblokir dirinya.
class BlockedUsersScreen extends ConsumerWidget {
  const BlockedUsersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(blockedMembersProvider);
    final controller = ref.read(blockedMembersProvider.notifier);

    Widget body;
    if (!state.loaded && state.error == null) {
      body = const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat pengguna diblokir');
    } else if (!state.loaded) {
      body = ErrorState.fromException(state.error!, onRetry: controller.refresh);
    } else if (state.isEmpty) {
      body = const EmptyState(
        icon: Icons.block,
        title: 'Tidak ada pengguna yang diblokir',
        message:
            'Anggota yang Anda blokir tidak dapat saling mengirim pesan langsung atau undangan grup dengan Anda. '
            'Blokir dapat dilakukan dari profil alumni atau info percakapan.',
      );
    } else {
      body = RefreshIndicator(
        onRefresh: () => controller.refresh(silent: true),
        child: ListView.separated(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(KapdhSpace.s4),
          itemCount: state.items.length + 1,
          separatorBuilder: (_, _) => const SizedBox(height: KapdhSpace.s2),
          itemBuilder: (context, index) {
            if (index == state.items.length) {
              return PagedFooter(state: state, onRetry: controller.loadMore, onLoadMore: controller.loadMore);
            }
            final member = state.items[index];
            return Card(
              margin: EdgeInsets.zero,
              elevation: 0,
              color: KapdhColors.surface,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(KapdhRadius.md),
                side: const BorderSide(color: KapdhColors.divider),
              ),
              child: Padding(
                padding: const EdgeInsets.all(KapdhSpace.s3),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        AlumniAvatar(name: member.fullName, url: member.avatarUrl, size: 44),
                        const SizedBox(width: KapdhSpace.s3),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(member.fullName, style: const TextStyle(fontWeight: FontWeight.w600)),
                              Text(
                                'Diblokir sejak ${formatDate(member.blockedAt)}',
                                style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    // Tombol di baris sendiri agar tidak meluap saat teks diperbesar 200 % (N-11).
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton(
                        onPressed: () async {
                          final done = await unblockWithConfirmation(
                            context,
                            ref,
                            userId: member.userId,
                            name: member.fullName,
                          );
                          if (done) controller.removeWhere((m) => m.userId == member.userId);
                        },
                        child: const Text('Buka blokir'),
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      );
    }

    return AppScaffold(title: 'Pengguna Diblokir', fallbackLocation: AppRoutes.account, body: body);
  }
}
