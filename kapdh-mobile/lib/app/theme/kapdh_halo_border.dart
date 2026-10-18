import 'dart:ui' show lerpDouble;

import 'package:flutter/material.dart';

/// Garis field saat fokus (redesain v2, mockup `.input:focus-within`): garis 2 px + halo 4 px bernada garis di luar
/// kotak. Halo digambar di luar persegi field sehingga tata letak tidak bergeser; field lain memakai
/// [OutlineInputBorder] biasa.
class KapdhHaloBorder extends OutlineInputBorder {
  const KapdhHaloBorder({
    super.borderSide,
    super.borderRadius,
    super.gapPadding,
    required this.halo,
    this.haloWidth = 4,
  });

  final Color halo;
  final double haloWidth;

  @override
  KapdhHaloBorder copyWith({
    BorderSide? borderSide,
    BorderRadius? borderRadius,
    double? gapPadding,
    Color? halo,
    double? haloWidth,
  }) => KapdhHaloBorder(
    borderSide: borderSide ?? this.borderSide,
    borderRadius: borderRadius ?? this.borderRadius,
    gapPadding: gapPadding ?? this.gapPadding,
    halo: halo ?? this.halo,
    haloWidth: haloWidth ?? this.haloWidth,
  );

  @override
  KapdhHaloBorder scale(double t) => KapdhHaloBorder(
    borderSide: borderSide.scale(t),
    borderRadius: borderRadius * t,
    gapPadding: gapPadding * t,
    halo: halo,
    haloWidth: haloWidth * t,
  );

  @override
  ShapeBorder? lerpFrom(ShapeBorder? a, double t) {
    if (a is KapdhHaloBorder) {
      return KapdhHaloBorder(
        borderSide: BorderSide.lerp(a.borderSide, borderSide, t),
        borderRadius: BorderRadius.lerp(a.borderRadius, borderRadius, t)!,
        gapPadding: lerpDouble(a.gapPadding, gapPadding, t)!,
        halo: Color.lerp(a.halo, halo, t)!,
        haloWidth: lerpDouble(a.haloWidth, haloWidth, t)!,
      );
    }
    if (a is OutlineInputBorder) {
      return KapdhHaloBorder(
        borderSide: BorderSide.lerp(a.borderSide, borderSide, t),
        borderRadius: BorderRadius.lerp(a.borderRadius, borderRadius, t)!,
        gapPadding: lerpDouble(a.gapPadding, gapPadding, t)!,
        halo: halo.withValues(alpha: halo.a * t),
        haloWidth: haloWidth,
      );
    }
    return super.lerpFrom(a, t);
  }

  @override
  ShapeBorder? lerpTo(ShapeBorder? b, double t) {
    if (b is OutlineInputBorder && b is! KapdhHaloBorder) {
      return KapdhHaloBorder(
        borderSide: BorderSide.lerp(borderSide, b.borderSide, t),
        borderRadius: BorderRadius.lerp(borderRadius, b.borderRadius, t)!,
        gapPadding: lerpDouble(gapPadding, b.gapPadding, t)!,
        halo: halo.withValues(alpha: halo.a * (1 - t)),
        haloWidth: haloWidth,
      );
    }
    return super.lerpTo(b, t);
  }

  @override
  void paint(
    Canvas canvas,
    Rect rect, {
    double? gapStart,
    double gapExtent = 0.0,
    double gapPercentage = 0.0,
    TextDirection? textDirection,
  }) {
    if (halo.a > 0 && haloWidth > 0) {
      final outer = borderRadius.toRRect(rect).inflate(borderSide.strokeOutset + haloWidth / 2);
      canvas.drawRRect(
        outer,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = haloWidth
          ..color = halo,
      );
    }
    super.paint(
      canvas,
      rect,
      gapStart: gapStart,
      gapExtent: gapExtent,
      gapPercentage: gapPercentage,
      textDirection: textDirection,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is KapdhHaloBorder && super == other && other.halo == halo && other.haloWidth == haloWidth;

  @override
  int get hashCode => Object.hash(super.hashCode, halo, haloWidth);
}
