import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import '../home/shared/member_gate.dart';
import '../home/shared/paged_list.dart';
import 'events_controllers.dart';
import 'widgets/event_card.dart';

/// Daftar Event (F-09; guideline hal. 8): pencarian "Cari event", tab kategori "Semua | Reuni | Workshop" dari
/// server, pilihan Mendatang/Lampau, kartu event dengan label pendaftaran, keadaan memuat/kosong/galat. Hanya
/// anggota aktif (kontrak C5, PRD 2.2).
class EventsScreen extends ConsumerStatefulWidget {
  const EventsScreen({super.key});

  @override
  ConsumerState<EventsScreen> createState() => _EventsScreenState();
}

class _EventsScreenState extends ConsumerState<EventsScreen> {
  final _search = TextEditingController();
  Timer? _debounce;
  String? _categoryId;
  EventListPeriod _period = EventListPeriod.upcoming;
  String _query = '';

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () => _applyQuery(value));
  }

  void _applyQuery(String value) {
    _debounce?.cancel();
    final trimmed = value.trim();
    // Kontrak: q 1..100 karakter.
    final next = trimmed.length > 100 ? trimmed.substring(0, 100) : trimmed;
    if (next != _query && mounted) setState(() => _query = next);
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(sessionProvider.select((session) => session.effectiveStatus));
    final ticketsAction = IconButton(
      key: const ValueKey('events-my-tickets'),
      tooltip: 'Tiket Saya',
      icon: const Icon(Icons.confirmation_number_outlined),
      onPressed: () => unawaited(context.push(AppRoutes.tickets)),
    );
    if (!isActiveMember(status)) {
      // Hanya sesaat sebelum router mengalihkan status nonaktif (tab Event terkunci, PRD 2.2): tanpa request daftar.
      // Tiket lunas anggota expired dibuka lewat Beranda atau lembar tab terkunci.
      return AppScaffold(
        title: 'Event',
        showBack: false,
        body: MemberOnlyNotice(feature: 'Event', status: status),
      );
    }
    final EventQuery query = (categoryId: _categoryId, period: _period, query: _query);
    final provider = eventsControllerProvider(query);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final filtered = _query.isNotEmpty || _categoryId != null;
    return AppScaffold(
      title: 'Event',
      showBack: false,
      actions: [ticketsAction],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            color: KapdhColors.surface,
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s3, KapdhSpace.s5, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _SearchField(
                  controller: _search,
                  onChanged: _onSearchChanged,
                  onSubmitted: _applyQuery,
                  onClear: () {
                    _search.clear();
                    _applyQuery('');
                  },
                ),
                _CategoryTabs(selected: _categoryId, onSelected: (id) => setState(() => _categoryId = id)),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s3, KapdhSpace.s5, 0),
            child: SegmentedButton<EventListPeriod>(
              segments: const [
                ButtonSegment(value: EventListPeriod.upcoming, label: Text('Mendatang')),
                ButtonSegment(value: EventListPeriod.past, label: Text('Lampau')),
              ],
              selected: {_period},
              showSelectedIcon: false,
              onSelectionChanged: (value) => setState(() => _period = value.first),
            ),
          ),
          Expanded(
            child: PagedListView(
              key: ValueKey('events-$query'),
              state: state,
              loadingSemantics: 'Memuat event',
              onRefresh: controller.refresh,
              onLoadMore: () => unawaited(controller.loadMore()),
              itemBuilder: (context, event) =>
                  EventCard.summary(event, onTap: () => unawaited(context.push(AppRoutes.event(event.id)))),
              empty: EmptyState(
                icon: Icons.event_busy_outlined,
                title: filtered
                    ? 'Event tidak ditemukan'
                    : (_period == EventListPeriod.upcoming ? 'Belum ada event mendatang' : 'Belum ada event lampau'),
                message: filtered
                    ? 'Coba kata kunci atau kategori lain.'
                    : 'Event dari pengurus akan tampil di sini. Anda juga mendapat notifikasi saat event baru dibuka.',
                actionLabel: filtered ? 'Hapus filter' : 'Muat ulang',
                onAction: filtered
                    ? () {
                        _search.clear();
                        setState(() {
                          _query = '';
                          _categoryId = null;
                        });
                      }
                    : () => unawaited(controller.refresh()),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SearchField extends StatelessWidget {
  const _SearchField({
    required this.controller,
    required this.onChanged,
    required this.onSubmitted,
    required this.onClear,
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final ValueChanged<String> onSubmitted;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: controller,
      builder: (context, value, _) => TextField(
        key: const ValueKey('events-search'),
        controller: controller,
        onChanged: onChanged,
        onSubmitted: onSubmitted,
        maxLength: 100,
        textInputAction: TextInputAction.search,
        decoration: InputDecoration(
          hintText: 'Cari event…',
          counterText: '',
          prefixIcon: const Icon(Icons.search),
          isDense: true,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
          suffixIcon: value.text.isEmpty
              ? null
              : IconButton(tooltip: 'Hapus pencarian', icon: const Icon(Icons.close), onPressed: onClear),
        ),
      ),
    );
  }
}

/// Tab kategori bergaris bawah (guideline hal. 8): "Semua" dibuat klien, sisanya kategori event aktif dari server.
/// Gagal memuat kategori: hanya "Semua" (daftar tetap dapat dibuka).
class _CategoryTabs extends ConsumerWidget {
  const _CategoryTabs({required this.selected, required this.onSelected});

  final String? selected;
  final ValueChanged<String?> onSelected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final categories = ref.watch(eventCategoriesProvider).value ?? const <EventCategoryRef>[];
    Widget tab(String label, String? id) {
      final active = selected == id;
      return Semantics(
        selected: active,
        button: true,
        child: InkWell(
          onTap: () => onSelected(id),
          child: Container(
            constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
            padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s3),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: active ? KapdhColors.primary : Colors.transparent, width: 2)),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                color: active ? KapdhColors.primary : KapdhColors.textMuted,
              ),
            ),
          ),
        ),
      );
    }

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(children: [tab('Semua', null), for (final category in categories) tab(category.label, category.id)]),
    );
  }
}
