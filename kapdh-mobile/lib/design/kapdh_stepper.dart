import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';
import 'design_constants.dart';

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
    final dot = compact ? KapdhComponentSize.stepperDotCompact : KapdhComponentSize.stepperDot;
    return Semantics(
      label: 'Langkah ${current + 1} dari ${steps.length}: ${steps[current].label}',
      excludeSemantics: true,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < steps.length; i++)
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: dot,
                    height: dot,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: i <= current ? KapdhColors.primary : KapdhColors.surface,
                      border: i <= current ? null : Border.all(color: KapdhColors.border, width: 1.5),
                      boxShadow: i == current ? const [BoxShadow(color: KapdhColors.green100, spreadRadius: 4)] : null,
                    ),
                    child: Icon(
                      i < current ? Icons.check : steps[i].icon,
                      size: 18,
                      color: i <= current ? KapdhColors.onPrimary : KapdhColors.textMuted,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    steps[i].label,
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: compact ? KapdhFontSize.overline : KapdhFontSize.caption,
                      fontWeight: i == current ? FontWeight.w600 : (i < current ? FontWeight.w500 : FontWeight.w400),
                      color: i < current
                          ? KapdhColors.primary
                          : (i == current ? KapdhColors.text : KapdhColors.textMuted),
                    ),
                  ),
                ],
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
    KapdhStep('Data Diri', Icons.person_outline),
    KapdhStep('OTP', Icons.shield_outlined),
    KapdhStep('Biaya KTA', Icons.payments_outlined),
    KapdhStep('Pembayaran', Icons.credit_card),
  ];

  /// 0 Data Diri, 1 OTP, 2 Biaya KTA, 3 Pembayaran.
  final int current;
  final bool compact;

  @override
  Widget build(BuildContext context) => KapdhStepper(steps: steps, current: current, compact: compact);
}
