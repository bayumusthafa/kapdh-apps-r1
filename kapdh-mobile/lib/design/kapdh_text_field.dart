import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_theme.dart';
import '../app/theme/kapdh_tokens.dart';
import 'kapdh_icons.dart';
import 'text_context_menu.dart';

/// Label di atas field (guideline hal. 5: "Email", "Password", "Jenis Kelamin"). Teks label visual dikecualikan dari
/// semantics dan dipasang sebagai label field, sehingga pembaca layar membacakan "Email, kolom teks" satu kali
/// sementara tombol di dalam field (tampilkan sandi) tetap dapat dioperasikan terpisah (N-11). [visible] false
/// menyembunyikan teks visual (mis. baris tautan yang sudah berlabel pemilih platform) tetapi label pembaca layar tetap.
class _LabelAbove extends StatelessWidget {
  const _LabelAbove({required this.label, required this.child, this.requiredMark = false, this.visible = true});

  final String label;
  final Widget child;
  final bool requiredMark;
  final bool visible;

  @override
  Widget build(BuildContext context) {
    if (!visible) return Semantics(label: requiredMark ? '$label, wajib' : label, child: child);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        ExcludeSemantics(
          child: Text.rich(
            TextSpan(
              text: label,
              children: [
                if (requiredMark)
                  TextSpan(
                    text: ' *',
                    style: TextStyle(color: context.kc.danger),
                  ),
              ],
            ),
            style: TextStyle(fontSize: KapdhFontSize.label, fontWeight: FontWeight.w500, color: context.kc.text),
          ),
        ),
        const SizedBox(height: KapdhSpace.s2),
        Semantics(label: requiredMark ? '$label, wajib' : label, child: child),
      ],
    );
  }
}

/// Field teks KAPDH dengan label di atas, ikon awalan, petunjuk, galat server per field dan teks penghitung di kanan
/// (guideline hal. 5 "0/8"). [obscurable] menambahkan tombol tampil/sembunyikan untuk sandi.
class KapdhTextField extends StatefulWidget {
  const KapdhTextField({
    super.key,
    required this.label,
    this.controller,
    this.hint,
    this.prefixIcon,
    this.errorText,
    this.helperText,
    this.trailingText,
    this.trailingTextColor,
    this.obscurable = false,
    this.keyboardType,
    this.textInputAction,
    this.autofillHints,
    this.inputFormatters,
    this.textCapitalization = TextCapitalization.none,
    this.onChanged,
    this.onSubmitted,
    this.validator,
    this.enabled = true,
    this.autofocus = false,
    this.maxLines = 1,
    this.minLines,
    this.requiredMark = false,
    this.focusNode,
    this.labelVisible = true,
  });

  final String label;
  final TextEditingController? controller;
  final String? hint;
  final IconData? prefixIcon;

  /// Galat dari server (field_errors) atau validasi lokal; ditampilkan di bawah field dengan warna bahaya.
  final String? errorText;
  final String? helperText;

  /// Teks kecil di sisi kanan field, mis. penghitung byte sandi.
  final String? trailingText;
  final Color? trailingTextColor;
  final bool obscurable;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final Iterable<String>? autofillHints;
  final List<TextInputFormatter>? inputFormatters;
  final TextCapitalization textCapitalization;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final FormFieldValidator<String>? validator;
  final bool enabled;
  final bool autofocus;
  final int maxLines;

  /// Jumlah baris minimum untuk field multibaris. Bila diisi lebih kecil dari [maxLines], tinggi kotak tumbuh
  /// mengikuti isi dari [minLines] sampai [maxLines] baris; null (bawaan) mempertahankan tinggi tetap [maxLines].
  final int? minLines;
  final bool requiredMark;
  final FocusNode? focusNode;

  /// false: [label] hanya untuk pembaca layar (tanpa teks di atas field).
  final bool labelVisible;

  @override
  State<KapdhTextField> createState() => _KapdhTextFieldState();
}

class _KapdhTextFieldState extends State<KapdhTextField> {
  bool _obscured = true;

