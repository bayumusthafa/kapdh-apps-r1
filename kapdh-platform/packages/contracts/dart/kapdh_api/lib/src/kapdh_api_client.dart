// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import 'apis/account_api.dart';
import 'apis/admin_admins_api.dart';
import 'apis/admin_audit_api.dart';
import 'apis/admin_auth_api.dart';
import 'apis/admin_content_api.dart';
import 'apis/admin_dashboard_api.dart';
import 'apis/admin_events_api.dart';
import 'apis/admin_masters_api.dart';
import 'apis/admin_members_api.dart';
import 'apis/admin_moderation_api.dart';
import 'apis/admin_notifications_api.dart';
import 'apis/admin_payments_api.dart';
import 'apis/admin_settings_api.dart';
import 'apis/auth_api.dart';
import 'apis/chat_api.dart';
import 'apis/content_api.dart';
import 'apis/events_api.dart';
import 'apis/files_api.dart';
import 'apis/me_api.dart';
import 'apis/moderation_api.dart';
import 'apis/network_api.dart';
import 'apis/notifications_api.dart';
import 'apis/payments_api.dart';
import 'apis/public_api.dart';

/// Semua kelas API kontrak KAPDH dari satu [Dio] aplikasi.
class KapdhApi {
  KapdhApi(Dio dio)
      : account = AccountApi(dio),
        adminAdmins = AdminAdminsApi(dio),
        adminAudit = AdminAuditApi(dio),
        adminAuth = AdminAuthApi(dio),
        adminContent = AdminContentApi(dio),
        adminDashboard = AdminDashboardApi(dio),
        adminEvents = AdminEventsApi(dio),
        adminMasters = AdminMastersApi(dio),
        adminMembers = AdminMembersApi(dio),
        adminModeration = AdminModerationApi(dio),
        adminNotifications = AdminNotificationsApi(dio),
        adminPayments = AdminPaymentsApi(dio),
        adminSettings = AdminSettingsApi(dio),
        auth = AuthApi(dio),
        chat = ChatApi(dio),
        content = ContentApi(dio),
        events = EventsApi(dio),
        files = FilesApi(dio),
        me = MeApi(dio),
        moderation = ModerationApi(dio),
        network = NetworkApi(dio),
        notifications = NotificationsApi(dio),
        payments = PaymentsApi(dio),
        public = PublicApi(dio);

  /// Tag "Account".
  final AccountApi account;

  /// Tag "Admin Admins".
  final AdminAdminsApi adminAdmins;

  /// Tag "Admin Audit".
  final AdminAuditApi adminAudit;

  /// Tag "Admin Auth".
  final AdminAuthApi adminAuth;

  /// Tag "Admin Content".
  final AdminContentApi adminContent;

  /// Tag "Admin Dashboard".
  final AdminDashboardApi adminDashboard;

  /// Tag "Admin Events".
  final AdminEventsApi adminEvents;

  /// Tag "Admin Masters".
  final AdminMastersApi adminMasters;

  /// Tag "Admin Members".
  final AdminMembersApi adminMembers;

  /// Tag "Admin Moderation".
  final AdminModerationApi adminModeration;

  /// Tag "Admin Notifications".
  final AdminNotificationsApi adminNotifications;

  /// Tag "Admin Payments".
  final AdminPaymentsApi adminPayments;

  /// Tag "Admin Settings".
  final AdminSettingsApi adminSettings;

  /// Tag "Auth".
  final AuthApi auth;

  /// Tag "Chat".
  final ChatApi chat;

  /// Tag "Content".
  final ContentApi content;

  /// Tag "Events".
  final EventsApi events;

  /// Tag "Files".
  final FilesApi files;

  /// Tag "Me".
  final MeApi me;

  /// Tag "Moderation".
  final ModerationApi moderation;

  /// Tag "Network".
  final NetworkApi network;

  /// Tag "Notifications".
  final NotificationsApi notifications;

  /// Tag "Payments".
  final PaymentsApi payments;

  /// Tag "Public".
  final PublicApi public;
}
