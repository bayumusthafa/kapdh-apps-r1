import 'dart:async';

import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../design/design.dart';

/// Batas keahlian per profil (kontrak C2 `skill_ids` maxItems 10).
const int maxSkills = 10;

/// Pemuat daftar master aktif (GET /masters/{kind}).
typedef MasterLoader = Future<List<MasterItem>> Function();

/// Hasil pemilih profesi: [item] null berarti "tanpa profesi".
@immutable
class ProfessionChoice {
  const ProfessionChoice(this.item);

  final MasterItem? item;
}

/// Lembar pilih satu profesi dari master AKTIF (AC F10-4). Profesi nonaktif yang sudah terpasang tetap tampil
/// sebagai label historis di formulir tetapi tidak dapat dipilih baru.
Future<ProfessionChoice?> showProfessionPicker(
  BuildContext context, {
  required MasterLoader load,
  required MasterItem? selected,
}) {
  return showModalBottomSheet<ProfessionChoice>(
    context: context,
    isScrollControlled: true,
    useRootNavigator: true,
    builder: (_) => _MasterSheet(
      title: 'Pilih profesi',
      load: load,
      multi: false,
      initial: [?selected],
      onDone: (context, items) => Navigator.of(context).pop(ProfessionChoice(items.isEmpty ? null : items.first)),
    ),
  );
}

/// Lembar pilih keahlian (maksimal [maxSkills]) dari master AKTIF. Keahlian nonaktif yang sudah terpasang tampil
/// dengan label "tidak aktif" dan dapat dilepas, tetapi tidak dapat dipilih lagi setelah dilepas (AC F10-4).
Future<List<MasterItem>?> showSkillsPicker(
  BuildContext context, {
  required MasterLoader load,
  required List<MasterItem> selected,
}) {
  return showModalBottomSheet<List<MasterItem>>(
    context: context,
    isScrollControlled: true,
    useRootNavigator: true,
    builder: (_) => _MasterSheet(
      title: 'Pilih keahlian',
      load: load,
      multi: true,
      initial: selected,
      onDone: (context, items) => Navigator.of(context).pop(items),
    ),
  );
}

class _MasterSheet extends StatefulWidget {
  const _MasterSheet({
    required this.title,
    required this.load,
    required this.multi,
    required this.initial,
    required this.onDone,
  });

  final String title;
  final MasterLoader load;
  final bool multi;
  final List<MasterItem> initial;
  final void Function(BuildContext context, List<MasterItem> items) onDone;

  @override
  State<_MasterSheet> createState() => _MasterSheetState();
}

class _MasterSheetState extends State<_MasterSheet> {
  final _search = TextEditingController();
  List<MasterItem>? _items;
  ApiException? _error;
  late List<MasterItem> _selected = [...widget.initial];

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _error = null;
      _items = null;
    });
    try {
      final items = await widget.load();
      if (mounted) setState(() => _items = items);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  bool _isSelected(MasterItem item) => _selected.any((s) => s.id == item.id);

  void _toggle(MasterItem item) {
    setState(() {
      if (!widget.multi) {
        _selected = [item];
      } else if (_isSelected(item)) {
        _selected = _selected.where((s) => s.id != item.id).toList();
      } else if (_selected.length < maxSkills) {
        _selected = [..._selected, item];
      }
    });
    if (!widget.multi) widget.onDone(context, _selected);
  }

  @override
  Widget build(BuildContext context) {
    final query = _search.text.trim().toLowerCase();
    final items = _items;
    final activeIds = {for (final item in items ?? const <MasterItem>[]) item.id};
    // Pilihan yang sudah nonaktif (tidak ada di daftar aktif) hanya ditampilkan bila sedang terpilih.
    final historical = [
      for (final item in _selected)
        if (items != null && !activeIds.contains(item.id)) item,
    ];
    final visible = [
      for (final item in items ?? const <MasterItem>[])
        if (query.isEmpty || item.label.toLowerCase().contains(query)) item,
    ];
    final full = widget.multi && _selected.length >= maxSkills;
    final height = MediaQuery.sizeOf(context).height * 0.85;

    Widget body;
    if (_error != null) {
      body = ErrorState.fromException(_error!, onRetry: _load);
    } else if (items == null) {
      body = const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat pilihan');
    } else {
      body = ListView(
        children: [
          if (!widget.multi)
            _SingleTile(
              key: const ValueKey('master-none'),
              label: 'Tanpa profesi',
              selected: _selected.isEmpty,
              onTap: () {
                setState(() => _selected = []);
                widget.onDone(context, const []);
              },
            ),
          for (final item in historical)
            CheckboxListTile(
              key: ValueKey('master-${item.id}'),
              value: true,
              title: Text(item.label),
              subtitle: const Text('Tidak aktif lagi; dapat dilepas tetapi tidak dapat dipilih kembali.'),
              onChanged: (_) => _toggle(item),
            ),
          if (visible.isEmpty)
            const Padding(
              padding: EdgeInsets.all(KapdhSpace.s5),
              child: Text('Tidak ada pilihan yang cocok.', textAlign: TextAlign.center),
            ),
          for (final item in visible)
            widget.multi
                ? CheckboxListTile(
                    key: ValueKey('master-${item.id}'),
                    value: _isSelected(item),
                    title: Text(item.label),
                    onChanged: !_isSelected(item) && full ? null : (_) => _toggle(item),
                  )
                : _SingleTile(
                    key: ValueKey('master-${item.id}'),
                    label: item.label,
                    selected: _isSelected(item),
                    onTap: () => _toggle(item),
                  ),
        ],
      );
    }

    return SafeArea(
      child: SizedBox(
        height: height,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s2, 0),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        widget.title,
                        style: const TextStyle(fontSize: KapdhFontSize.h3, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Tutup',
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s5, vertical: KapdhSpace.s2),
              child: TextField(
                controller: _search,
                decoration: const InputDecoration(hintText: 'Cari', prefixIcon: Icon(Icons.search)),
                onChanged: (_) => setState(() {}),
              ),
            ),
            if (widget.multi)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s5),
                child: Text(
                  full
                      ? 'Maksimal $maxSkills keahlian. Lepas salah satu untuk memilih yang lain.'
                      : 'Dipilih ${_selected.length} dari maksimal $maxSkills.',
                  style: TextStyle(
                    fontSize: KapdhFontSize.caption,
                    color: full ? KapdhColors.warning : KapdhColors.textMuted,
                  ),
                ),
              ),
            Expanded(child: body),
            if (widget.multi)
              Padding(
                padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s2, KapdhSpace.s5, KapdhSpace.s4),
                child: KapdhButton.solid(
                  key: const ValueKey('master-done'),
                  label: 'Simpan pilihan',
                  onPressed: items == null ? null : () => widget.onDone(context, _selected),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Baris pilihan tunggal: tanda centang + status terpilih untuk pembaca layar (tanpa Radio yang bergantung grup).
class _SingleTile extends StatelessWidget {
  const _SingleTile({super.key, required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: selected,
      button: true,
      child: ListTile(
        title: Text(label),
        selected: selected,
        selectedColor: KapdhColors.primary,
        trailing: selected ? const Icon(Icons.check, color: KapdhColors.primary) : null,
        onTap: onTap,
      ),
    );
  }
}
