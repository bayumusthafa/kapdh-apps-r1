import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

/// Kembali satu halaman lewat [pop] (yang menghormati `PopScope`, mis. "Buang perubahan?" di Ubah Profil, PRD 4.5),
/// lalu, bila halaman benar-benar tertutup (konfigurasi delegasi berganti), melewatkan lokasi baru ke redirect seperti
/// `GoRouter.pop`. Halaman di bawahnya yang tidak diizinkan matriks rute untuk status sekarang (mis. daftar event bagi
/// anggota expired yang membuka detail event lewat deep link, PRD 2.2) diganti rute status, tanpa request ke layar
/// yang terlarang. Bila `PopScope` menahan atau yang tertutup hanya dialog/lembar, konfigurasi tidak berubah dan
/// redirect tidak dijalankan. Mengembalikan hasil [pop]: false bila tidak ada yang dapat ditutup.
///
/// Dipakai bersama oleh panah kembali `AppScaffold` dan tombol kembali sistem ([RedirectingBackButtonDispatcher]),
/// sehingga keduanya berakhir di lokasi yang sama.
Future<bool> popThenRedirect(GoRouter router, Future<bool> Function() pop) async {
  final before = router.routerDelegate.currentConfiguration;
  final handled = await pop();
  final after = router.routerDelegate.currentConfiguration;
  if (handled && !identical(before, after)) router.restore(after);
  return handled;
}

/// Tombol kembali sistem (Android) untuk router aplikasi: sama dengan [RootBackButtonDispatcher] milik GoRouter,
/// ditambah [popThenRedirect] sesudah halaman tertutup. Tanpa ini tombol kembali sistem memanggil
/// `routerDelegate.popRoute()` langsung dan halaman dasar yang sudah tidak diizinkan status anggota tetap tampil.
class RedirectingBackButtonDispatcher extends RootBackButtonDispatcher {
  RedirectingBackButtonDispatcher(this.router);

  final GoRouter router;

  @override
  Future<bool> invokeCallback(Future<bool> defaultValue) =>
      popThenRedirect(router, () => super.invokeCallback(defaultValue));
}

/// Konfigurasi `MaterialApp.router` dari [router] dengan [RedirectingBackButtonDispatcher] sebagai tombol kembali
/// sistem; bagian lain (delegasi, parser, penyedia informasi rute) milik GoRouter apa adanya.
RouterConfig<Object> redirectingRouterConfig(GoRouter router) => RouterConfig<Object>(
  routeInformationProvider: router.routeInformationProvider,
  routeInformationParser: router.routeInformationParser,
  routerDelegate: router.routerDelegate,
  backButtonDispatcher: RedirectingBackButtonDispatcher(router),
);
