import 'package:flutter/material.dart';

import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_tokens.dart';
import 'design_constants.dart';
import 'kapdh_icons.dart';

/// Satu langkah stepper.
@immutable
class KapdhStep {
  const KapdhStep(this.label, this.icon);

  final String label;
  final IconData icon;
}

/// Stepper horizontal (prototipe layar 1 sampai 3, guideline hal. 5): langkah selesai hijau dengan centang,
/// langkah aktif hijau dengan cincin hijau muda 4 px, langkah berikut putih bergaris abu.
class KapdhStepper extends StatelessWidget {
  const KapdhStepper({super.key, required this.steps, required this.current, this.compact = false})
    : assert(current >= 0 && current < steps.length);

  final List<KapdhStep> steps;

  /// Indeks langkah aktif (mulai 0).
  final int current;

  /// Versi ringkas 32 px / label 11 px (prototipe layar 3).
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final p = context.kc;
    final dot = compact ? KapdhComponentSize.stepperDotCompact : KapdhComponentSize.stepperDot;
    final labelSize = compact ? KapdhFontSize.overline : KapdhFontSize.caption;
    // [v2 P2-3] Skala teks > 1,3: label langkah lain tidak muat di kolomnya; hanya label langkah aktif yang tampil,
    // satu baris selebar stepper. Seluruh langkah tetap dibacakan lewat label semantik.
    final large = MediaQuery.textScalerOf(context).scale(labelSize) > labelSize * 1.3;

    Widget dotOf(int i) => Container(
      width: dot,
      height: dot,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: i <= current ? p.primary : p.surface,
        border: i <= current ? null : Border.all(color: p.border, width: 1.5),
        boxShadow: i == current ? [BoxShadow(color: p.tintStrong, spreadRadius: 4)] : null,
      ),
      child: Icon(
        i < current ? KapdhIcons.check : steps[i].icon,
        size: KapdhIconSize.button,
        color: i <= current ? p.onPrimary : p.textMuted,
      ),
    );

    Text labelOf(int i, {int maxLines = 2}) => Text(
      steps[i].label,
      textAlign: TextAlign.center,
      maxLines: maxLines,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        fontSize: labelSize,
        fontWeight: i == current ? FontWeight.w600 : (i < current ? FontWeight.w500 : FontWeight.w400),
        color: i < current ? p.primary : (i == current ? p.text : p.textMuted),
      ),
    );

    return Semantics(
      label: 'Langkah ${current + 1} dari ${steps.length}: ${steps[current].label}',
      excludeSemantics: true,
      child: large
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [for (var i = 0; i < steps.length; i++) Expanded(child: Center(child: dotOf(i)))],
                ),
                const SizedBox(height: 6),
                labelOf(current, maxLines: 1),
              ],
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var i = 0; i < steps.length; i++)
                  Expanded(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [dotOf(i), const SizedBox(height: 6), labelOf(i)],
                    ),
                  ),
              ],
            ),
    );
  }
}

/// Stepper pendaftaran: Data Diri, OTP, Biaya KTA, Pembayaran (guideline hal. 5, F-01, F-03).
class RegisterStepper extends StatelessWidget {
  const RegisterStepper({super.key, required this.current, this.compact = false});

  static const steps = [
    KapdhStep('Data Diri', KapdhIcons.personOutline),
    KapdhStep('OTP', KapdhIcons.shieldOutlined),
    KapdhStep('Biaya KTA', KapdhIcons.paymentsOutlined),
    KapdhStep('Pembayaran', KapdhIcons.creditCard),
  ];

  /// 0 Data Diri, 1 OTP, 2 Biaya KTA, 3 Pembayaran.
  final int current;
  final bool compact;

  @override
  Widget build(BuildContext context) => KapdhStepper(steps: steps, current: current, compact: compact);
}
