import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../design/design.dart';

/// Membuka pratinjau KTA layar penuh landscape.
Future<void> showKtaFullScreen(BuildContext context, KtaCardData data) =>
    Navigator.of(context, rootNavigator: true).push(
      PageRouteBuilder<void>(
        opaque: true,
        fullscreenDialog: true,
        transitionDuration: const Duration(milliseconds: 250),
        reverseTransitionDuration: const Duration(milliseconds: 200),
        pageBuilder: (_, _, _) => KtaFullScreen(data: data),
        transitionsBuilder: (_, animation, _, child) => FadeTransition(
          opacity: CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
          child: child,
        ),
      ),
    );

/// Pratinjau KTA layar penuh: layar diputar ke landscape dan bilah sistem disembunyikan selama tampil, kartu digambar
/// dengan proporsi KTP (ISO/IEC 7810 ID-1, 85,6 x 54 mm) sebesar mungkin sehingga QR lebih mudah dipindai petugas.
/// Ketuk di mana saja atau tombol tutup untuk kembali; orientasi dan bilah sistem dipulihkan saat ditutup.
class KtaFullScreen extends StatefulWidget {
  const KtaFullScreen({super.key, required this.data});

  final KtaCardData data;

  static const closeTooltip = 'Tutup tampilan layar penuh';

  @override
  State<KtaFullScreen> createState() => _KtaFullScreenState();
}

class _KtaFullScreenState extends State<KtaFullScreen> {
  @override
  void initState() {
    super.initState();
    unawaited(
      SystemChrome.setPreferredOrientations([DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]),
    );
    unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky));
  }

  @override
  void dispose() {
    // Aplikasi tidak mengunci orientasi: daftar kosong memulihkan bawaan platform.
    unawaited(SystemChrome.setPreferredOrientations(const []));
    unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.manual, overlays: SystemUiOverlay.values));
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF020702),
      body: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => Navigator.of(context).maybePop(),
        child: SafeArea(
          child: Stack(
            children: [
              Positioned.fill(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(KapdhSpace.s6, KapdhSpace.s4, KapdhSpace.s6, KapdhSpace.s4),
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final width = (constraints.maxHeight * KtaCard.idCardAspectRatio).clamp(
                        0.0,
                        constraints.maxWidth,
                      );
                      return Center(
                        child: SizedBox(
                          key: const ValueKey('kta-fullscreen-card'),
                          width: width,
                          height: width / KtaCard.idCardAspectRatio,
                          child: KtaCard(data: widget.data, fill: true),
                        ),
                      );
                    },
                  ),
                ),
              ),
              PositionedDirectional(
                top: 0,
                end: 0,
                child: IconButton(
                  tooltip: KtaFullScreen.closeTooltip,
                  onPressed: () => Navigator.of(context).maybePop(),
                  icon: const Icon(KapdhIcons.close, color: KapdhColors.textOnDark),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
