/// Data uji jejaring mengikuti skema final network.yaml, moderation.yaml dan me.yaml (listMasters).
library;

import '../../support/fakes.dart';
import '../chat/chat_fixtures.dart';

Map<String, Object?> masterRefJson(String id, String label, {bool active = true}) => {
  'id': id,
  'label': label,
  'active': active,
};

/// `DirectoryMember`: hanya field kartu (tanpa kontak, AC F10-2).
Map<String, Object?> directoryMemberJson({
  required String userId,
  required String name,
  int cohort = 29,
  String? city = 'Pekanbaru',
  Map<String, Object?>? profession,
  List<Map<String, Object?>> skills = const [],
  String? institution = 'Universitas Indonesia',
}) => {
  'user_id': userId,
  'full_name': name,
  'avatar_url': null,
  'cohort': cohort,
  'cohort_code': 'KAPDH $cohort',
  'city': city,
  'profession': profession,
  'last_education_institution': institution,
  'last_education_city': null,
  'skills': skills,
};

Map<String, Object?> directoryPageJson(List<Map<String, Object?>> items, {int? total, String? nextCursor}) => {
  'items': items,
  'total': total ?? items.length,
  'next_cursor': nextCursor,
};

/// `NetworkMemberProfile`. Kunci email/phone/social hanya ditambahkan bila [email]/[phone]/[social] diisi, persis
/// seperti server yang tidak mengirim kunci bila flag privasi mati (AC F10-2).
Map<String, Object?> profileJson({
  String userId = 'user-2',
  String name = 'Ahmad Islam',
  bool isMe = false,
  bool isBlockedByMe = false,
  bool canMessage = true,
  String? directRoomId,
  String? email,
  String? phone,
  Map<String, Object?>? social,
  String? bio = 'Guru lulusan pondok pesantren.',
  Map<String, Object?>? profession,
  List<Map<String, Object?>>? skills,
}) => {
  'user_id': userId,
  'full_name': name,
  'avatar_url': null,
  'cohort': 1,
  'cohort_code': 'KAPDH 01',
  'graduation_year': 1997,
  'city': 'Pekanbaru',
  'profession': profession ?? masterRefJson('p-1', 'Guru'),
  'skills': skills ?? [masterRefJson('s-1', 'Mengajar'), masterRefJson('s-2', 'Berhitung Cepat', active: false)],
  'last_education_institution': 'Universitas Indonesia',
  'last_education_city': 'Jakarta',
  'bio': bio,
  'email': ?email,
  'phone': ?phone,
  'social': ?social,
  'is_me': isMe,
  'is_blocked_by_me': isBlockedByMe,
  'can_message': canMessage,
  'direct_room_id': directRoomId,
};

Map<String, Object?> mastersJson(List<Map<String, Object?>> items) => {'items': items};

Map<String, Object?> masterItemJson(String id, String label) => {'id': id, 'label': label, 'active': true};

Map<String, Object?> blockedJson(String userId, String name) => {
  'user_id': userId,
  'full_name': name,
  'avatar_url': null,
  'blocked_at': iso(testNow.subtract(const Duration(days: 5))),
};

/// `ModerationReport` dari sudut pandang pelapor (tanpa bukti/identitas pengurus, AC F12-2).
Map<String, Object?> reportJson({
  String id = 'report-1',
  String category = 'harassment',
  String targetType = 'user',
  String? targetName = 'Gamerisa Dewi',
  String? roomName,
  String status = 'open',
  String priority = 'normal',
  String? outcome,
  String? decisionMessage,
  String? description,
}) => {
  'id': id,
  'category': category,
  'target_type': targetType,
  'target_name': targetName,
  'room_name': roomName,
  'description': description,
  'status': status,
  'priority': priority,
  'outcome': outcome,
  'decision_message': decisionMessage,
  'created_at': iso(testNow.subtract(const Duration(hours: 3))),
  'due_at': iso(testNow.add(const Duration(days: 2))),
  'resolved_at': status == 'resolved' || status == 'dismissed' ? iso(testNow) : null,
};

/// Penangan dasar untuk layar Jejaring: daftar room kosong dan master.
Map<String, FakeHandler> networkBaseRoutes() => {
  '/me': (_) => FakeResponse.json(200, meJson()),
  '/chat/rooms': (_) => FakeResponse.json(200, roomPageJson(const [])),
  '/masters/professions': (_) =>
      FakeResponse.json(200, mastersJson([masterItemJson('p-1', 'Guru'), masterItemJson('p-2', 'Senior Developer')])),
  '/masters/skills': (_) => FakeResponse.json(
    200,
    mastersJson([masterItemJson('s-1', 'Publik Speaking'), masterItemJson('s-2', 'English Reading')]),
  ),
};
