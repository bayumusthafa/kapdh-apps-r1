import 'package:flutter/material.dart';

/// Isi layar formulir/pengaturan yang dibangun sekaligus dan dapat digulir. Dipakai sebagai pengganti `ListView`
/// untuk layar pendek: semua field ada di pohon widget sehingga fokus, pengisian otomatis dan pembaca layar dapat
/// menjangkau field yang belum terlihat (N-11), dan input yang sudah diketik tidak dibuang saat field keluar layar.
class ScrollColumn extends StatelessWidget {
  const ScrollColumn({super.key, required this.children, this.padding, this.physics});

  final List<Widget> children;
  final EdgeInsetsGeometry? padding;
  final ScrollPhysics? physics;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: padding,
      physics: physics,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
    );
  }
}
