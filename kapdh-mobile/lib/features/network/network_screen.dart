import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../design/design.dart';
import '../chat/chat_list_controller.dart';
import '../chat/chat_list_view.dart';
import '../chat/chat_realtime.dart';
import '../chat/presence_heartbeat.dart';
import 'directory_controller.dart';
import 'directory_filter.dart';
import 'directory_filter_sheet.dart';
import 'directory_tab.dart';

/// Jeda pencarian saat mengetik agar tidak setiap ketukan menjadi request (direktori dibatasi laju, 429).
const Duration directorySearchDebounce = Duration(milliseconds: 400);

/// Tab Jejaring (guideline hal. 7; F-10, F-11): kotak "Cari relasi dengan alumni", tombol filter, lalu tab
/// Jejaring | Pesan | Pesan Grup. Hanya untuk anggota aktif (verified/expiring); server menolak status lain dengan
/// 403 dan router mengarahkan ulang (AC F10-3).
class NetworkScreen extends ConsumerStatefulWidget {
  const NetworkScreen({super.key});

  @override
  ConsumerState<NetworkScreen> createState() => _NetworkScreenState();
}

class _NetworkScreenState extends ConsumerState<NetworkScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 3, vsync: this);
  final _search = TextEditingController();
  Timer? _debounce;
  late final PresenceHeartbeat _presence = PresenceHeartbeat(ref.read(chatRealtimeProvider));

  @override
  void initState() {
    super.initState();
    _presence.start();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _presence.dispose();
    _tabs.dispose();
    _search.dispose();
    super.dispose();
  }

  void _onSearchChanged(String value) {
    if (_tabs.index != 0) _tabs.animateTo(0);
    _debounce?.cancel();
    _debounce = Timer(directorySearchDebounce, () {
      if (mounted) ref.read(directoryFilterProvider.notifier).setQuery(value);
    });
    setState(() {});
  }

  void _submitSearch(String value) {
    _debounce?.cancel();
    if (_tabs.index != 0) _tabs.animateTo(0);
    ref.read(directoryFilterProvider.notifier).setQuery(value);
  }

  void _clearSearch() {
    _debounce?.cancel();
    _search.clear();
    ref.read(directoryFilterProvider.notifier).setQuery('');
    setState(() {});
  }

  Future<void> _openFilter() async {
    final current = ref.read(directoryFilterProvider);
    final result = await showDirectoryFilterSheet(context, current);
    if (result == null || !mounted) return;
    ref.read(directoryFilterProvider.notifier).applySheet(result);
    if (_tabs.index != 0) _tabs.animateTo(0);
  }

  Widget _tabLabel(String label, int unread, {int invitations = 0}) => Tab(
    child: Semantics(
      label: [
        label,
        if (unread > 0) '$unread percakapan belum dibaca',
        if (invitations > 0) '$invitations undangan grup',
      ].join(', '),
      excludeSemantics: true,
      child: Badge(
        isLabelVisible: unread > 0 || invitations > 0,
        smallSize: 8,
        offset: const Offset(10, -2),
        backgroundColor: KapdhColors.primary,
        child: Text(label),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final filter = ref.watch(directoryFilterProvider);
    final directUnread = unreadRoomsIn(ref.watch(chatRoomListProvider(ChatRoomKind.direct)));
    final groupUnread = unreadRoomsIn(ref.watch(chatRoomListProvider(ChatRoomKind.group)));
    final pendingInvitations = ref.watch(chatBadgeCountsProvider.select((c) => c.pendingInvitations));
    final banner = AppBannerScope.of(context);
    final queryTooShort = _search.text.trim().isNotEmpty && _search.text.trim().length < directoryMinQueryLength;

    return Scaffold(
      backgroundColor: KapdhColors.background,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(KapdhSpace.s4, KapdhSpace.s3, KapdhSpace.s4, KapdhSpace.s2),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _search,
                      onChanged: _onSearchChanged,
                      onSubmitted: _submitSearch,
                      textInputAction: TextInputAction.search,
                      inputFormatters: [LengthLimitingTextInputFormatter(directoryMaxQueryLength)],
                      decoration: InputDecoration(
                        hintText: 'Cari relasi dengan alumni ...',
                        prefixIcon: const Icon(Icons.search),
                        suffixIcon: _search.text.isEmpty
                            ? null
                            : IconButton(
                                tooltip: 'Hapus pencarian',
                                icon: const Icon(Icons.close),
                                onPressed: _clearSearch,
                              ),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: KapdhSpace.s2),
                  Badge(
                    isLabelVisible: filter.activeFilterCount > 0,
                    label: Text('${filter.activeFilterCount}'),
                    child: IconButton.filledTonal(
                      tooltip: filter.activeFilterCount > 0
                          ? 'Filter alumni, ${filter.activeFilterCount} aktif'
                          : 'Filter alumni',
                      style: IconButton.styleFrom(
                        backgroundColor: KapdhColors.green50,
                        foregroundColor: KapdhColors.primary,
                        minimumSize: const Size(48, 48),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
                      ),
                      icon: const Icon(Icons.tune),
                      onPressed: _openFilter,
                    ),
                  ),
                ],
              ),
            ),
            if (queryTooShort)
              const Padding(
                padding: EdgeInsets.fromLTRB(KapdhSpace.s4, 0, KapdhSpace.s4, KapdhSpace.s1),
                child: Text(
                  'Ketik minimal 2 huruf untuk mencari nama.',
                  style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                ),
              ),
            ?banner,
            TabBar(
              controller: _tabs,
              isScrollable: true,
              tabAlignment: TabAlignment.start,
              labelColor: KapdhColors.primary,
              unselectedLabelColor: KapdhColors.textMuted,
              indicatorColor: KapdhColors.primary,
              tabs: [
                const Tab(text: 'Jejaring'),
                _tabLabel('Pesan', directUnread),
                _tabLabel('Pesan Grup', groupUnread, invitations: pendingInvitations),
              ],
            ),
            const Divider(height: 1),
            Expanded(
              child: TabBarView(
                controller: _tabs,
                children: const [
                  DirectoryTab(),
                  ChatRoomListView(kind: ChatRoomKind.direct),
                  ChatRoomListView(kind: ChatRoomKind.group),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
