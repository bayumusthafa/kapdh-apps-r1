import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Navigator akar go_router; dipakai dialog global (ErrorPresenter) dan rute layar penuh di luar shell.
final rootNavigatorKeyProvider = Provider<GlobalKey<NavigatorState>>(
  (ref) => GlobalKey<NavigatorState>(debugLabel: 'root'),
);

/// ScaffoldMessenger akar untuk snackbar global (ErrorPresenter, push latar depan).
final scaffoldMessengerKeyProvider = Provider<GlobalKey<ScaffoldMessengerState>>(
  (ref) => GlobalKey<ScaffoldMessengerState>(debugLabel: 'messenger'),
);
