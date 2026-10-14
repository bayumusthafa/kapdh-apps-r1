import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../design/design.dart';
import '../membership/academic.dart';
import 'directory_filter.dart';
import 'network_repository.dart';

/// Membuka lembar filter direktori (F-10): angkatan, kelas, kota, profesi, keahlian dan urutan. Mengembalikan
/// filter baru, atau null bila ditutup tanpa diterapkan.
Future<DirectoryFilter?> showDirectoryFilterSheet(BuildContext context, DirectoryFilter current) =>
    showModalBottomSheet<DirectoryFilter>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => DirectoryFilterSheet(initial: current),
    );

/// Isi lembar filter. Profesi dan keahlian memakai master AKTIF dari GET /masters/{kind} (AC F10-4); filter yang
/// sudah terpilih tetap ditampilkan walaupun masternya sudah nonaktif.
class DirectoryFilterSheet extends ConsumerStatefulWidget {
  const DirectoryFilterSheet({super.key, required this.initial});

  final DirectoryFilter initial;

  @override
  ConsumerState<DirectoryFilterSheet> createState() => _DirectoryFilterSheetState();
}

class _DirectoryFilterSheetState extends ConsumerState<DirectoryFilterSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _cohort = TextEditingController(text: widget.initial.cohort?.toString() ?? '');
  late final TextEditingController _city = TextEditingController(text: widget.initial.city ?? '');
  late int? _classLevel = widget.initial.classLevel;
  late MasterItem? _profession = widget.initial.profession;
  late MasterItem? _skill = widget.initial.skill;
  late DirectorySort _sort = widget.initial.sort;

  @override
  void dispose() {
    _cohort.dispose();
    _city.dispose();
    super.dispose();
  }

  void _reset() {
    setState(() {
      _cohort.clear();
      _city.clear();
      _classLevel = null;
      _profession = null;
      _skill = null;
      _sort = DirectorySort.nameAsc;
    });
  }

  void _apply() {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final city = _city.text.trim();
    Navigator.of(context).pop(
      DirectoryFilter(
        cohort: int.tryParse(_cohort.text.trim()),
        classLevel: _classLevel,
        city: city.isEmpty ? null : city,
        profession: _profession,
        skill: _skill,
        sort: _sort,
      ),
    );
  }

  String? _validateCohort(String? raw) {
    final text = raw?.trim() ?? '';
    if (text.isEmpty) return null;
    final value = int.tryParse(text);
    if (value == null || value < 1 || value > 99) return 'Angkatan 1 sampai 99';
    return null;
  }

  /// Daftar master untuk dropdown; master terpilih yang tidak lagi aktif tetap dimuat sebagai pilihan.
  List<DropdownMenuItem<String>> _masterItems(List<MasterItem> items, MasterItem? selected) => [
    const DropdownMenuItem<String>(value: '', child: Text('Semua')),
    for (final item in items) DropdownMenuItem<String>(value: item.id, child: Text(item.label)),
    if (selected != null && !items.any((item) => item.id == selected.id))
      DropdownMenuItem<String>(value: selected.id, child: Text(selected.label)),
  ];

  MasterItem? _pick(List<MasterItem> items, MasterItem? selected, String? id) {
    if (id == null || id.isEmpty) return null;
    for (final item in items) {
      if (item.id == id) return item;
    }
    return selected?.id == id ? selected : null;
  }

  Widget _masterField({
    required String label,
    required MasterKind kind,
    required MasterItem? selected,
    required ValueChanged<MasterItem?> onChanged,
  }) {
    final masters = ref.watch(directoryMastersProvider(kind));
    return masters.when(
      data: (items) => KapdhDropdownField<String>(
        key: ValueKey('filter-${kind.value}-${selected?.id}'),
        label: label,
        value: selected?.id ?? '',
        items: _masterItems(items, selected),
        onChanged: (id) => onChanged(_pick(items, selected, id)),
      ),
      loading: () => Padding(
        padding: const EdgeInsets.symmetric(vertical: KapdhSpace.s3),
        child: Text('Memuat daftar ${label.toLowerCase()}…', style: const TextStyle(color: KapdhColors.textMuted)),
      ),
      error: (_, _) => InfoBox(
        tone: InfoBoxTone.warning,
        message: 'Daftar ${label.toLowerCase()} belum dapat dimuat.',
        trailing: TextButton(
          onPressed: () => ref.invalidate(directoryMastersProvider(kind)),
          child: const Text('Coba lagi'),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: bottomInset),
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, 0, KapdhSpace.s5, KapdhSpace.s5),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Semantics(
                        header: true,
                        child: const Text(
                          'Filter Alumni',
                          style: TextStyle(fontSize: KapdhFontSize.h3, fontWeight: FontWeight.w600),
                        ),
                      ),
                    ),
                    TextButton(onPressed: _reset, child: const Text('Atur ulang')),
                  ],
                ),
                const SizedBox(height: KapdhSpace.s3),
                KapdhTextField(
                  label: 'Angkatan',
                  controller: _cohort,
                  hint: 'Contoh: 29',
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(2)],
                  validator: _validateCohort,
                ),
                const SizedBox(height: KapdhSpace.s4),
                KapdhDropdownField<int>(
                  label: 'Kelas',
                  value: _classLevel ?? 0,
                  items: [
                    const DropdownMenuItem<int>(value: 0, child: Text('Semua')),
                    for (var level = 1; level <= 6; level++)
                      DropdownMenuItem<int>(value: level, child: Text(classLabel(level))),
                  ],
                  onChanged: (value) => setState(() => _classLevel = value == null || value == 0 ? null : value),
                ),
                const SizedBox(height: KapdhSpace.s4),
                KapdhTextField(
                  label: 'Kota',
                  controller: _city,
                  hint: 'Contoh: Pekanbaru',
                  textCapitalization: TextCapitalization.words,
                  inputFormatters: [LengthLimitingTextInputFormatter(80)],
                ),
                const SizedBox(height: KapdhSpace.s4),
                _masterField(
                  label: 'Profesi',
                  kind: MasterKind.professions,
                  selected: _profession,
                  onChanged: (value) => setState(() => _profession = value),
                ),
                const SizedBox(height: KapdhSpace.s4),
                _masterField(
                  label: 'Keahlian',
                  kind: MasterKind.skills,
                  selected: _skill,
                  onChanged: (value) => setState(() => _skill = value),
                ),
                const SizedBox(height: KapdhSpace.s4),
                const Text(
                  'Urutkan',
                  style: TextStyle(fontSize: KapdhFontSize.label, fontWeight: FontWeight.w500),
                ),
                RadioGroup<DirectorySort>(
                  groupValue: _sort,
                  onChanged: (value) => setState(() => _sort = value ?? DirectorySort.nameAsc),
                  child: const Column(
                    children: [
                      RadioListTile<DirectorySort>(
                        value: DirectorySort.nameAsc,
                        contentPadding: EdgeInsets.zero,
                        title: Text('Nama A–Z'),
                      ),
                      RadioListTile<DirectorySort>(
                        value: DirectorySort.cohortDesc,
                        contentPadding: EdgeInsets.zero,
                        title: Text('Angkatan terbaru'),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: KapdhSpace.s4),
                KapdhButton(label: 'Terapkan', icon: Icons.check, onPressed: _apply),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
