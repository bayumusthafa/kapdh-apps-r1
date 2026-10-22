import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_palette.dart';
import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/ui/profile_lists.dart';
import '../../../design/design.dart';

/// Batas keahlian per profil (kontrak C2 `skill_ids` maxItems 10).
const int maxSkills = 10;

/// Pemuat daftar master aktif (GET /masters/{kind}).
typedef MasterLoader = Future<List<MasterItem>> Function();

/// Lembar pilih profesi (Ubah Profil v2 "Pilih atau tambah…"): beberapa profesi (maksimal [maxProfessions]) dari master
/// AKTIF atau ketikan sendiri, urutan pilihan dipertahankan (yang pertama menjadi profesi utama dan ditandai pada
/// barisnya). Profesi yang sudah terpasang tetapi tidak ada di daftar aktif (ketikan sendiri atau master nonaktif)
/// tampil tercentang dan dapat dilepas. Mengembalikan daftar label baru, atau null bila lembar ditutup tanpa menyimpan.
Future<List<String>?> showProfessionsPicker(
  BuildContext context, {
  required MasterLoader load,
  required List<String> selected,
}) {
  return showModalBottomSheet<List<String>>(
    context: context,
    isScrollControlled: true,
    useRootNavigator: true,
    builder: (_) => _ProfessionSheet(load: load, initial: selected),
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
    builder: (_) => _SkillSheet(load: load, initial: selected),
  );
}

/// Memuat master aktif sekali per lembar, dengan galat yang dapat dicoba lagi.
mixin _MasterLoading<T extends StatefulWidget> on State<T> {
  MasterLoader get loader;

  List<MasterItem>? items;
  ApiException? error;

  Future<void> loadMasters() async {
    setState(() {
      error = null;
      items = null;
    });
    try {
      final loaded = await loader();
      if (mounted) setState(() => items = loaded);
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e);
    }
  }
}

class _SkillSheet extends StatefulWidget {
  const _SkillSheet({required this.load, required this.initial});

  final MasterLoader load;
  final List<MasterItem> initial;

  @override
  State<_SkillSheet> createState() => _SkillSheetState();
}

class _SkillSheetState extends State<_SkillSheet> with _MasterLoading {
  final _search = TextEditingController();
  late List<MasterItem> _selected = [...widget.initial];

  @override
  MasterLoader get loader => widget.load;

