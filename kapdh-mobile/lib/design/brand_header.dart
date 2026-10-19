import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/theme/kapdh_focus.dart';
import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_tokens.dart';
import 'app_scaffold.dart';

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

/// Latar "mesh" zamrud semua pita hijau (redesain v2, sama dengan header Beranda; mockup `--gradient-brand-mesh`):
/// gradasi diagonal green950 -> green800 -> green700, cahaya emas di kanan atas (radius 46 % sudut terjauh), cahaya
/// hijau di kiri bawah (55 %), dan dua cincin dekoratif: putih 4 % (200 px, garis 26) di kanan atas dan emas 6 %
/// (170 px, garis 16) di kiri bawah. Ukuran mengikuti CSS mockup sehingga pita tipis maupun tinggi tampak sama.
class BrandMeshPainter extends CustomPainter {
  const BrandMeshPainter();

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final rect = Offset.zero & size;
    canvas.drawRect(rect, Paint()..shader = KapdhGradients.brandMeshBase.createShader(rect));

    double farthest(Offset c) => [
      c.distance,
      (c - Offset(size.width, 0)).distance,
      (c - Offset(0, size.height)).distance,
      (c - Offset(size.width, size.height)).distance,
    ].reduce(math.max);
    void glow(Offset center, double fraction, Color color) {
      final r = farthest(center) * fraction;
      canvas.drawRect(
        rect,
        Paint()
          ..shader = RadialGradient(
            colors: [color, color.withValues(alpha: 0)],
          ).createShader(Rect.fromCircle(center: center, radius: r)),
      );
    }

    glow(Offset(size.width * 0.92, 0), 0.46, const Color(0x33E6D312));
    glow(Offset(size.width * 0.06, size.height), 0.55, const Color(0x573F9A38));

    void ring(Offset center, double outerRadius, double width, Color color) => canvas.drawCircle(
      center,
      outerRadius - width / 2,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = width
        ..color = color,
    );
    ring(Offset(size.width + 56 - 100, -70 + 100), 100, 26, const Color(0x0AFFFFFF));
    ring(Offset(-48 + 85, size.height + 96 - 85), 85, 16, const Color(0x0FE6D312));
  }

  @override
  bool shouldRepaint(BrandMeshPainter oldDelegate) => false;
}

/// Motif tambahan di atas mesh [BrandHeader].
enum BrandMotif {
  /// Tanpa motif (bawaan v2: Akun, Profil Alumni, sapaan; sama dengan header Beranda).
  none,

  /// Lingkaran bertumpuk tipis ([BrandPatternPainter]).
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

/// Pita hijau merek (guideline hal. 5; prototipe layar 1 sampai 5): mesh zamrud [BrandMeshPainter] + motif opsional.
/// Konten di dalamnya memakai warna teks terang. Inset status bar ditambahkan otomatis bila [includeTopInset].
/// [rounded] memberi sudut bawah 24, bayangan hijau dan garis emas tipis seperti header Beranda, untuk pita yang
/// berdiri sendiri (tidak ditumpuk lembar terang).
class BrandHeader extends StatelessWidget {
  const BrandHeader({
    super.key,
    this.child,
    this.padding = const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5),
    this.pattern = true,
    this.motif = BrandMotif.none,
    this.includeTopInset = true,
    this.minHeight = 0,
    this.rounded = false,
  });

  final Widget? child;
  final EdgeInsets padding;
  final bool pattern;

  /// Motif yang digambar bila [pattern] aktif.
  final BrandMotif motif;
  final bool includeTopInset;
  final double minHeight;
  final bool rounded;

  @override
  Widget build(BuildContext context) {
    final top = includeTopInset ? MediaQuery.paddingOf(context).top : 0.0;
    const radius = BorderRadius.vertical(bottom: Radius.circular(KapdhRadius.xl));
    final band = ConstrainedBox(
      constraints: BoxConstraints(minHeight: minHeight + top, minWidth: double.infinity),
      child: CustomPaint(
        painter: const BrandMeshPainter(),
        foregroundPainter: !pattern
            ? null
            : switch (motif) {
                BrandMotif.none => null,
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
    if (!rounded) return ClipRect(child: band);
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: radius, boxShadow: context.kc.shadowBrandBand),
      child: ClipRRect(
        borderRadius: radius,
        // passthrough (bukan loose): batasan ketat induk, mis. Positioned.fill di kepala Akun, diteruskan ke pita
        // sehingga mesh mengisi seluruh tinggi yang diberikan. Bukan expand: Profil Alumni memberi tinggi tak terbatas.
        child: Stack(
          fit: StackFit.passthrough,
          children: [
            band,
            // Garis emas tipis di tepi bawah (inset 0 -1px 0 emas 22 %).
            const Positioned(left: 0, right: 0, bottom: 0, height: 1, child: ColoredBox(color: Color(0x38E6D312))),
          ],
        ),
      ),
    );
  }
}

/// Gaya status bar di atas pita hijau (sama di mode terang dan gelap): ikon selalu terang. Hanya status bar yang
/// diatur (navigasi sistem tidak diubah, seperti AppBar M3), supaya gaya layar sebelumnya (mis. Splash terang) tidak
/// terbawa. Dipakai [BrandSheetScaffold] dan layar berpita sendiri (Beranda, Akun, Profil Alumni).
const kBrandStatusBarOverlay = SystemUiOverlayStyle(
  statusBarColor: Colors.transparent,
  statusBarIconBrightness: Brightness.light,
  statusBarBrightness: Brightness.dark,
);

/// Area status bar yang tetap hijau saat pita hijau tergulir ke atas, agar ikon status bar terang
/// ([kBrandStatusBarOverlay]) tetap terbaca. Ditaruh sebagai anak terakhir [Stack] di atas isi yang menggulir.
///
/// Dengan [scrollOffset] (piksel gulir isi), pengisi baru muncul saat pita mulai tergulir sehingga mesh pita (cahaya
/// emas kanan atas) tetap utuh di posisi awal; tanpa itu pengisi selalu tampak.
class BrandStatusBarFill extends StatelessWidget {
  const BrandStatusBarFill({super.key, this.scrollOffset});

