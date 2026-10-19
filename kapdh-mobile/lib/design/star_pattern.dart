import 'dart:math' as math;

import 'package:flutter/widgets.dart';

/// Motif geometris bintang delapan (dua persegi bertumpuk 45°) dalam kisi, garis tipis berwarna lembut untuk latar
/// terang (layar Welcome). Pasangan terang dari [BrandPatternPainter] di pita hijau.
class StarPatternPainter extends CustomPainter {
  const StarPatternPainter({this.color = const Color(0xFFECEFE9), this.cell = 72, this.strokeWidth = 1.2});

  final Color color;

  /// Jarak antarpusat bintang.
  final double cell;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeJoin = StrokeJoin.miter;
    final star = _star(cell * 0.36);
    for (var y = 0.0; y < size.height + cell; y += cell) {
      for (var x = 0.0; x < size.width + cell; x += cell) {
        canvas.drawPath(star.shift(Offset(x, y)), paint);
        // Bintang kecil di tengah setiap empat bintang besar mengisi celah kisi.
        canvas.drawPath(_star(cell * 0.16).shift(Offset(x + cell / 2, y + cell / 2)), paint);
      }
    }
  }

  /// Bintang delapan dari dua persegi berjari-jari [r] (pusat di 0,0).
  static Path _star(double r) {
    final path = Path();
    for (final rotation in [0.0, math.pi / 4]) {
      for (var i = 0; i < 4; i++) {
        final angle = rotation + math.pi / 4 + i * math.pi / 2;
        final point = Offset(r * math.cos(angle), r * math.sin(angle));
        i == 0 ? path.moveTo(point.dx, point.dy) : path.lineTo(point.dx, point.dy);
      }
      path.close();
    }
    return path;
  }

  @override
  bool shouldRepaint(StarPatternPainter oldDelegate) =>
      oldDelegate.color != color || oldDelegate.cell != cell || oldDelegate.strokeWidth != strokeWidth;
}
