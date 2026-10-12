import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';

/// Kartu pilihan rekening/metode bayar (prototipe layar 3 "Rekening tujuan"): indikator radio, nama bank,
/// nomor rekening, nama pemilik dan tombol "Salin" saat terpilih. Terpilih bergaris hijau 2 px.
class MethodRadioCard extends StatelessWidget {
  const MethodRadioCard({
    super.key,
    required this.title,
    required this.selected,
    required this.onSelected,
    this.accountNumber,
    this.accountHolder,
    this.hint,
    this.onCopy,
  });

  /// Mis. nama bank atau e-wallet.
  final String title;
  final bool selected;
  final VoidCallback? onSelected;
  final String? accountNumber;

  /// Ditampilkan sebagai `a.n. <nama>`.
  final String? accountHolder;

  /// Teks bantu saat belum terpilih, mis. "Ketuk untuk melihat nomor tujuan".
  final String? hint;

  /// Salin nomor rekening; tombol tampil hanya bila terpilih dan nomor ada.
  final VoidCallback? onCopy;

  @override
  Widget build(BuildContext context) {
    final showDetail = selected && accountNumber != null;
    final radius = BorderRadius.circular(12);
    return Container(
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: selected ? KapdhColors.primary : KapdhColors.border, width: selected ? 2 : 1),
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
                  if (showDetail) 'nomor $accountNumber',
                  if (showDetail && accountHolder != null) 'atas nama $accountHolder',
                ].join(', '),
                excludeSemantics: true,
                onTap: onSelected,
                child: InkWell(
                  borderRadius: radius,
                  onTap: onSelected,
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
                                  Text(accountNumber!, style: const TextStyle(fontSize: 13)),
                                  if (accountHolder != null)
                                    Text(
                                      'a.n. $accountHolder',
                                      style: const TextStyle(
                                        fontSize: KapdhFontSize.caption,
                                        color: KapdhColors.textMuted,
                                      ),
                                    ),
                                ] else if (hint != null) ...[
                                  const SizedBox(height: 2),
                                  Text(
                                    hint!,
                                    style: const TextStyle(
                                      fontSize: KapdhFontSize.caption,
                                      color: KapdhColors.textMuted,
                                    ),
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
                    textStyle: const TextStyle(fontSize: KapdhFontSize.caption, fontWeight: FontWeight.w600),
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
    );
  }
}

class _RadioDot extends StatelessWidget {
  const _RadioDot({required this.selected});

  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 20,
      height: 20,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: selected ? KapdhColors.primary : KapdhColors.border, width: 2),
      ),
      child: selected
          ? Container(
              width: 10,
              height: 10,
              decoration: const BoxDecoration(color: KapdhColors.primary, shape: BoxShape.circle),
            )
          : null,
    );
  }
}
