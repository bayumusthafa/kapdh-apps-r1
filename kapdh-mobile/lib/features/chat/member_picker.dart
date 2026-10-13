import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../design/design.dart';
import '../network/directory_filter.dart';
import '../network/network_repository.dart';
import '../network/widgets/directory_member_card.dart';

/// Membuka pemilih alumni dari direktori untuk undangan grup (F-11). [excludeUserIds] (anggota/undangan yang sudah
/// ada) tidak dapat dipilih; [maxSelection] membatasi jumlah pilihan (kapasitas grup 100). Mengembalikan pilihan,
/// atau null bila dibatalkan.
Future<List<DirectoryMember>?> showMemberPicker(
  BuildContext context, {
  required String title,
  required int maxSelection,
  Set<String> excludeUserIds = const {},
  List<DirectoryMember> initial = const [],
}) => Navigator.of(context, rootNavigator: true).push<List<DirectoryMember>>(
  MaterialPageRoute(
    fullscreenDialog: true,
    builder: (_) =>
        MemberPickerPage(title: title, maxSelection: maxSelection, excludeUserIds: excludeUserIds, initial: initial),
  ),
);

/// Halaman pemilih alumni: pencarian nama (minimal 2 huruf) dengan paging keyset direktori, kotak centang dan
/// tombol selesai.
class MemberPickerPage extends ConsumerStatefulWidget {
  const MemberPickerPage({
    super.key,
    required this.title,
    required this.maxSelection,
    this.excludeUserIds = const {},
    this.initial = const [],
  });

  final String title;
  final int maxSelection;
  final Set<String> excludeUserIds;
  final List<DirectoryMember> initial;

  @override
  ConsumerState<MemberPickerPage> createState() => _MemberPickerPageState();
}

class _MemberPickerPageState extends ConsumerState<MemberPickerPage> {
  final _search = TextEditingController();
  Timer? _debounce;
  late final Map<String, DirectoryMember> _selected = {for (final m in widget.initial) m.userId: m};
  List<DirectoryMember> _items = const [];
  String? _cursor;
  bool _loading = false;
  bool _loadingMore = false;
  ApiException? _error;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  DirectoryFilter get _filter => DirectoryFilter(query: DirectoryFilter.normalizeQuery(_search.text));

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await ref.read(networkRepositoryProvider).search(_filter);
      if (!mounted || generation != _generation) return;
      setState(() {
        _items = page.items;
        _cursor = page.nextCursor;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _loading = false;
        _error = error;
      });
    }
  }

  Future<void> _loadMore() async {
    final cursor = _cursor;
    if (cursor == null || _loading || _loadingMore) return;
    final generation = _generation;
    setState(() => _loadingMore = true);
    try {
      final page = await ref.read(networkRepositoryProvider).search(_filter, cursor: cursor);
      if (!mounted || generation != _generation) return;
      final seen = {for (final m in _items) m.userId};
      setState(() {
        _items = [..._items, ...page.items.where((m) => seen.add(m.userId))];
        _cursor = page.nextCursor;
        _loadingMore = false;
      });
    } on ApiException catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() => _loadingMore = false);
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  void _onSearch(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () {
      if (mounted) unawaited(_load());
    });
  }

  void _toggle(DirectoryMember member) {
    setState(() {
      if (_selected.remove(member.userId) == null) {
        if (_selected.length >= widget.maxSelection) {
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(
            SnackBar(content: Text('Maksimal ${widget.maxSelection} alumni dapat dipilih.')),
          );
          return;
        }
        _selected[member.userId] = member;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final visible = _items.where((m) => !widget.excludeUserIds.contains(m.userId)).toList();
    Widget body;
    if (_loading && _items.isEmpty) {
      body = const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat alumni');
    } else if (_error != null && _items.isEmpty) {
      body = ErrorState.fromException(_error!, onRetry: _load);
    } else if (visible.isEmpty) {
      body = const EmptyState(
        icon: Icons.person_search_outlined,
        title: 'Alumni tidak ditemukan',
        message: 'Cari dengan nama lain. Hanya anggota aktif yang tampil di direktori yang dapat diundang.',
      );
    } else {
      body = NotificationListener<ScrollNotification>(
        onNotification: (n) {
          if (n.metrics.extentAfter < 300) unawaited(_loadMore());
          return false;
        },
        child: ListView.separated(
          padding: const EdgeInsets.all(KapdhSpace.s4),
          itemCount: visible.length + (_loadingMore ? 1 : 0),
          separatorBuilder: (_, _) => const SizedBox(height: KapdhSpace.s2),
          itemBuilder: (context, index) {
            if (index == visible.length) {
              return const Center(child: CircularProgressIndicator(strokeWidth: 2));
            }
            final member = visible[index];
            final checked = _selected.containsKey(member.userId);
            return Semantics(
              checked: checked,
              child: DirectoryMemberCard(
                member: member,
                onTap: () => _toggle(member),
                trailing: Checkbox(value: checked, onChanged: (_) => _toggle(member)),
              ),
            );
          },
        ),
      );
    }

    return Scaffold(
      backgroundColor: KapdhColors.background,
      appBar: AppBar(
        title: Text(widget.title),
        leading: IconButton(
          tooltip: 'Batal',
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(_selected.values.toList()),
            child: Text('Selesai (${_selected.length})'),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s4, KapdhSpace.s3, KapdhSpace.s4, 0),
            child: TextField(
              controller: _search,
              onChanged: _onSearch,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => unawaited(_load()),
              decoration: const InputDecoration(
                hintText: 'Cari nama alumni (minimal 2 huruf)',
                prefixIcon: Icon(Icons.search),
                isDense: true,
              ),
            ),
          ),
          if (_selected.isNotEmpty)
            SizedBox(
              height: 56,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s2),
                children: [
                  for (final member in _selected.values)
                    Padding(
                      padding: const EdgeInsets.only(right: KapdhSpace.s2),
                      child: InputChip(
                        label: Text(member.fullName),
                        onDeleted: () => _toggle(member),
                        deleteButtonTooltipMessage: 'Hapus ${member.fullName}',
                      ),
                    ),
                ],
              ),
            ),
          Expanded(child: body),
        ],
      ),
    );
  }
}
