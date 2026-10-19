import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../design/design.dart';
import '../../app/theme/kapdh_focus.dart';

/// Membuka pratinjau KTA layar penuh landscape.
Future<void> showKtaFullScreen(BuildContext context, KtaCardData data) {
  // [v2] Durasi/kurva dari token motion; reduce motion (dibaca saat push) meniadakan fade.
  final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
  return Navigator.of(context, rootNavigator: true).push(
    PageRouteBuilder<void>(
      opaque: true,
      fullscreenDialog: true,
      transitionDuration: reduceMotion ? Duration.zero : KapdhMotion.base,
      // [v2] Dulu 200 ms; tidak ada token 200, pakai fast (150 ms).
      reverseTransitionDuration: reduceMotion ? Duration.zero : KapdhMotion.fast,
      pageBuilder: (_, _, _) => KtaFullScreen(data: data),
      // [v2] drive(CurveTween) alih-alih CurvedAnimation: builder dipanggil ulang tiap rebuild dan CurvedAnimation
      // baru menambah status listener ke animasi rute tanpa pernah dilepas.
      transitionsBuilder: (_, animation, _, child) => FadeTransition(
        opacity: animation.drive(CurveTween(curve: KapdhMotion.easeOut)),
        child: child,
      ),
    ),
  );
}

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
      body: DarkSurfaceFocus(
        child: GestureDetector(
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
      ),
    );
  }
}
