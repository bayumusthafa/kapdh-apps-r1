import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';
import 'design_constants.dart';
import '../app/theme/kapdh_focus.dart';

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

/// Motif pita hijau [BrandHeader].
enum BrandMotif {
  /// Lingkaran bertumpuk tipis ([BrandPatternPainter]), bawaan.
  quatrefoil,

  /// Pita gelombang diagonal berkilau ([BrandWavePainter]); layar Masuk.
  waves,
}

/// Pita gelombang lebar yang melengkung diagonal dari kiri atas ke kanan, putih tembus pandang dengan kilau ke kanan
/// dan garis sorot tipis di tepi atas pita pertama (desain layar Masuk). Digambar relatif terhadap ukuran pita
/// sehingga mengikuti tinggi header pada teks besar.
class BrandWavePainter extends CustomPainter {
  const BrandWavePainter();

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    if (w == 0 || h == 0) return;

    // Cahaya lembut di kiri atas.
    canvas.drawRect(
      Offset.zero & size,
      Paint()
        ..shader = const RadialGradient(
          center: Alignment(-0.4, -0.9),
          radius: 0.9,
          colors: [Color(0x14FFFFFF), Color(0x00FFFFFF)],
        ).createShader(Offset.zero & size),
    );

    Paint sheen(double from, double to) => Paint()
      ..shader = LinearGradient(
        colors: [Color.fromRGBO(255, 255, 255, from), Color.fromRGBO(255, 255, 255, to)],
      ).createShader(Offset.zero & size);

    final first = Path()
      ..moveTo(0, h * 0.10)
      ..cubicTo(w * 0.35, h * 0.04, w * 0.55, h * 0.52, w, h * 0.40)
      ..lineTo(w, h * 0.64)
      ..cubicTo(w * 0.60, h * 0.80, w * 0.35, h * 0.24, 0, h * 0.36)
      ..close();
    canvas.drawPath(first, sheen(0.05, 0.12));

    final second = Path()
      ..moveTo(0, h * 0.48)
      ..cubicTo(w * 0.30, h * 0.40, w * 0.62, h * 0.86, w, h * 0.72)
      ..lineTo(w, h * 0.90)
      ..cubicTo(w * 0.60, h * 1.02, w * 0.30, h * 0.60, 0, h * 0.68)
      ..close();
    canvas.drawPath(second, sheen(0.02, 0.06));

    // Garis sorot di tepi atas pita pertama.
    final highlight = Path()
      ..moveTo(0, h * 0.10)
      ..cubicTo(w * 0.35, h * 0.04, w * 0.55, h * 0.52, w, h * 0.40);
    canvas.drawPath(
      highlight,
      sheen(0.04, 0.16)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5,
    );
  }

  @override
  bool shouldRepaint(BrandWavePainter oldDelegate) => false;
}

/// Pita hijau bergradasi bermotif (guideline hal. 5; prototipe layar 1 sampai 5). Konten di dalamnya memakai warna
/// teks terang. Inset status bar ditambahkan otomatis bila [includeTopInset].
class BrandHeader extends StatelessWidget {
  const BrandHeader({
    super.key,
    this.child,
    this.padding = const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5),
    this.pattern = true,
    this.motif = BrandMotif.quatrefoil,
    this.includeTopInset = true,
    this.minHeight = 0,
  });

  final Widget? child;
  final EdgeInsets padding;
  final bool pattern;

  /// Motif yang digambar bila [pattern] aktif.
  final BrandMotif motif;
  final bool includeTopInset;
  final double minHeight;

  @override
  Widget build(BuildContext context) {
    final top = includeTopInset ? MediaQuery.paddingOf(context).top : 0.0;
    return Container(
      constraints: BoxConstraints(minHeight: minHeight + top),
      decoration: const BoxDecoration(gradient: KapdhExtraColors.bandGradient),
      child: CustomPaint(
        painter: !pattern
            ? null
            : switch (motif) {
                BrandMotif.quatrefoil => const BrandPatternPainter(),
                BrandMotif.waves => const BrandWavePainter(),
              },
        child: Padding(
          padding: padding.copyWith(top: padding.top + top),
          // Kontrol di pita hijau memakai cincin fokus emas.
          child: child == null ? null : DarkSurfaceFocus(child: child!),
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
///
/// Dengan [scrollable], pita ikut bergulir bersama isi lembar dalam satu scroll view. Wajib untuk kepala yang tinggi
/// (logo dan sapaan login): saat keyboard terbuka dan teks diperbesar 200 %, kepala yang tidak bergulir saja sudah
/// melebihi ruang yang tersisa (N-11). Pada mode ini [body] TIDAK boleh berupa scroll view; isinya disusun dalam
/// Column biasa.
class BrandSheetScaffold extends StatelessWidget {
  const BrandSheetScaffold({
    super.key,
    required this.body,
    this.header,
    this.overlap = KapdhSpace.s3,
    this.bottomBar,
    this.resizeToAvoidBottomInset = true,
    this.scrollable = false,
  });

  final Widget body;
  final Widget? header;

  /// Pita dan isi bergulir bersama (lihat dokumentasi kelas).
  final bool scrollable;

  /// Seberapa jauh lembar menumpuk pita.
  final double overlap;

  /// Area tombol tetap di bawah (mis. CTA utama), di dalam lembar.
  final Widget? bottomBar;
  final bool resizeToAvoidBottomInset;

  Widget _sheet({required Widget content}) => Transform.translate(
    offset: Offset(0, -overlap),
    // Material (bukan DecoratedBox) agar efek sentuh ListTile/InkWell di dalam lembar tetap terlihat.
    child: Material(
      color: KapdhColors.background,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(KapdhRadius.xl))),
      clipBehavior: Clip.antiAlias,
      child: SafeArea(top: false, child: content),
    ),
  );

  Widget? _bottomBar() => bottomBar == null
      ? null
      : Padding(
          // Lembar digeser ke atas sejauh overlap; jarak bawah tampak tetap 24 px (prototipe).
          padding: EdgeInsets.fromLTRB(
            KapdhSpace.s5,
            KapdhSpace.s3,
            KapdhSpace.s5,
            (KapdhSpace.s6 - overlap).clamp(KapdhSpace.s2, KapdhSpace.s6),
          ),
          child: bottomBar,
        );

  @override
  Widget build(BuildContext context) {
    final band = header ?? BrandHeader(pattern: false, padding: EdgeInsets.only(bottom: overlap), minHeight: 28);
    if (scrollable) {
      final bar = _bottomBar();
      final topInset = MediaQuery.paddingOf(context).top;
      return Scaffold(
        // Sewarna lembar: ruang di bawah lembar yang pendek tampak menyatu dengan lembar.
        backgroundColor: KapdhColors.background,
        resizeToAvoidBottomInset: resizeToAvoidBottomInset,
        body: Stack(
          children: [
            Positioned.fill(
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    band,
                    _sheet(
                      content: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [body, ?bar]),
                    ),
                  ],
                ),
              ),
            ),
            // Area status bar tetap hijau saat pita tergulir ke atas, agar ikon status bar terang tetap terbaca.
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              height: topInset,
              child: ColoredBox(color: KapdhExtraColors.bandGradient.colors.first),
            ),
          ],
        ),
      );
    }
    return Scaffold(
      backgroundColor: KapdhColors.background,
      resizeToAvoidBottomInset: resizeToAvoidBottomInset,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          band,
          Expanded(
            child: _sheet(
              content: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(child: body),
                  ?_bottomBar(),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
