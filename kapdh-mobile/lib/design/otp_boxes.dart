import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../app/theme/kapdh_tokens.dart';
import 'design_constants.dart';
import 'kapdh_button.dart';

/// Digit pertama sebanyak [length] dari teks tempelan ("Kode Anda: 482 913" menjadi "482913").
String otpDigits(String text, int length) {
  final digits = text.replaceAll(RegExp(r'[^0-9]'), '');
  return digits.length > length ? digits.substring(0, length) : digits;
}

/// Formatter OTP: hanya digit, maksimal [length]. Tempelan seperti "Kode Anda: 482 913" menjadi "482913". Tempelan
/// yang memuat kode lengkap MENGGANTI isi lama (mis. kotak sudah terisi kode yang salah), bukan disisipkan lalu
/// terpotong sehingga kode lama yang tersisa.
class OtpInputFormatter extends TextInputFormatter {
  const OtpInputFormatter(this.length);

  final int length;

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final inserted = _insertedText(oldValue.text, newValue.text);
    final insertedDigits = inserted.replaceAll(RegExp(r'[^0-9]'), '');
    if (oldValue.text.isNotEmpty && insertedDigits.length >= length) {
      final code = insertedDigits.substring(0, length);
      return TextEditingValue(
        text: code,
        selection: TextSelection.collapsed(offset: code.length),
      );
    }
    final digits = newValue.text.replaceAll(RegExp(r'[^0-9]'), '');
    final clipped = digits.length > length ? digits.substring(0, length) : digits;
    return TextEditingValue(
      text: clipped,
      selection: TextSelection.collapsed(offset: clipped.length),
    );
  }

  /// Bagian yang ditambahkan dari [before] ke [after] (di antara awalan dan akhiran yang sama).
  static String _insertedText(String before, String after) {
    var start = 0;
    while (start < before.length && start < after.length && before[start] == after[start]) {
      start++;
    }
    var end = 0;
    while (end < before.length - start &&
        end < after.length - start &&
        before[before.length - 1 - end] == after[after.length - 1 - end]) {
      end++;
    }
    return after.substring(start, after.length - end);
  }
}

/// Masukan kode OTP enam kotak (prototipe layar 1; AC F01-2, F01-3).
///
/// Satu field teks tak terlihat menerima ketikan, tempel (menu tekan lama, saran papan klip keyboard) dan isi otomatis
/// `oneTimeCode`; kotak hanya tampilan. Tombol "Tempel kode" di bawah kotak membaca papan klip langsung karena menu
/// tempel pada field tak terlihat sulit ditemukan pengguna.
/// Kotak terisi bergaris hijau 2 px, kotak aktif emas, kosong abu 1 px; galat membuat semua kotak merah.
class OtpBoxes extends StatefulWidget {
  const OtpBoxes({
    super.key,
    required this.controller,
    this.length = 6,
    this.onChanged,
    this.onCompleted,
    this.errorText,
    this.enabled = true,
    this.autofocus = false,
    this.focusNode,
    this.showPasteButton = true,
  });

  final TextEditingController controller;
  final int length;
  final ValueChanged<String>? onChanged;

  /// Dipanggil saat semua digit terisi.
  final ValueChanged<String>? onCompleted;
  final String? errorText;
  final bool enabled;
  final bool autofocus;
  final FocusNode? focusNode;

  /// Tampilkan tombol "Tempel kode".
  final bool showPasteButton;

  static const pasteLabel = 'Tempel kode';
  static const pasteEmptyMessage = 'Tidak ada kode angka di papan klip. Salin kode dari email lalu coba lagi.';

  @override
  State<OtpBoxes> createState() => _OtpBoxesState();
}

class _OtpBoxesState extends State<OtpBoxes> {
  FocusNode? _ownFocus;

