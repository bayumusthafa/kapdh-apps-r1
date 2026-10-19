import 'package:flutter/material.dart';

import '../../../app/theme/kapdh_palette.dart';
import '../../../app/theme/kapdh_tokens.dart';
import '../../../design/kapdh_icons.dart';

enum TagChipTone {
  /// Hijau muda: keahlian di kartu direktori dan profesi di profil (guideline hal. 7).
  green,

  /// Biru muda: keahlian di profil (guideline hal. 7).
  blue,

  /// Netral: filter aktif.
  neutral,
}

/// Label kecil berbentuk pil untuk profesi/keahlian (guideline hal. 7). Master yang sudah dinonaktifkan tetap
/// tampil sebagai label historis (AC F10-4).
class TagChip extends StatelessWidget {
  const TagChip({super.key, required this.label, this.tone = TagChipTone.green, this.onDeleted, this.deleteTooltip});

  final String label;
  final TagChipTone tone;

  /// Bila diisi, chip menampilkan tombol hapus (chip filter aktif).
  final VoidCallback? onDeleted;
  final String? deleteTooltip;

  @override
  Widget build(BuildContext context) {
    final (Color fg, Color bg) = switch (tone) {
      TagChipTone.green => (context.kc.success, context.kc.successBg),
      TagChipTone.blue => (context.kc.info, context.kc.infoBg),
      TagChipTone.neutral => (context.kc.neutral, context.kc.neutralBg),
    };
    final text = Text(
      label,
      style: TextStyle(fontSize: KapdhFontSize.overline, fontWeight: FontWeight.w500, color: fg),
    );
    if (onDeleted == null) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s2, vertical: 3),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(KapdhRadius.sm)),
        child: text,
      );
    }
    return InputChip(
      label: text,
      backgroundColor: bg,
      side: BorderSide.none,
      deleteIcon: Icon(KapdhIcons.close, size: 16, color: fg),
      deleteButtonTooltipMessage: deleteTooltip ?? 'Hapus filter $label',
      onDeleted: onDeleted,
      // Seluruh chip menghapus filter: ikon silang 16 px saja hanya punya area ketuk sekitar 32 x 40 dp. Kepadatan
      // standar + target padded memberi area ketuk setinggi 48 dp selebar chip.
      onPressed: onDeleted,
      materialTapTargetSize: MaterialTapTargetSize.padded,
    );
  }
}
