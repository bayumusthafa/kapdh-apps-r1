import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/theme/kapdh_tokens.dart';
import 'design_constants.dart';

/// Formatter OTP: hanya digit, maksimal [length]. Tempelan seperti "Kode Anda: 482 913" menjadi "482913".
class OtpInputFormatter extends TextInputFormatter {
  const OtpInputFormatter(this.length);

  final int length;

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final digits = newValue.text.replaceAll(RegExp(r'[^0-9]'), '');
    final clipped = digits.length > length ? digits.substring(0, length) : digits;
    return TextEditingValue(
      text: clipped,
      selection: TextSelection.collapsed(offset: clipped.length),
    );
  }
}

/// Masukan kode OTP enam kotak (prototipe layar 1; AC F01-2, F01-3).
///
/// Satu field teks tak terlihat menerima ketikan, tempel dan isi otomatis `oneTimeCode`; kotak hanya tampilan.
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
        if (hasError) ...[
          const SizedBox(height: KapdhSpace.s2),
          Text(
            widget.errorText!,
            style: const TextStyle(color: KapdhColors.danger, fontSize: KapdhFontSize.caption),
          ),
        ],
      ],
    );
  }
}
