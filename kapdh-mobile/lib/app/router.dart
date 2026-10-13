import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/app_gate/app_gate.dart';
import '../core/session/session_controller.dart';
import '../core/ui/app_keys.dart';
import '../features/account/account_screen.dart';
import '../features/account/blocked_users_screen.dart';
import '../features/account/change_password_screen.dart';
import '../features/account/delete_account_screen.dart';
import '../features/account/my_reports_screen.dart';
import '../features/account/notification_preferences_screen.dart';
import '../features/account/privacy_settings_screen.dart';
import '../features/account/profile_edit_screen.dart';
import '../features/account/sessions_screen.dart';
import '../features/auth/forgot_otp_screen.dart';
import '../features/auth/forgot_password_screen.dart';
import '../features/auth/login_screen.dart';
import '../features/auth/otp_screen.dart';
import '../features/auth/register_screen.dart';
import '../features/auth/reset_password_screen.dart';
import '../features/chat/chat_info_screen.dart';
import '../features/chat/chat_invitations_screen.dart';
import '../features/chat/chat_room_screen.dart';
import '../features/chat/new_group_screen.dart';
import '../features/events/event_detail_screen.dart';
import '../features/events/events_screen.dart';
import '../features/home/home_screen.dart';
import '../features/kta/kta_screen.dart';
import '../features/legal/legal_page_screen.dart';
import '../features/network/member_profile_screen.dart';
import '../features/network/network_screen.dart';
import '../features/news/news_detail_screen.dart';
import '../features/news/news_list_screen.dart';
import '../features/notifications/notification_open_screen.dart';
import '../features/notifications/notifications_screen.dart';
import '../features/onboarding/onboarding_fees_screen.dart';
import '../features/payments/new_payment_screen.dart';
import '../features/payments/payment_detail_screen.dart';
import '../features/payments/payments_screen.dart';
import '../features/payments/renewal_screen.dart';
import '../features/status/deletion_status_screen.dart';
import '../features/status/restricted_screen.dart';
import '../features/system/maintenance_screen.dart';
import '../features/system/not_found_screen.dart';
import '../features/system/splash_screen.dart';
import '../features/system/update_required_screen.dart';
import '../features/tickets/ticket_detail_screen.dart';
import '../features/tickets/tickets_screen.dart';
import 'app_shell.dart';
import 'redirect.dart';
import 'routes.dart';

/// Memicu evaluasi ulang redirect saat gerbang aplikasi atau sesi berubah.
class _RouterRefresh extends ChangeNotifier {
  void notify() => notifyListeners();
}

/// Router aplikasi dengan SEMUA rute ARCHITECTURE §8.4. Redirect murni ada di redirect.dart (PRD 2.2).
final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefresh();
  ref
    ..listen(sessionProvider, (_, _) => refresh.notify())
    ..listen(appGateProvider.select((gate) => gate.status), (_, _) => refresh.notify());
  final rootKey = ref.watch(rootNavigatorKeyProvider);

  final router = GoRouter(
    navigatorKey: rootKey,
    initialLocation: AppRoutes.splash,
    refreshListenable: refresh,
    debugLogDiagnostics: kDebugMode,
    redirect: (context, state) => resolveRedirect(
      RedirectState(gate: ref.read(appGateProvider).status, session: ref.read(sessionProvider)),
      state.uri,
    ),
    errorBuilder: (context, state) => const NotFoundScreen(),
    routes: buildAppRoutes(rootKey),
  );
  ref.onDispose(() {
    router.dispose();
    refresh.dispose();
  });
  return router;
});

String _param(GoRouterState state, String name) => state.pathParameters[name] ?? '';

