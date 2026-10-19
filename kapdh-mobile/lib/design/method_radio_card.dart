import 'package:flutter/material.dart';

import '../app/theme/kapdh_focus.dart';
import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_theme.dart';
import '../app/theme/kapdh_tokens.dart';

/// Kartu pilihan rekening/metode bayar (prototipe layar 3 "Rekening tujuan"): indikator radio, nama bank,
/// nomor rekening, nama pemilik dan tombol "Salin" saat terpilih. Terpilih bergaris hijau 2 px. Metode QRIS
/// (ADR-026) memberi [accountNumberLabel] "NMID" dan [accountHolderLabel] "Merchant" tanpa tombol salin.
class MethodRadioCard extends StatelessWidget {
  const MethodRadioCard({
    super.key,
    required this.title,
    required this.selected,
    required this.onSelected,
    this.accountNumber,
    this.accountHolder,
    this.accountNumberLabel,
    this.accountHolderLabel,
    this.hint,
    this.onCopy,
  });

  /// Mis. nama bank atau e-wallet.
  final String title;
  final bool selected;
  final VoidCallback? onSelected;
  final String? accountNumber;

  /// Ditampilkan sebagai `a.n. <nama>`, atau `<accountHolderLabel>: <nama>` bila label diberikan.
  final String? accountHolder;

  /// Label nomor tujuan (mis. "NMID" untuk QRIS): tampil `<label>: <nomor>`. Tanpa label nomor tampil apa adanya
  /// dan dibacakan `nomor <nomor>`.
  final String? accountNumberLabel;

  /// Label pemilik (mis. "Merchant" untuk QRIS) menggantikan "a.n.".
  final String? accountHolderLabel;

  /// Teks bantu saat belum terpilih, mis. "Ketuk untuk melihat nomor tujuan".
  final String? hint;

  /// Salin nomor rekening; tombol tampil hanya bila terpilih dan nomor ada.
  final VoidCallback? onCopy;

  @override
  Widget build(BuildContext context) {
    final showDetail = selected && accountNumber != null;
    final radius = BorderRadius.circular(KapdhRadius.md);
    final numberLabel = accountNumberLabel;
    final holderLabel = accountHolderLabel;
    final numberText = numberLabel == null ? accountNumber : '$numberLabel: $accountNumber';
    final holderText = holderLabel == null ? 'a.n. $accountHolder' : '$holderLabel: $accountHolder';
    // [v2] Cincin fokus 3 px menimpa garis kartu (tanpa mengubah tata letak) saat area pilihan (InkWell) terfokus
    // keyboard/akses saklar (WCAG 2.4.7, 1.4.11); tombol "Salin" memakai cincin tema sendiri.
    return KapdhFocusRing(
      radius: radius,
      builder: (onFocusChange) => Container(
        decoration: BoxDecoration(
          color: context.kc.surface,
          border: Border.all(color: selected ? context.kc.primary : context.kc.border, width: selected ? 2 : 1),
          borderRadius: radius,
        ),
        child: Material(
          type: MaterialType.transparency,
          child: Row(
            children: [
              Expanded(
                child: Semantics(
                  inMutuallyExclusiveGroup: true,
                  checked: selected,
                  button: true,
                  label: [
                    title,
                    if (showDetail) '${numberLabel ?? 'nomor'} $accountNumber',
                    if (showDetail && accountHolder != null)
                      holderLabel == null ? 'atas nama $accountHolder' : '${holderLabel.toLowerCase()} $accountHolder',
                  ].join(', '),
                  excludeSemantics: true,
                  onTap: onSelected,
                  child: InkWell(
                    borderRadius: radius,
                    onTap: onSelected,
                    onFocusChange: onFocusChange,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin + KapdhSpace.s3),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: KapdhSpace.s3),
                        child: Row(
                          children: [
                            _RadioDot(selected: selected),
                            const SizedBox(width: KapdhSpace.s3),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    title,
                                    style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
                                  ),
                                  if (showDetail) ...[
                                    const SizedBox(height: 2),
                                    Text(numberText!, style: const TextStyle(fontSize: 13)),
                                    if (accountHolder != null)
                                      Text(
                                        holderText,
                                        style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
                                      ),
                                  ] else if (hint != null) ...[
                                    const SizedBox(height: 2),
                                    Text(
                                      hint!,
                                      style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              if (showDetail && onCopy != null)
                Padding(
                  padding: const EdgeInsets.only(right: KapdhSpace.s1),
                  child: TextButton(
                    onPressed: onCopy,
                    style: TextButton.styleFrom(
                      textStyle: KapdhTheme.font(fontSize: KapdhFontSize.caption, fontWeight: FontWeight.w600),
                    ),
                    child: Semantics(
                      label: 'Salin nomor rekening $title',
                      excludeSemantics: true,
                      child: const Text('Salin'),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _RadioDot extends StatelessWidget {
  const _RadioDot({required this.selected});

  final bool selected;

  @override
  Widget build(BuildContext context) {
    // [v2] Indikator radio 20 = KapdhIconSize.md (kolom ikon di depan judul; mockup .method-card__dot 20 px).
    return Container(
      width: KapdhIconSize.md,
      height: KapdhIconSize.md,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: selected ? context.kc.primary : context.kc.border, width: 2),
      ),
      child: selected
          ? Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(color: context.kc.primary, shape: BoxShape.circle),
            )
          : null,
    );
  }
}
