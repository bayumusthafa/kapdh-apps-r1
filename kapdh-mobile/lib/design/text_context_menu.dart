import 'package:flutter/material.dart';

/// Menu seleksi teks aplikasi (potong, salin, tempel, pilih semua, bagikan) tanpa aksi aplikasi lain.
///
/// Android menambahkan aksi "process text" dari aplikasi lain yang terpasang di perangkat (mis. penerjemah) ke menu
/// seleksi, dan Flutter menampilkannya sebagai [ContextMenuButtonType.custom]. Isi formulir aplikasi (email, data
/// profil, alasan pembatalan, pesan chat) tidak boleh dikirim ke aplikasi lain lewat menu itu, jadi hanya tombol
/// bawaan yang dipertahankan. Dipasang sebagai `contextMenuBuilder` pada setiap TextField, TextFormField dan
/// SelectableText (dijaga uji `test/design/text_context_menu_test.dart`).
Widget kapdhTextContextMenu(BuildContext context, EditableTextState editableTextState) =>
    AdaptiveTextSelectionToolbar.buttonItems(
      anchors: editableTextState.contextMenuAnchors,
      buttonItems: kapdhContextMenuItems(editableTextState.contextMenuButtonItems),
    );

/// Tombol menu seleksi tanpa aksi aplikasi lain ([ContextMenuButtonType.custom]).
List<ContextMenuButtonItem> kapdhContextMenuItems(List<ContextMenuButtonItem> items) => [
  for (final item in items)
    if (item.type != ContextMenuButtonType.custom) item,
];
