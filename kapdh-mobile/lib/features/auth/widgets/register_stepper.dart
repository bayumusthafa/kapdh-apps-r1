import 'package:flutter/material.dart';

import '../../../app/theme/kapdh_tokens.dart';

/// Stepper pendaftaran sesuai guidelines: Data Diri, OTP, Biaya KTA, Pembayaran.
class RegisterStepper extends StatelessWidget {
  const RegisterStepper({super.key, required this.current});

  final int current; // 0..3

  static const _labels = ['Data Diri', 'OTP', 'Biaya KTA', 'Pembayaran'];
  static const _icons = [Icons.person_outline, Icons.verified_user_outlined, Icons.badge_outlined, Icons.credit_card];

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Langkah ${current + 1} dari 4: ${_labels[current]}',
      child: Row(
        children: [
          for (var i = 0; i < 4; i++)
            Expanded(
              child: Column(
                children: [
                  Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: i <= current ? KapdhColors.primary : KapdhColors.surface,
                      border: i <= current ? null : Border.all(color: KapdhColors.border, width: 1.5),
                      boxShadow: i == current ? const [BoxShadow(color: KapdhColors.green100, spreadRadius: 4)] : null,
                    ),
                    child: Icon(
                      i < current ? Icons.check : _icons[i],
                      size: 18,
                      color: i <= current ? KapdhColors.onPrimary : KapdhColors.textMuted,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _labels[i],
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: i == current ? FontWeight.w600 : FontWeight.w400,
                      color: i < current ? KapdhColors.primary : (i == current ? KapdhColors.text : KapdhColors.textMuted),
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

/// Pita hijau atas dengan lembar putih membulat, seperti mockup guidelines.
class BrandSheet extends StatelessWidget {
  const BrandSheet({super.key, required this.child, this.header});

  final Widget child;
  final Widget? header;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: KapdhColors.primary,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (header != null) header! else const SizedBox(height: 12),
            Expanded(
              child: Container(
                decoration: const BoxDecoration(
                  color: KapdhColors.background,
                  borderRadius: BorderRadius.vertical(top: Radius.circular(KapdhRadius.xl)),
                ),
                child: child,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