  @override
  void initState() {
    super.initState();
    unawaited(loadMasters());
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  bool _isSelected(MasterItem item) => _selected.any((s) => s.id == item.id);

  void _toggle(MasterItem item) {
    setState(() {
      if (_isSelected(item)) {
        _selected = _selected.where((s) => s.id != item.id).toList();
      } else if (_selected.length < maxSkills) {
        _selected = [..._selected, item];
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final query = _search.text.trim().toLowerCase();
    final items = this.items;
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
    final full = _selected.length >= maxSkills;

    return _PickerSheetFrame(
      title: 'Pilih keahlian',
      search: _search,
      onSearchChanged: () => setState(() {}),
      counter: full
          ? 'Maksimal $maxSkills keahlian. Lepas salah satu untuk memilih yang lain.'
          : 'Dipilih ${_selected.length} dari maksimal $maxSkills.',
      full: full,
      error: error,
      loading: items == null,
      onRetry: loadMasters,
      onDone: items == null ? null : () => Navigator.of(context).pop(_selected),
      children: [
        for (final item in historical)
          CheckboxListTile(
            key: ValueKey('master-${item.id}'),
            value: true,
            title: Text(item.label),
            subtitle: const Text('Tidak aktif lagi; dapat dilepas tetapi tidak dapat dipilih kembali.'),
            onChanged: (_) => _toggle(item),
          ),
        if (visible.isEmpty) const _NoMatch(),
        for (final item in visible)
          CheckboxListTile(
            key: ValueKey('master-${item.id}'),
            value: _isSelected(item),
            title: Text(item.label),
            onChanged: !_isSelected(item) && full ? null : (_) => _toggle(item),
          ),
      ],
    );
  }
}

class _ProfessionSheet extends StatefulWidget {
  const _ProfessionSheet({required this.load, required this.initial});

  final MasterLoader load;
  final List<String> initial;

  @override
  State<_ProfessionSheet> createState() => _ProfessionSheetState();
}

class _ProfessionSheetState extends State<_ProfessionSheet> with _MasterLoading {
  final _search = TextEditingController();
  late List<String> _selected = [...widget.initial];

  @override
  MasterLoader get loader => widget.load;

  @override
  void initState() {
    super.initState();
    unawaited(loadMasters());
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  static String _key(String label) => label.trim().toLowerCase();

  bool _isSelected(String label) => _selected.any((s) => _key(s) == _key(label));

  void _toggle(String label) {
    setState(() {
      if (_isSelected(label)) {
        _selected = _selected.where((s) => _key(s) != _key(label)).toList();
      } else if (_selected.length < maxProfessions) {
        _selected = [..._selected, label.trim()];
      }
    });
  }

  /// "Tambah …": ketikan sendiri menjadi profesi terpilih dan kotak cari dikosongkan.
  void _addTyped(String label) {
    _toggle(label);
    _search.clear();
  }

  /// Profesi utama (yang pertama dipilih) ditandai pada barisnya sendiri; keterangannya tidak lagi menambah tinggi
  /// bagian atas lembar.
  Widget? _primaryNote(String label) =>
      _selected.isNotEmpty && _key(_selected.first) == _key(label) ? const Text('Profesi utama') : null;

  @override
  Widget build(BuildContext context) {
    final typed = _search.text.trim();
    final query = typed.toLowerCase();
    final items = this.items;
    final activeKeys = {for (final item in items ?? const <MasterItem>[]) _key(item.label)};
    // Profesi terpasang di luar daftar aktif (ketikan sendiri, master nonaktif) tetap tampil agar dapat dilepas.
    final own = [
      for (final label in _selected)
        if (items != null && !activeKeys.contains(_key(label))) label,
    ];
    final visible = [
      for (final item in items ?? const <MasterItem>[])
        if (query.isEmpty || item.label.toLowerCase().contains(query)) item,
    ];
    final full = _selected.length >= maxProfessions;
    // Ketikan sendiri mengikuti aturan server ProfessionLabel: maksimal 100 unit UTF-16, tanpa karakter kontrol.
    final canAdd =
        items != null &&
        error == null &&
        typed.isNotEmpty &&
        typed.length <= 100 &&
        !hasControlCharacter(typed) &&
        !activeKeys.contains(query) &&
        !_isSelected(typed);

    return _PickerSheetFrame(
      title: 'Pilih profesi',
      search: _search,
      searchHint: 'Cari atau ketik profesi',
      onSearchChanged: () => setState(() {}),
      // "Tambah …" tepat di bawah kotak cari, bukan di dalam daftar: tetap terlihat saat keyboard terbuka.
      afterSearch: canAdd
          ? ListTile(
              key: const ValueKey('profession-add-typed'),
              leading: const Icon(KapdhIcons.add),
              title: Text('Tambah "$typed"'),
              subtitle: full ? const Text('Maksimal $maxProfessions profesi.') : null,
              enabled: !full,
              onTap: full ? null : () => _addTyped(typed),
            )
          : null,
      counter: full
          ? 'Maksimal $maxProfessions profesi. Lepas salah satu untuk memilih yang lain.'
          : 'Dipilih ${_selected.length} dari maksimal $maxProfessions.',
      full: full,
      error: error,
      loading: items == null,
      onRetry: loadMasters,
      onDone: items == null ? null : () => Navigator.of(context).pop(_selected),
      children: [
        for (final label in own)
          CheckboxListTile(
            key: ValueKey('profession-own-$label'),
            value: true,
            title: Text(label),
            subtitle: _primaryNote(label),
            onChanged: (_) => _toggle(label),
          ),
        if (visible.isEmpty && !canAdd) const _NoMatch(),
        for (final item in visible)
          CheckboxListTile(
            key: ValueKey('master-${item.id}'),
            value: _isSelected(item.label),
            title: Text(item.label),
            subtitle: _primaryNote(item.label),
            onChanged: !_isSelected(item.label) && full ? null : (_) => _toggle(item.label),
          ),
      ],
    );
  }
}

class _NoMatch extends StatelessWidget {
  const _NoMatch();

  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.all(KapdhSpace.s5),
    child: Text('Tidak ada pilihan yang cocok.', textAlign: TextAlign.center),
  );
}

/// Kerangka lembar pemilih: judul + tutup, kotak cari, baris [afterSearch], hitungan terpilih dan daftar (memuat/galat)
/// dalam satu gulungan, dengan tombol simpan tetap di bawah. Bagian atas ikut tergulir sehingga tidak pernah menghimpit
/// daftar sampai setinggi 0 pada layar kecil, teks besar (N-11) atau saat keyboard terbuka.
class _PickerSheetFrame extends StatelessWidget {
  const _PickerSheetFrame({
    required this.title,
    required this.search,
    required this.onSearchChanged,
    required this.counter,
    required this.full,
    required this.error,
    required this.loading,
    required this.onRetry,
    required this.onDone,
    required this.children,
    this.searchHint = 'Cari',
    this.afterSearch,
  });

  final String title;
  final TextEditingController search;
  final String searchHint;
  final VoidCallback onSearchChanged;

  /// Baris tepat di bawah kotak cari (profesi: "Tambah …" ketikan sendiri), mendahului hitungan dan daftar.
  final Widget? afterSearch;
  final String counter;
  final bool full;
  final ApiException? error;
  final bool loading;
  final Future<void> Function() onRetry;
  final VoidCallback? onDone;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final screenHeight = MediaQuery.sizeOf(context).height;
    final keyboard = MediaQuery.viewInsetsOf(context).bottom;
    // Jaga lembar tetap di atas keyboard; jarak atas tetap karena padding.top sudah dihapus rute lembar (useSafeArea: false).
    final height = math.min(screenHeight * 0.85, screenHeight - keyboard - KapdhSpace.s12);

    final Widget body;
    if (error case final failure?) {
      body = SliverToBoxAdapter(child: ErrorState.fromException(failure, onRetry: onRetry));
    } else if (loading) {
      body = const SliverToBoxAdapter(
        child: LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat pilihan'),
      );
    } else {
      body = SliverList.list(children: children);
    }

    return Padding(
      padding: EdgeInsets.only(bottom: keyboard),
      child: SafeArea(
        child: SizedBox(
          height: height,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: CustomScrollView(
                  slivers: [
                    SliverList.list(
                      children: [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s2, 0),
                          child: Row(
                            children: [
                              Expanded(
                                child: Semantics(
                                  header: true,
                                  child: Text(
                                    title,
                                    style: const TextStyle(fontSize: KapdhFontSize.h3, fontWeight: FontWeight.w600),
                                  ),
                                ),
                              ),
                              IconButton(
                                tooltip: 'Tutup',
                                icon: const Icon(KapdhIcons.close),
                                onPressed: () => Navigator.of(context).pop(),
                              ),
                            ],
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s5, vertical: KapdhSpace.s2),
                          child: TextField(
                            key: const ValueKey('master-search'),
                            controller: search,
                            contextMenuBuilder: kapdhTextContextMenu,
                            inputFormatters: [LengthLimitingTextInputFormatter(100)],
                            decoration: InputDecoration(
                              hintText: searchHint,
                              prefixIcon: const Icon(KapdhIcons.search),
                            ),
                            onChanged: (_) => onSearchChanged(),
                          ),
                        ),
                        ?afterSearch,
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s5),
                          child: Text(
                            counter,
                            style: TextStyle(
                              fontSize: KapdhFontSize.caption,
                              color: full ? context.kc.warning : context.kc.textMuted,
                            ),
                          ),
                        ),
                      ],
                    ),
                    body,
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s2, KapdhSpace.s5, KapdhSpace.s4),
                child: KapdhButton.solid(
                  key: const ValueKey('master-done'),
                  label: 'Simpan pilihan',
                  onPressed: onDone,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
