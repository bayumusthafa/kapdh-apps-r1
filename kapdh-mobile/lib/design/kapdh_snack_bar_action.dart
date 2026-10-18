import 'package:flutter/material.dart';

import '../app/theme/kapdh_focus.dart';
import '../app/theme/kapdh_tokens.dart';

/// Aksi snackbar bercincin fokus emas (permukaan gelap, --color-focus-ring-on-dark). SnackBar membungkus aksinya
/// dengan TextButtonTheme sendiri yang menggantikan textButtonTheme aplikasi, sehingga garis fokus dari
/// [KapdhFocusTheme.withRing] hilang; kelas ini memasang ulang cincin 3 px di atas [SnackBarAction] biasa (yang tetap
/// menangani tutup snackbar, cegah ketuk ganda dan warna aksi tema).
class KapdhSnackBarAction extends SnackBarAction {
  const KapdhSnackBarAction({super.key, required super.label, required super.onPressed});

  @override
  State<SnackBarAction> createState() => _KapdhSnackBarActionState();
}

class _KapdhSnackBarActionState extends State<SnackBarAction> {
  @override
  Widget build(BuildContext context) {
    final style = TextButtonTheme.of(context).style ?? const ButtonStyle();
    return TextButtonTheme(
      data: TextButtonThemeData(
        style: style.copyWith(
          side: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.focused)
                ? const BorderSide(color: KapdhColors.focusRingOnDark, width: KapdhFocusTheme.width)
                : null,
          ),
        ),
      ),
      child: SnackBarAction(label: widget.label, onPressed: widget.onPressed),
    );
  }
}