  final ValueListenable<double>? scrollOffset;

  static const _fill = IgnorePointer(
    child: DecoratedBox(
      decoration: BoxDecoration(
        // [v2] Mengikuti tepi atas mesh (green950 -> green800 -> green700).
        gradient: LinearGradient(
          colors: [KapdhColors.green950, KapdhColors.green800, KapdhColors.green700],
          stops: [0, 0.6, 1],
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.paddingOf(context).top;
    final offset = scrollOffset;
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      height: height,
      child: offset == null || height <= 0
          ? _fill
          : ValueListenableBuilder<double>(
              valueListenable: offset,
              // Nilai mutlak: overscroll iOS di puncak (piksel negatif) menurunkan pita; pengisi menutup celahnya.
              builder: (context, px, child) => Opacity(opacity: (px.abs() / height).clamp(0.0, 1.0), child: child),
              child: _fill,
            ),
    );
  }
}

/// Tombol ikon kaca 48 x 48 radius 16 di atas pita hijau (header Beranda v2, Profil Alumni): putih 16 -> 6 %, garis
/// putih 18 %, ikon putih.
class BrandIconButton extends StatelessWidget {
  const BrandIconButton({super.key, required this.icon, required this.tooltip, required this.onPressed, this.child});

  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;

  /// Pengganti ikon (mis. ikon dengan lencana).
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(KapdhRadius.lg),
      side: const BorderSide(color: Color(0x2EFFFFFF)),
    );
    // Cincin fokus di luar klip Material; emas karena pita hijau memasang DarkSurfaceFocus, dan dipaksa emas bila
    // tombol dipakai di luar pita.
    final button = KapdhFocusRing(
      radius: BorderRadius.circular(KapdhRadius.lg),
      ring: KapdhColors.focusRingOnDark,
      builder: (onFocusChange) => DecoratedBox(
        decoration: const BoxDecoration(
          borderRadius: BorderRadius.all(Radius.circular(KapdhRadius.lg)),
          boxShadow: [BoxShadow(offset: Offset(0, 4), blurRadius: 12, spreadRadius: -2, color: Color(0x38000000))],
        ),
        child: Material(
          shape: shape,
          clipBehavior: Clip.antiAlias,
          color: Colors.transparent,
          child: Ink(
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [Color(0x29FFFFFF), Color(0x0FFFFFFF)],
              ),
            ),
            child: InkWell(
              onTap: onPressed,
              onFocusChange: onFocusChange,
              customBorder: shape,
              child: SizedBox(
                width: KapdhSize.touchTargetMin,
                height: KapdhSize.touchTargetMin,
                child: Center(
                  child: child ?? Icon(icon, size: KapdhIconSize.lg, color: KapdhColors.textOnDark),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    // Tooltip kosong: tombol dipakai sebagai tampilan di dalam pemicu lain (mis. PopupMenuButton bertooltip sendiri).
    return tooltip.isEmpty ? button : Tooltip(message: tooltip, child: button);
  }
}

/// Logo KAPDH dalam bingkai kaca bercincin emas (header Beranda v2 dan pita sapaan): 48 x 48 radius 16, padding 5.
class BrandLogoFrame extends StatelessWidget {
  const BrandLogoFrame({super.key, this.size = 48});

  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    padding: const EdgeInsets.all(5),
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(KapdhRadius.lg),
      gradient: const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color(0x29FFFFFF), Color(0x0DFFFFFF)],
      ),
      border: Border.all(color: const Color(0x8CE6D312), width: 1.5),
      boxShadow: const [BoxShadow(offset: Offset(0, 6), blurRadius: 16, spreadRadius: -4, color: Color(0x59000000))],
    ),
    child: Image.asset('assets/logo-kapdh.png', semanticLabel: 'Logo KAPDH', fit: BoxFit.contain),
  );
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
          const BrandLogoFrame(),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  "Assalamu'alaikum,",
                  style: TextStyle(
                    fontSize: KapdhFontSize.caption,
                    fontWeight: FontWeight.w500,
                    letterSpacing: 0.3,
                    color: KapdhColors.green100,
                  ),
                ),
                Text(
                  name,
                  style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: KapdhColors.textOnDark),
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

  Widget _sheet(BuildContext context, {required Widget content}) => Transform.translate(
    offset: Offset(0, -overlap),
    // Material (bukan DecoratedBox) agar efek sentuh ListTile/InkWell di dalam lembar tetap terlihat.
    child: Material(
      color: context.kc.background,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(KapdhRadius.xl))),
      clipBehavior: Clip.antiAlias,
      child: SafeArea(top: false, child: ContentWidth(child: content)),
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
      return AnnotatedRegion<SystemUiOverlayStyle>(
        value: kBrandStatusBarOverlay,
        child: Scaffold(
          // Sewarna lembar: ruang di bawah lembar yang pendek tampak menyatu dengan lembar.
          backgroundColor: context.kc.background,
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
                        context,
                        content: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [body, ?bar]),
                      ),
                    ],
                  ),
                ),
              ),
              const BrandStatusBarFill(),
            ],
          ),
        ),
      );
    }
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: kBrandStatusBarOverlay,
      child: Scaffold(
        backgroundColor: context.kc.background,
        resizeToAvoidBottomInset: resizeToAvoidBottomInset,
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            band,
            Expanded(
              child: _sheet(
                context,
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
      ),
    );
  }
}
