import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';
import 'design_constants.dart';

/// Motif geometris tipis pada pita hijau (guideline hal. 5 latar login): kisi lingkaran bertumpuk yang membentuk
/// pola quatrefoil, garis putih transparan.
class BrandPatternPainter extends CustomPainter {
  const BrandPatternPainter({this.color = const Color(0x14FFFFFF), this.cell = 44});

  final Color color;

  /// Jarak antartitik pusat lingkaran.
  final double cell;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2;
    final radius = cell * 0.72;
    for (var y = -cell; y < size.height + cell; y += cell) {
      final row = (y / cell).round();
      final offset = row.isEven ? 0.0 : cell / 2;
      for (var x = -cell + offset; x < size.width + cell; x += cell) {
        canvas.drawCircle(Offset(x, y), radius, paint);
      }
    }
  }

  @override
  bool shouldRepaint(BrandPatternPainter oldDelegate) => oldDelegate.color != color || oldDelegate.cell != cell;
}

/// Pita hijau bergradasi bermotif (guideline hal. 5; prototipe layar 1 sampai 5). Konten di dalamnya memakai warna
/// teks terang. Inset status bar ditambahkan otomatis bila [includeTopInset].
class BrandHeader extends StatelessWidget {
  const BrandHeader({
    super.key,
    this.child,
    this.padding = const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5),
    this.pattern = true,
    this.includeTopInset = true,
    this.minHeight = 0,
  });

  final Widget? child;
  final EdgeInsets padding;
  final bool pattern;
  final bool includeTopInset;
  final double minHeight;

  @override
  Widget build(BuildContext context) {
    final top = includeTopInset ? MediaQuery.paddingOf(context).top : 0.0;
    return Container(
      constraints: BoxConstraints(minHeight: minHeight + top),
      decoration: const BoxDecoration(gradient: KapdhExtraColors.bandGradient),
      child: CustomPaint(
        painter: pattern ? const BrandPatternPainter() : null,
        child: Padding(
          padding: padding.copyWith(top: padding.top + top),
          child: child,
        ),
      ),
    );
  }
}

/// Kepala sapaan (prototipe layar 4, 5): logo, "Assalamu'alaikum," dan nama anggota.
class GreetingHeader extends StatelessWidget {
  const GreetingHeader({super.key, required this.name, this.bottomOverlap = KapdhSpace.s4});

  final String name;
  final double bottomOverlap;

  @override
  Widget build(BuildContext context) {
    return BrandHeader(
      pattern: false,
      padding: EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5 + bottomOverlap),
      child: Row(
        children: [
          Image.asset('assets/logo-kapdh.png', width: 44, height: 44, semanticLabel: 'Logo KAPDH'),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  "Assalamu'alaikum,",
                  style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.green100),
                ),
                Text(
                  name,
                  style: const TextStyle(
                    fontSize: KapdhFontSize.bodyLg,
                    fontWeight: FontWeight.w600,
                    color: KapdhColors.textOnDark,
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

/// Tata letak "lembar" KAPDH: pita hijau di atas dan lembar terang membulat 20 px yang menumpuk pita (prototipe
/// layar 1 sampai 5; guideline hal. 5). Tanpa [header] dipakai pita tipis 28 px.
class BrandSheetScaffold extends StatelessWidget {
  const BrandSheetScaffold({
    super.key,
    required this.body,
    this.header,
    this.overlap = KapdhSpace.s3,
    this.bottomBar,
    this.resizeToAvoidBottomInset = true,
  });

  final Widget body;
  final Widget? header;

  /// Seberapa jauh lembar menumpuk pita.
  final double overlap;

  /// Area tombol tetap di bawah (mis. CTA utama), di dalam lembar.
  final Widget? bottomBar;
  final bool resizeToAvoidBottomInset;

  @override
  Widget build(BuildContext context) {
    final band = header ?? BrandHeader(pattern: false, padding: EdgeInsets.only(bottom: overlap), minHeight: 28);
    return Scaffold(
      backgroundColor: KapdhColors.background,
      resizeToAvoidBottomInset: resizeToAvoidBottomInset,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          band,
          Expanded(
            child: Transform.translate(
              offset: Offset(0, -overlap),
              // Material (bukan DecoratedBox) agar efek sentuh ListTile/InkWell di dalam lembar tetap terlihat.
              child: Material(
                color: KapdhColors.background,
                shape: const RoundedRectangleBorder(
                  borderRadius: BorderRadius.vertical(top: Radius.circular(KapdhRadius.xl)),
                ),
                clipBehavior: Clip.antiAlias,
                child: SafeArea(
                  top: false,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(child: body),
                      if (bottomBar != null)
                        Padding(
                          // Lembar digeser ke atas sejauh overlap; jarak bawah tampak tetap 24 px (prototipe).
                          padding: EdgeInsets.fromLTRB(
                            KapdhSpace.s5,
                            KapdhSpace.s3,
                            KapdhSpace.s5,
                            (KapdhSpace.s6 - overlap).clamp(KapdhSpace.s2, KapdhSpace.s6),
                          ),
                          child: bottomBar,
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
