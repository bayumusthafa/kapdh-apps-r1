import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/app_gate/app_gate.dart';
import '../core/session/session_controller.dart';
import '../design/design.dart';
import 'router.dart';
import 'routes.dart';

/// Memasang pita status global untuk semua layar [AppScaffold] (prototipe layar 7; PRD 4.5, AC F05-2, N-03):
/// - "Pemeliharaan" selama gerbang aplikasi berstatus maintenance (mode baca terkendali);
/// - "Offline" selama sesi memakai snapshot /me terakhir (offlineLastKnown).
///
/// Pita berada tepat di bawah app bar setiap layar, bukan di atas navigasi bawah, dan layar yang memberi pita
/// sendiri lewat `AppScaffold(banner:)` tidak menampilkan pita global (tidak ada pita ganda).
class AppStatusBanners extends ConsumerWidget {
  const AppStatusBanners({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final gate = ref.watch(appGateProvider);
    final banners = <Widget>[
      if (gate.status == GateStatus.maintenance)
        MaintenanceBanner(
          until: gate.maintenanceUntil,
          onDetails: () {
            final router = ref.read(routerProvider);
            final from = router.state.uri.toString();
            router.go(Uri(path: AppRoutes.maintenance, queryParameters: {'from': from}).toString());
          },
        ),
      if (session.isOffline)
        OfflineBanner(syncedAt: session.syncedAt, onRetry: () => ref.read(sessionProvider.notifier).refreshQuietly()),
    ];
    return AppBannerScope(
      banner: banners.isEmpty
          ? null
          : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: banners),
      child: child,
    );
  }
}
