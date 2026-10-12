import 'package:kapdh_api/kapdh_api.dart';

/// Path rute aplikasi (ARCHITECTURE §8.4). Satu sumber untuk router, redirect, shell dan fitur.
abstract final class AppRoutes {
  // Sistem.
  static const splash = '/splash';
  static const updateRequired = '/update-required';
  static const maintenance = '/maintenance';

  // Auth.
  static const login = '/login';
  static const register = '/register';
  static const registerOtp = '/register/otp';
  static const forgot = '/forgot';
  static const forgotOtp = '/forgot/otp';
  static const forgotReset = '/forgot/reset';

  // Onboarding dan pembayaran.
  static const onboardingFees = '/onboarding/fees';
  static const payments = '/payments';
  static String newPayment(PaymentType type) => '/payments/new/${type.value}';
  static String payment(String paymentId) => '/payments/${Uri.encodeComponent(paymentId)}';

  // Tab shell.
  static const home = '/home';
  static const events = '/events';
  static const kta = '/kta';
  static const network = '/network';
  static const account = '/account';

  // Detail.
  static const news = '/news';
  static String newsDetail(String slug) => '/news/${Uri.encodeComponent(slug)}';
  static String event(String eventId) => '/events/${Uri.encodeComponent(eventId)}';
  static const tickets = '/tickets';
  static String ticket(String ticketId) => '/tickets/${Uri.encodeComponent(ticketId)}';
  static const renewal = '/renewal';
  static String member(String userId) => '/network/members/${Uri.encodeComponent(userId)}';
  static String chat(String roomId) => '/chat/${Uri.encodeComponent(roomId)}';
  static String chatInfo(String roomId) => '/chat/${Uri.encodeComponent(roomId)}/info';
  static const chatNewGroup = '/chat/new-group';
  static const chatInvitations = '/chat/invitations';
  static const notifications = '/notifications';
  static const accountProfile = '/account/profile';
  static const accountPrivacy = '/account/privacy';
  static const accountNotifications = '/account/notifications';
  static const accountSessions = '/account/sessions';
  static const accountPassword = '/account/password';
  static const accountBlocked = '/account/blocked';
  static const accountReports = '/account/reports';
  static const accountDelete = '/account/delete';
  static String legal(String slug) => '/legal/${Uri.encodeComponent(slug)}';

  // Portal status (PRD 2.2).
  static const restricted = '/restricted';
  static const deletionStatus = '/deletion-status';

  /// Slug halaman legal/informasi (seed `LEGAL_PAGE_SHELLS`, F-08).
  static const privacySlug = 'kebijakan-privasi';
  static const termsSlug = 'ketentuan';
  static const communitySlug = 'ketentuan-komunitas';
  static const helpSlug = 'bantuan';
  static const aboutSlug = 'tentang';
}