/// Daftar rute lengkap; dipisah agar dapat diuji.
List<RouteBase> buildAppRoutes(GlobalKey<NavigatorState> rootKey) => [
  // Sistem.
  GoRoute(path: AppRoutes.splash, builder: (_, _) => const SplashScreen()),
  GoRoute(path: AppRoutes.updateRequired, builder: (_, _) => const UpdateRequiredScreen()),
  GoRoute(path: AppRoutes.maintenance, builder: (_, _) => const MaintenanceScreen()),

  // Auth.
  GoRoute(path: AppRoutes.login, builder: (_, _) => const LoginScreen()),
  GoRoute(
    path: AppRoutes.register,
    builder: (_, _) => const RegisterScreen(),
    routes: [GoRoute(path: 'otp', builder: (_, _) => const OtpScreen())],
  ),
  GoRoute(
    path: AppRoutes.forgot,
    builder: (_, _) => const ForgotPasswordScreen(),
    routes: [
      GoRoute(path: 'otp', builder: (_, _) => const ForgotOtpScreen()),
      GoRoute(path: 'reset', builder: (_, _) => const ResetPasswordScreen()),
    ],
  ),

  // Onboarding dan pembayaran.
  GoRoute(path: AppRoutes.onboardingFees, builder: (_, _) => const OnboardingFeesScreen()),
  GoRoute(
    path: AppRoutes.payments,
    builder: (_, _) => const PaymentsScreen(),
    routes: [
      GoRoute(
        path: 'new/:type',
        builder: (_, state) => NewPaymentScreen(type: _param(state, 'type')),
      ),
      GoRoute(
        path: ':paymentId',
        builder: (_, state) => PaymentDetailScreen(paymentId: _param(state, 'paymentId')),
      ),
    ],
  ),

  // Hapus akun di luar shell: juga dibuka anggota suspended dari portal pembatasan (PRD 2.2).
  GoRoute(path: AppRoutes.accountDelete, builder: (_, _) => const DeleteAccountScreen()),

  // Shell tab bawah: Beranda, Event, KTA, Jejaring, Akun.
  StatefulShellRoute.indexedStack(
    builder: (_, _, navigationShell) => AppShell(navigationShell: navigationShell),
    branches: [
      StatefulShellBranch(
        routes: [GoRoute(path: AppRoutes.home, builder: (_, _) => const HomeScreen())],
      ),
      StatefulShellBranch(
        routes: [
          GoRoute(
            path: AppRoutes.events,
            builder: (_, _) => const EventsScreen(),
            routes: [
              GoRoute(
                path: ':eventId',
                parentNavigatorKey: rootKey,
                builder: (_, state) => EventDetailScreen(eventId: _param(state, 'eventId')),
              ),
            ],
          ),
        ],
      ),
      StatefulShellBranch(
        routes: [GoRoute(path: AppRoutes.kta, builder: (_, _) => const KtaScreen())],
      ),
      StatefulShellBranch(
        routes: [
          GoRoute(
            path: AppRoutes.network,
            builder: (_, _) => const NetworkScreen(),
            routes: [
              GoRoute(
                path: 'members/:userId',
                parentNavigatorKey: rootKey,
                builder: (_, state) => MemberProfileScreen(userId: _param(state, 'userId')),
              ),
            ],
          ),
        ],
      ),
      StatefulShellBranch(
        routes: [
          GoRoute(
            path: AppRoutes.account,
            builder: (_, _) => const AccountScreen(),
            routes: [
              GoRoute(path: 'profile', parentNavigatorKey: rootKey, builder: (_, _) => const ProfileEditScreen()),
              GoRoute(path: 'privacy', parentNavigatorKey: rootKey, builder: (_, _) => const PrivacySettingsScreen()),
              GoRoute(
                path: 'notifications',
                parentNavigatorKey: rootKey,
                builder: (_, _) => const NotificationPreferencesScreen(),
              ),
              GoRoute(path: 'sessions', parentNavigatorKey: rootKey, builder: (_, _) => const SessionsScreen()),
              GoRoute(path: 'password', parentNavigatorKey: rootKey, builder: (_, _) => const ChangePasswordScreen()),
              GoRoute(path: 'blocked', parentNavigatorKey: rootKey, builder: (_, _) => const BlockedUsersScreen()),
              GoRoute(path: 'reports', parentNavigatorKey: rootKey, builder: (_, _) => const MyReportsScreen()),
            ],
          ),
        ],
      ),
    ],
  ),

  // Detail layar penuh.
  GoRoute(
    path: AppRoutes.news,
    builder: (_, _) => const NewsListScreen(),
    routes: [
      GoRoute(
        path: ':slug',
        builder: (_, state) => NewsDetailScreen(slug: _param(state, 'slug')),
      ),
    ],
  ),
  GoRoute(
    path: AppRoutes.tickets,
    builder: (_, _) => const TicketsScreen(),
    routes: [
      GoRoute(
        path: ':ticketId',
        builder: (_, state) => TicketDetailScreen(ticketId: _param(state, 'ticketId')),
      ),
    ],
  ),
  GoRoute(path: AppRoutes.renewal, builder: (_, _) => const RenewalScreen()),
  GoRoute(path: AppRoutes.chatNewGroup, builder: (_, _) => const NewGroupScreen()),
  GoRoute(path: AppRoutes.chatInvitations, builder: (_, _) => const ChatInvitationsScreen()),
  GoRoute(
    path: '/chat/:roomId',
    builder: (_, state) => ChatRoomScreen(roomId: _param(state, 'roomId')),
    routes: [
      GoRoute(
        path: 'info',
        builder: (_, state) => ChatInfoScreen(roomId: _param(state, 'roomId')),
      ),
    ],
  ),
  GoRoute(
    path: AppRoutes.notifications,
    builder: (_, _) => const NotificationsScreen(),
    routes: [
      // Ketukan push membuka gerbang ini; objek tujuan baru dibuka setelah server mengonfirmasi notifikasi milik
      // akun yang sedang masuk (AC F13-3, F13-5).
      GoRoute(
        path: ':notificationId',
        builder: (_, state) => NotificationOpenScreen(notificationId: _param(state, 'notificationId')),
      ),
    ],
  ),
  GoRoute(
    path: '/legal/:slug',
    builder: (_, state) => LegalPageScreen(slug: _param(state, 'slug')),
  ),

  // Portal status (PRD 2.2).
  GoRoute(path: AppRoutes.restricted, builder: (_, _) => const RestrictedScreen()),
  GoRoute(path: AppRoutes.deletionStatus, builder: (_, _) => const DeletionStatusScreen()),
];
