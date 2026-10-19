import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/push/push_platform.dart';

import '../../support/fakes.dart';

/// Fixture kontrak final untuk irisan akun, notifikasi dan portal status. Bentuk JSON mengikuti skema
/// openapi/domains (C1 auth/account, C2 me, C6 moderation, C7 notifications) dengan semua field wajib.

String iso(DateTime value) => value.toUtc().toIso8601String();

Map<String, Object?> masterJson(String id, String label, {bool? active}) => {
  'id': id,
  'label': label,
  'active': ?active,
};

/// GET /me (`Me`) dengan profil lengkap yang dapat diubah per uji.
Map<String, Object?> meFullJson({
  String status = 'verified',
  String version = '3',
  String? city = 'Pekanbaru',
  String? phone,
  String? bio,
  String? instagram,
  Map<String, Object?>? profession,
  List<Map<String, Object?>> skills = const [],
  String? avatarFileId,
  String? avatarUrl,
  bool showInDirectory = true,
  bool showPhone = false,
  bool showEmail = false,
  bool showSocial = false,
  String? suspensionMessage,
  DateTime? expiresAt,
}) {
  final base = meJson(status: status, suspensionMessage: suspensionMessage, expiresAt: expiresAt);
  final profile = Map<String, Object?>.from(base['profile']! as Map<String, Object?>);
  profile
    ..['city'] = city
    ..['phone'] = phone
    ..['bio'] = bio
    ..['social_instagram'] = instagram
    ..['profession'] = profession
    ..['skills'] = skills
    ..['avatar_file_id'] = avatarFileId
    ..['avatar_url'] = avatarUrl
    ..['privacy'] = {
      'show_in_directory': showInDirectory,
      'show_phone': showPhone,
      'show_email': showEmail,
      'show_social': showSocial,
    };
  return {...base, 'version': version, 'profile': profile};
}

Map<String, Object?> sessionJson(
  String id, {
  bool current = false,
  String? deviceName = 'Samsung A54',
  String? platform = 'android',
  String? appVersion = '1.2.0',
  DateTime? createdAt,
  DateTime? lastSeenAt,
}) => {
  'id': id,
  'audience': 'mobile',
  'device_name': deviceName,
  'platform': platform,
  'app_version': appVersion,
  'created_at': iso(createdAt ?? testNow.subtract(const Duration(days: 3))),
  'last_seen_at': iso(lastSeenAt ?? testNow.subtract(const Duration(hours: 2))),
  'expires_at': iso(testNow.add(const Duration(days: 27))),
  'current': current,
};

const notificationId1 = '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e01';
const notificationId2 = '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e02';
const notificationId3 = '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e03';

Map<String, Object?> inboxJson(
  String id, {
  String category = 'payment',
  String title = 'Pembayaran disetujui',
  String? body = 'Iuran pendaftaran Anda sudah diverifikasi pengurus.',
  String? deepLink = 'kapdh://app/payments/pay-1',
  DateTime? readAt,
  DateTime? createdAt,
}) => {
  'id': id,
  'category': category,
  'title': title,
  'body': body,
  'deep_link': deepLink,
  'read_at': readAt == null ? null : iso(readAt),
  'created_at': iso(createdAt ?? testNow.subtract(const Duration(minutes: 5))),
};

Map<String, Object?> notificationPageJson(List<Map<String, Object?>> items, {String? nextCursor, int? unreadCount}) => {
  'items': items,
  'next_cursor': nextCursor,
  'unread_count': unreadCount ?? items.where((i) => i['read_at'] == null).length,
};

Map<String, Object?> preferencesJson({
  bool pushPayment = true,
  bool pushMembership = true,
  bool pushEvent = true,
  bool pushNews = true,
  bool pushChat = true,
  bool emailPayment = true,
  bool emailMembership = true,
  bool emailEvent = true,
}) => {
  'push': {
    'payment': pushPayment,
    'membership': pushMembership,
    'event': pushEvent,
    'news': pushNews,
    'chat': pushChat,
  },
  'email': {'payment': emailPayment, 'membership': emailMembership, 'event': emailEvent},
  'mandatory_categories': ['security', 'account'],
  'updated_at': null,
};

Map<String, Object?> accountDeletionJson({String status = 'pending', String source = 'app'}) => {
  'request_number': 'DEL-2026-7K3Q9X',
  'status': status,
  'source': source,
  'requested_at': iso(testNow),
  'estimated_completion_at': iso(DateTime.utc(2026, 10, 19, 7)),
  'completed_at': null,
};

Map<String, Object?> disclosureJson({
  String version = 'disc-v1',
  List<Map<String, Object?>> tickets = const [],
  List<Map<String, Object?>> refunds = const [],
  List<Map<String, Object?>> payments = const [],
  int soleAdminGroups = 0,
  bool linkedAdmin = false,
}) => {
  'version': version,
  'estimated_completion_days': 7,
  'backup_retention_days': 30,
  'deleted_data': [
    {'category': 'profile', 'description': 'Profil, foto dan kontak Anda.'},
    {'category': 'chat_content', 'description': 'Isi pesan chat yang Anda kirim menjadi placeholder tanpa isi.'},
  ],
  'retained_data': [
    {'category': 'payments', 'description': 'Catatan pembayaran anonim (jumlah, tanggal, status).'},
  ],
  'privacy_policy_slug': 'kebijakan-privasi',
  'privacy_policy_version': '2',
  'active_tickets': tickets,
  'pending_refunds': refunds,
  'open_payments': payments,
  'sole_admin_group_count': soleAdminGroups,
  'linked_admin_identity': linkedAdmin,
};