  FocusNode get _focus => widget.focusNode ?? (_ownFocus ??= FocusNode(debugLabel: 'otp'));

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_rebuild);
    _focus.addListener(_rebuild);
  }

  @override
  void didUpdateWidget(OtpBoxes oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_rebuild);
      widget.controller.addListener(_rebuild);
    }
    if (oldWidget.focusNode != widget.focusNode) {
      (oldWidget.focusNode ?? _ownFocus)?.removeListener(_rebuild);
      _focus.addListener(_rebuild);
    }
    final error = widget.errorText;
    if (error != null && error != oldWidget.errorText) _announce(error);
  }

  /// Galat baru diumumkan pembaca layar walau fokus sudah lepas dari kotak (mis. setelah verifikasi). Android
  /// memakai live region pada teks galat; iOS tidak mengenal live region sehingga diumumkan eksplisit (N-11).
  void _announce(String message) {
    if (defaultTargetPlatform != TargetPlatform.iOS) return;
    final view = View.maybeOf(context);
    if (view == null) return;
    unawaited(SemanticsService.sendAnnouncement(view, message, Directionality.of(context)));
  }

  @override
  void dispose() {
    widget.controller.removeListener(_rebuild);
    _focus.removeListener(_rebuild);
    _ownFocus?.dispose();
    super.dispose();
  }

  void _rebuild() {
    if (mounted) setState(() {});
  }

  void _handleChanged(String value) {
    widget.onChanged?.call(value);
    if (value.length == widget.length) widget.onCompleted?.call(value);
  }

  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    if (!mounted) return;
    final code = otpDigits(data?.text ?? '', widget.length);
    if (code.isEmpty) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(content: Text(OtpBoxes.pasteEmptyMessage)));
      return;
    }
    widget.controller.value = TextEditingValue(
      text: code,
      selection: TextSelection.collapsed(offset: code.length),
    );
    if (code.length < widget.length) _focus.requestFocus();
    _handleChanged(code);
  }

  @override
  Widget build(BuildContext context) {
    final text = widget.controller.text;
    final hasError = widget.errorText != null;
    final scaler = MediaQuery.textScalerOf(context);
    const fontSize = 22.0;
    final boxHeight = math.max(KapdhComponentSize.otpBoxHeight, scaler.scale(fontSize) * 1.5 + KapdhSpace.s3);

    Widget box(int index) {
      final char = index < text.length ? text[index] : '';
      final isCurrent =
          _focus.hasFocus && index == math.min(text.length, widget.length - 1) && text.length < widget.length;
      final Color color;
      final double width;
      if (hasError) {
        color = KapdhColors.danger;
        width = 2;
      } else if (isCurrent) {
        color = KapdhColors.accent;
        width = 2;
      } else if (char.isNotEmpty) {
        color = KapdhColors.primary;
        width = 2;
      } else {
        color = KapdhColors.border;
        width = 1;
      }
      return Expanded(
        child: Container(
          height: boxHeight,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: widget.enabled ? KapdhColors.surface : KapdhColors.neutral100,
            border: Border.all(color: color, width: width),
            borderRadius: BorderRadius.circular(KapdhRadius.md),
          ),
          child: Text(
            char,
            style: const TextStyle(fontSize: fontSize, fontWeight: FontWeight.w600, color: KapdhColors.text),
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          height: boxHeight,
          child: Stack(
            children: [
              ExcludeSemantics(
                child: Row(
                  children: [
                    for (var i = 0; i < widget.length; i++) ...[
                      if (i > 0) const SizedBox(width: KapdhSpace.s2),
                      box(i),
                    ],
                  ],
                ),
              ),
              Positioned.fill(
                child: Semantics(
                  label: 'Kode OTP ${widget.length} digit',
                  // Galat melekat pada field seperti KapdhTextField, sehingga terbaca saat field difokuskan lagi.
                  hint: widget.errorText,
                  child: TextSelectionTheme(
                    data: const TextSelectionThemeData(
                      selectionColor: Colors.transparent,
                      cursorColor: Colors.transparent,
                      selectionHandleColor: Colors.transparent,
                    ),
                    child: TextField(
                      key: const ValueKey('otp-input'),
                      controller: widget.controller,
                      focusNode: _focus,
                      enabled: widget.enabled,
                      autofocus: widget.autofocus,
                      keyboardType: TextInputType.number,
                      textInputAction: TextInputAction.done,
                      autofillHints: const [AutofillHints.oneTimeCode],
                      inputFormatters: [OtpInputFormatter(widget.length)],
                      showCursor: false,
                      enableSuggestions: false,
                      autocorrect: false,
                      expands: true,
                      maxLines: null,
                      minLines: null,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.transparent, fontSize: 1, height: 1),
                      decoration: const InputDecoration(
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        disabledBorder: InputBorder.none,
                        errorBorder: InputBorder.none,
                        focusedErrorBorder: InputBorder.none,
                        filled: false,
                        isCollapsed: true,
                        counterText: '',
                      ),
                      onChanged: _handleChanged,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        if (widget.showPasteButton)
          Align(
            alignment: AlignmentDirectional.centerEnd,
            child: KapdhLinkButton(
              key: const ValueKey('otp-paste'),
              label: OtpBoxes.pasteLabel,
              icon: Icons.content_paste,
              onPressed: widget.enabled ? _paste : null,
            ),
          ),
        if (hasError) ...[
          if (!widget.showPasteButton) const SizedBox(height: KapdhSpace.s2),
          Semantics(
            liveRegion: true,
            container: true,
            child: Text(
              widget.errorText!,
              style: const TextStyle(color: KapdhColors.danger, fontSize: KapdhFontSize.caption),
            ),
          ),
        ],
      ],
    );
  }
}
