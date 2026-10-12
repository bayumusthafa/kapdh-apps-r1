import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/theme/kapdh_tokens.dart';
import '../core/format/formatters.dart';
import 'design_constants.dart';

/// Kotak nominal transfer gelap dengan tombol salin (prototipe layar 3 "Transfer tepat sebesar Rp60.000").
///
/// [amount] berupa string desimal kontrak `Money` ("60000.00"); tampilan memakai [formatRupiah] dan yang disalin
/// hanya digit ("60000") agar dapat ditempel langsung di aplikasi bank. Tidak ada aritmetika floating point
/// (ARCHITECTURE §2 butir 5).
class AmountCopyBox extends StatelessWidget {
  const AmountCopyBox({super.key, required this.amount, this.label = 'Transfer tepat sebesar', this.onCopied});

  final String amount;
  final String label;

  /// Dipanggil setelah nominal tersalin (mis. menampilkan snackbar). Bawaan: snackbar "Nominal disalin".
  final VoidCallback? onCopied;

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: rupiahDigits(amount)));
    if (onCopied != null) {
      onCopied!();
      return;
    }
    if (!context.mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(content: Text('Nominal disalin')));
  }

  @override
  Widget build(BuildContext context) {
    final formatted = formatRupiah(amount);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: 14),
      decoration: BoxDecoration(color: KapdhColors.surfaceDark, borderRadius: BorderRadius.circular(KapdhRadius.lg)),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              label: '$label $formatted',
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhExtraColors.mutedOnDark),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    formatted,
                    style: const TextStyle(
                      fontSize: KapdhFontSize.h1,
                      fontWeight: FontWeight.w700,
                      color: KapdhColors.accent,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(width: KapdhSpace.s3),
          OutlinedButton(
            onPressed: () => _copy(context),
            style: OutlinedButton.styleFrom(
              foregroundColor: KapdhColors.accent,
              side: const BorderSide(color: KapdhColors.accent),
              padding: const EdgeInsets.symmetric(horizontal: 14),
              textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
            ),
            child: Semantics(label: 'Salin nominal $formatted', excludeSemantics: true, child: const Text('Salin')),
          ),
        ],
      ),
    );
  }
}