  @override
  Widget build(BuildContext context) {
    final trailing = widget.trailingText;
    final suffix = <Widget>[
      if (trailing != null)
        Padding(
          padding: const EdgeInsets.only(right: KapdhSpace.s1),
          child: ExcludeSemantics(
            child: Text(
              trailing,
              style: TextStyle(
                fontSize: KapdhFontSize.caption,
                color: widget.trailingTextColor ?? context.kc.textMuted,
              ),
            ),
          ),
        ),
      if (widget.obscurable)
        IconButton(
          tooltip: _obscured ? 'Tampilkan password' : 'Sembunyikan password',
          icon: Icon(_obscured ? KapdhIcons.visibilityOffOutlined : KapdhIcons.visibilityOutlined),
          onPressed: () => setState(() => _obscured = !_obscured),
        ),
    ];

    return _LabelAbove(
      label: widget.label,
      requiredMark: widget.requiredMark,
      visible: widget.labelVisible,
      child: TextFormField(
        controller: widget.controller,
        contextMenuBuilder: kapdhTextContextMenu,
        focusNode: widget.focusNode,
        enabled: widget.enabled,
        autofocus: widget.autofocus,
        obscureText: widget.obscurable && _obscured,
        enableSuggestions: !widget.obscurable,
        autocorrect: !widget.obscurable,
        keyboardType: widget.keyboardType,
        textInputAction: widget.textInputAction,
        autofillHints: widget.autofillHints,
        inputFormatters: widget.inputFormatters,
        textCapitalization: widget.textCapitalization,
        maxLines: widget.obscurable ? 1 : widget.maxLines,
        minLines: widget.obscurable ? null : widget.minLines,
        onChanged: widget.onChanged,
        onFieldSubmitted: widget.onSubmitted,
        validator: widget.validator,
        style: TextStyle(fontSize: KapdhFontSize.body, color: context.kc.text),
        decoration: InputDecoration(
          hintText: widget.hint,
          errorText: widget.errorText,
          helperText: widget.helperText,
          prefixIcon: widget.prefixIcon == null ? null : Icon(widget.prefixIcon, size: KapdhIconSize.md),
          suffixIcon: suffix.isEmpty
              ? null
              : Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    ...suffix,
                    const SizedBox(width: KapdhSpace.s1),
                  ],
                ),
        ),
      ),
    );
  }
}

/// Dropdown KAPDH dengan label di atas (guideline hal. 5: "Jenis Kelamin", "Angkatan", "Kelas Masuk").
class KapdhDropdownField<T> extends StatelessWidget {
  const KapdhDropdownField({
    super.key,
    required this.label,
    required this.items,
    required this.value,
    required this.onChanged,
    this.hint,
    this.errorText,
    this.validator,
    this.requiredMark = false,
    this.helperText,
    this.labelVisible = true,
  });

  final String label;
  final List<DropdownMenuItem<T>> items;
  final T? value;
  final ValueChanged<T?>? onChanged;
  final String? hint;
  final String? errorText;
  final FormFieldValidator<T>? validator;
  final bool requiredMark;
  final String? helperText;

  /// false: [label] hanya untuk pembaca layar (tanpa teks di atas field).
  final bool labelVisible;

  @override
  Widget build(BuildContext context) {
    return _LabelAbove(
      label: label,
      requiredMark: requiredMark,
      visible: labelVisible,
      child: DropdownButtonFormField<T>(
        initialValue: value,
        items: items,
        onChanged: onChanged,
        validator: validator,
        isExpanded: true,
        icon: const Icon(KapdhIcons.keyboardArrowDown),
        iconEnabledColor: context.kc.text,
        dropdownColor: context.kc.surfaceRaised,
        borderRadius: BorderRadius.circular(KapdhRadius.md),
        elevation: 3,
        style: KapdhTheme.font(fontSize: KapdhFontSize.body, color: context.kc.text),
        decoration: InputDecoration(hintText: hint, errorText: errorText, helperText: helperText),
      ),
    );
  }
}