Map<String, Object?> ticketWarningJson({String policy = 'full_refund', bool cancelled = false}) => {
  'ticket_id': 'tk-1',
  'event_id': 'ev-1',
  'event_title': 'Reuni Akbar 2026',
  'event_starts_at': iso(DateTime.utc(2026, 11, 1, 2)),
  'event_timezone': 'Asia/Jakarta',
  'event_cancelled': cancelled,
  'status': 'paid',
  'total': '75000.00',
  'refund_policy': policy,
  'self_cancel_deadline_at': iso(DateTime.utc(2026, 10, 29, 2)),
};

Map<String, Object?> refundWarningJson() => {
  'adjustment_id': 'adj-1',
  'payment_id': 'pay-9',
  'payment_type': 'ticket',
  'ticket_id': 'tk-2',
  'event_title': 'Kajian Akhir Tahun',
  'amount': '50000.00',
  'due_at': iso(DateTime.utc(2026, 10, 21, 10)),
  'destination_provided': true,
  'created_at': iso(testNow.subtract(const Duration(days: 1))),
};

Map<String, Object?> paymentWarningJson({bool proofSubmitted = true}) => {
  'payment_id': 'pay-5',
  'type': 'renewal',
  'amount': '10000.00',
  'proof_submitted': proofSubmitted,
  'created_at': iso(testNow.subtract(const Duration(days: 2))),
};

Map<String, Object?> appealJson({
  String status = 'open',
  String? outcome,
  String? decisionMessage,
  DateTime? resolvedAt,
}) => {
  'id': 'rep-appeal-1',
  'category': 'appeal',
  'target_type': 'user',
  'target_name': 'Ahmad Islam',
  'room_name': null,
  'description': 'Saya mohon peninjauan ulang karena laporan itu keliru.',
  'status': status,
  'priority': 'normal',
  'outcome': outcome,
  'decision_message': decisionMessage,
  'created_at': iso(testNow.subtract(const Duration(hours: 3))),
  'due_at': iso(DateTime.utc(2026, 10, 14, 7)),
  'resolved_at': resolvedAt == null ? null : iso(resolvedAt),
};

Map<String, Object?> verificationJson({
  bool deletable = false,
  bool registrationPending = false,
  String? blockedReason = 'deletion_in_progress',
  Map<String, Object?>? deletion,
}) => {
  'email_masked': 'ah***@contoh.test',
  'deletable': deletable,
  'registration_pending': registrationPending,
  'blocked_reason': blockedReason,
  'deletion': deletion,
  'disclosure': null,
  'deletion_token': null,
  'deletion_token_expires_at': null,
};

Map<String, Object?> fileRefJson(String id) => {
  'id': id,
  'purpose': 'avatar',
  'mime': 'image/jpeg',
  'bytes': 2048,
  'width': 512,
  'height': 512,
  'visibility': 'private',
  'public_url': null,
  'created_at': iso(testNow),
};

/// Body JSON request (Map) yang dikirim SDK.
Map<String, Object?> bodyOf(RequestOptions options) => Map<String, Object?>.from(options.data as Map);

/// Header request tanpa membedakan huruf besar/kecil.
Object? headerOf(RequestOptions options, String name) {
  for (final entry in options.headers.entries) {
    if (entry.key.toLowerCase() == name.toLowerCase()) return entry.value;
  }
  return null;
}

/// Platform push tiruan (AC F13-2, F13-5).
class FakePushPlatform implements PushPlatform {
  bool available = true;
  PushPermission permission = PushPermission.granted;
  String? token = 'fcm-1';
  int deletes = 0;
  int permissionRequests = 0;
  final tokenRefresh = StreamController<String>.broadcast();
  final foreground = StreamController<PushMessage>.broadcast();
  final opened = StreamController<PushMessage>.broadcast();
  final localTaps = StreamController<String?>.broadcast();
  PushMessage? initial;

  @override
  Future<bool> initialize() async => available;

  @override
  Future<PushPermission> requestPermission() async {
    permissionRequests++;
    return permission;
  }

  @override
  Future<String?> getToken() async => token;

  @override
  Stream<String> get onTokenRefresh => tokenRefresh.stream;

  @override
  Future<void> deleteToken() async {
    deletes++;
    token = 'fcm-${deletes + 1}';
  }

  @override
  Stream<PushMessage> get onForegroundMessage => foreground.stream;

  @override
  Stream<PushMessage> get onMessageOpenedApp => opened.stream;

  @override
  Future<PushMessage?> getInitialMessage() async => initial;

  @override
  Future<void> showForeground(PushMessage message) async {}

  @override
  Stream<String?> get onLocalNotificationTap => localTaps.stream;
}

/// Menuntaskan antrean operasi PushService (berjalan berurutan di luar frame) sebelum hasilnya diperiksa.
Future<void> drainPushQueue(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pumpAndSettle();
  }
}

/// Menghitung request ke [path] dengan [method].
int countRequests(FakeHttpAdapter adapter, String path, {String method = 'GET'}) =>
    adapter.requests.where((r) => r.path == path && r.method == method).length;

/// Pemeriksa sederhana: [matcher] cocok untuk body JSON request terakhir ke [path] dengan [method].
void expectLastBody(FakeHttpAdapter adapter, String path, Object matcher, {String method = 'POST'}) {
  final requests = adapter.requests.where((r) => r.path == path && r.method == method).toList();
  expect(requests, isNotEmpty, reason: '$method $path tidak dipanggil');
  expect(bodyOf(requests.last), matcher);
}
