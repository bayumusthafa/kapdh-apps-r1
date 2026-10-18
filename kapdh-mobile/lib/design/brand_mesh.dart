import 'package:flutter/widgets.dart';

import '../app/theme/kapdh_tokens.dart';
import 'star_pattern.dart';

/// Latar "mesh" zamrud (redesain v2, senada header Beranda): gradasi diagonal green950 -> green800 -> green700,
/// cahaya emas di kanan atas, cahaya hijau di kiri bawah, dua cincin dekoratif dan motif bintang putih tipis. Konten
/// di atasnya memakai warna teks terang.
class BrandMeshBackground extends StatelessWidget {
  const BrandMeshBackground({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [KapdhColors.green950, KapdhColors.green800, KapdhColors.green700],
          stops: [0, 0.55, 1],
        ),
      ),
      child: Stack(
        children: [
          const Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: Alignment(0.9, -1),
                  radius: 0.9,
                  colors: [Color(0x33E6D312), Color(0x00E6D312)],
                ),
              ),
            ),
          ),
          const Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: Alignment(-1, 1),
                  radius: 1,
                  colors: [Color(0x573F9A38), Color(0x003F9A38)],
                ),
              ),
            ),
          ),
          const Positioned.fill(
            child: RepaintBoundary(
              child: CustomPaint(painter: StarPatternPainter(color: Color(0x0AFFFFFF))),
            ),
          ),
          const Positioned(top: -110, right: -90, child: _Ring(size: 300, width: 34, color: Color(0x0AFFFFFF))),
          const Positioned(bottom: -130, left: -80, child: _Ring(size: 260, width: 22, color: Color(0x10E6D312))),
          child,
        ],
      ),
    );
  }
}

class _Ring extends StatelessWidget {
  const _Ring({required this.size, required this.width, required this.color});

  final double size;
  final double width;
  final Color color;

  @override
  Widget build(BuildContext context) => IgnorePointer(
    child: Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: color, width: width),
      ),
    ),
  );
}
