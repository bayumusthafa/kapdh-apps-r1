// Uji model terbangkit: round-trip JSON snake_case <-> camelCase, nullable, allOf, Money sebagai String,
// enum dengan cadangan `unknown` (kompatibilitas maju, N-13) dan field tiga keadaan untuk PATCH.
import 'package:kapdh_api/kapdh_api.dart';
import 'package:test/test.dart';

Map<String, Object?> paymentJson({String status = 'pending'}) => <String, Object?>{
      'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f',
      'type': 'registration',
      'status': status,
      'amount': '60000.00',
      'lines': <Object?>[
        <String, Object?>{'code': 'registration_fee', 'label': 'Iuran pendaftaran', 'amount': '50000.00'},
        <String, Object?>{'code': 'card_fee', 'label': 'Biaya kartu', 'amount': '10000.00'},
      ],
      'method': <String, Object?>{
        'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e60',
        'kind': 'bank',
        'provider': 'BSI',
        'account_number': '7123456789',
        'account_holder': 'KAPDH',
        'instructions': null,
      },
      'proof_version': 1,
      'submitted_at': '2026-10-12T03:15:00.000Z',
      'decided_at': null,
      'rejection_reason': null,
      'created_at': '2026-10-12T03:00:00.000Z',
      'version': '3',
      'stage': 'awaiting_review',
      'actions': <String, Object?>{'can_submit_proof': true, 'can_change_method': false, 'can_cancel': false},
    };

void main() {
  group('round-trip model (PRD 5.2)', () {
    test('Payment: snake_case ke camelCase dan kembali tanpa kehilangan data', () {
      final payment = Payment.fromJson(paymentJson());
      expect(payment.proofVersion, 1);
      expect(payment.method.accountHolder, 'KAPDH');
      expect(payment.submittedAt, DateTime.utc(2026, 10, 12, 3, 15));
      expect(payment.decidedAt, isNull);
      expect(payment.toJson(), <String, Object?>{
        ...paymentJson(),
        // Field opsional bernilai null tidak dikirim ulang.
        'method': <String, Object?>{
          'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e60',
          'kind': 'bank',
          'provider': 'BSI',
          'account_number': '7123456789',
          'account_holder': 'KAPDH',
        },
      }..removeWhere((key, value) => value == null));
      expect(Payment.fromJson(payment.toJson()), payment);
      expect(Payment.fromJson(payment.toJson()).hashCode, payment.hashCode);
    });

    test('Money tetap string desimal, bukan double (ARCHITECTURE §2 butir 5)', () {
      final payment = Payment.fromJson(paymentJson());
      expect(payment.amount, isA<String>());
      expect(payment.amount, '60000.00');
      expect(payment.lines.map((l) => l.amount), <String>['50000.00', '10000.00']);
    });

    test('allOf: PaymentDetail menggabungkan field Payment dan dapat dipakai sebagai Payment', () {
      final detail = PaymentDetail.fromJson(<String, Object?>{
        ...paymentJson(),
        'events': <Object?>[
          <String, Object?>{'at': '2026-10-12T03:00:00.000Z', 'kind': 'created', 'actor': 'member'},
          <String, Object?>{
            'at': '2026-10-12T03:15:00.000Z',
            'kind': 'proof_submitted',
            'actor': 'member',
            'proof_version': 1,
          },
        ],
        'adjustments': <Object?>[],
        'method_active': true,
        'instructions_hidden': false,
      });
      final Payment asPayment = detail;
      expect(asPayment.amount, '60000.00');
      expect(detail.events.last.kind, PaymentEventKind.proofSubmitted);
      expect(PaymentDetail.fromJson(detail.toJson()), detail);
    });

    test('properti yang belum dikenal diabaikan dan list hasil dekode tidak dapat diubah', () {
      final payment = Payment.fromJson(<String, Object?>{...paymentJson(), 'field_baru_dari_server': true});
      expect(payment.toJson().containsKey('field_baru_dari_server'), isFalse);
      expect(() => payment.lines.add(payment.lines.first), throwsUnsupportedError);
    });

    test('field wajib yang hilang menghasilkan FormatException bernama field', () {
      final json = paymentJson()..remove('amount');
      expect(
        () => Payment.fromJson(json),
        throwsA(isA<FormatException>().having((e) => e.message, 'message', contains('amount'))),
      );
      expect(
        () => Payment.fromJson(<String, Object?>{...paymentJson(), 'lines': 'bukan-array'}),
        throwsA(isA<FormatException>().having((e) => e.message, 'message', contains('lines'))),
      );
    });

    test('ref nullable (oneOf + null) dan map bebas pada MemberCard dan ApiError', () {
      final card = MemberCard.fromJson(<String, Object?>{
        'status_label': 'inactive',
        'member_number': '29.01.01.7',
        'full_name': 'Ahmad Islam',
        'cohort': 29,
        'cohort_code': 'KAPDH 29',
        'graduation_year': 2025,
        'qr': null,
        'synced_at': '2026-10-12T03:00:00.000Z',
      });
      expect(card.qr, isNull);
      expect(card.statusLabel, MemberCardStatus.inactive);
      expect(card.graduationYear, 2025);

      final error = ApiError.fromJson(<String, Object?>{
        'code': 'VERSION_CONFLICT',
        'message': 'Data sudah diubah orang lain.',
        'request_id': 'req-1',
        'field_errors': <String, Object?>{
          'email': <Object?>['Email sudah terdaftar'],
        },
        'current': <String, Object?>{'version': '4', 'status': 'paid'},
      });
      expect(error.code, ErrorCode.versionConflict);
      expect(error.fieldErrors, <String, List<String>>{
        'email': <String>['Email sudah terdaftar'],
      });
      expect(error.current, <String, Object?>{'version': '4', 'status': 'paid'});
      expect(ApiError.fromJson(error.toJson()), error);
    });

    test('field bebas opsional yang kosong tidak dikirim sebagai null', () {
      const error = ApiError(code: ErrorCode.notFound, message: 'Tidak ditemukan.', requestId: 'req-2');
      expect(error.toJson().containsKey('current'), isFalse);
      expect(error.toJson(), <String, Object?>{
        'code': 'NOT_FOUND',
        'message': 'Tidak ditemukan.',
        'request_id': 'req-2',
      });
    });

    test('status kartu expired berlabel kedaluwarsa (PRD 2.2)', () {
      expect(MemberCardStatus.fromJson('expired'), MemberCardStatus.expired);
    });
  });

  group('enum dengan cadangan unknown (N-13)', () {
    test('nilai baru dari server tidak membuat dekode gagal', () {
      expect(PaymentStatus.fromJson('paid'), PaymentStatus.paid);
      expect(PaymentStatus.fromJson('refunded'), PaymentStatus.unknown);
      final payment = Payment.fromJson(paymentJson(status: 'refunded'));
      expect(payment.status, PaymentStatus.unknown);
      expect(ErrorCode.fromJson('KODE_MASA_DEPAN'), ErrorCode.unknown);
      expect(EffectiveStatus.fromJson('pending_otp'), EffectiveStatus.pendingOtp);
    });

    test('nilai JSON enum dipertahankan, termasuk nilai berangka dan bertitik', () {
      expect(EducationStatus.fromJson('01'), EducationStatus.v01);
      expect(EducationStatus.v01.toJson(), '01');
      expect(Permission.fromJson('payments.decide'), Permission.paymentsDecide);
      expect(Permission.notificationsManage.value, 'notifications.manage');
      expect(ErrorCode.values.where((c) => c != ErrorCode.unknown), hasLength(21));
      expect(Permission.values.where((p) => p != Permission.unknown), hasLength(15));
    });

    test('unknown dikodekan sebagai string kosong sehingga ditolak server bila terkirim kembali', () {
      expect(PaymentStatus.unknown.toJson(), '');
      expect(PaymentStatus.fromJson(PaymentStatus.unknown.toJson()), PaymentStatus.unknown);
    });
  });

  group('body request', () {
    test('ProfileUpdate membedakan tidak dikirim, null (kosongkan) dan nilai', () {
      expect(const ProfileUpdate(city: 'Bandung').toJson(), <String, Object?>{'city': 'Bandung'});
      expect(
        const ProfileUpdate(professionId: Optional<String?>(null)).toJson(),
        <String, Object?>{'profession_id': null},
      );
      expect(
        const ProfileUpdate(avatarFileId: Optional<String?>('0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e61')).toJson(),
        <String, Object?>{'avatar_file_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e61'},
      );
      final parsed = ProfileUpdate.fromJson(<String, Object?>{'profession_id': null});
      expect(parsed.professionId.isPresent, isTrue);
      expect(parsed.professionId.value, isNull);
      expect(parsed.avatarFileId.isPresent, isFalse);
    });

    test('toString tidak membocorkan sandi, OTP atau token (ARCHITECTURE §2 butir 3)', () {
      const login = LoginRequest(email: 'a@contoh.id', password: 'Rahasia#2026');
      expect(login.toString(), isNot(contains('Rahasia#2026')));
      expect(login.toString(), contains('a@contoh.id'));
      const otp = OtpVerifyRequest(challengeId: '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e62', code: '123456');
      expect(otp.toString(), isNot(contains('123456')));
      final pair = TokenPair(
        accessToken: 'eyJ-rahasia',
        accessExpiresAt: DateTime.utc(2026, 10, 12, 3, 15),
        refreshToken: 'refresh-rahasia',
      );
      expect(pair.toString(), isNot(contains('eyJ-rahasia')));
      expect(pair.toString(), isNot(contains('refresh-rahasia')));
    });

    test('enum dan waktu dikodekan ke nilai kontrak', () {
      const body = CreatePaymentRequest(
        type: MembershipPaymentType.renewal,
        paymentMethodId: '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e60',
      );
      expect(body.toJson(), <String, Object?>{
        'type': 'renewal',
        'payment_method_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e60',
      });
      final session = Session(
        id: '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e63',
        audience: SessionAudience.mobile,
        deviceName: 'Pixel',
        platform: SessionPlatform.android,
        appVersion: '1.0.0',
        createdAt: DateTime.parse('2026-10-12T10:00:00+07:00'),
        lastSeenAt: DateTime.utc(2026, 10, 12, 3),
        expiresAt: DateTime.utc(2026, 12, 11, 3),
        current: true,
      );
      expect(session.toJson()['created_at'], '2026-10-12T03:00:00.000Z');
      expect(session.toJson()['platform'], 'android');
    });
  });

  test('amplop realtime (events/envelope.schema.json) terdekode dengan jenis event', () {
    final envelope = RealtimeEnvelope.fromJson(<String, Object?>{
      'v': 1,
      'event_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f',
      'type': 'message.created',
      'entity_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e60',
      'ts': '2026-10-12T03:15:00.000Z',
      'payload': <String, Object?>{'room_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e61'},
    });
    expect(envelope.type, RealtimeEventType.messageCreated);
    expect(envelope.payload['room_id'], '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e61');
    expect(RealtimeEventType.fromJson('event.baru'), RealtimeEventType.unknown);
    // Payload dapat memuat isi chat: tidak dicetak toString (N-09).
    expect(envelope.toString(), isNot(contains('0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e61')));
  });

  group('RealtimeEvent bertipe per jenis (ARCHITECTURE §4.9)', () {
    Map<String, Object?> eventJson(String type, Map<String, Object?> payload) => <String, Object?>{
          'v': 1,
          'event_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f',
          'type': type,
          'entity_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e60',
          'ts': '2026-10-12T03:15:00.000Z',
          'payload': payload,
        };

    const room = '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e61';
    const user = '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e71';
    const message = '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e60';
    const ts = '2026-10-12T03:15:00.000Z';
    final messageJson = <String, Object?>{
      'id': message,
      'room_id': room,
      'client_message_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e90',
      'kind': 'text',
      'sender': <String, Object?>{'user_id': user, 'full_name': 'Ahmad Islam', 'avatar_url': null},
      'body': 'Isi rahasia',
      'image': null,
      'reply_to': <String, Object?>{
        'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5a',
        'available': false,
        'sender_name': null,
        'preview': null,
        'has_image': false,
      },
      'reactions': <Object?>[],
      'created_at': ts,
      'deleted_at': null,
    };
    // Payload minimum yang sah per jenis (events/<type>.schema.json).
    final samplePayloads = <String, Map<String, Object?>>{
      'message.created': <String, Object?>{'room_id': room, 'message': messageJson},
      'message.deleted': <String, Object?>{'room_id': room, 'message_id': message, 'deleted_at': ts},
      'reaction.updated': <String, Object?>{
        'room_id': room,
        'message_id': message,
        'user_id': user,
        'emoji': '👍',
        'action': 'added',
        'counts': <Object?>[
          <String, Object?>{'emoji': '👍', 'count': 1},
        ],
      },
      'read.updated': <String, Object?>{
        'room_id': room,
        'user_id': user,
        'last_read_message_id': message,
        'last_read_at': ts,
      },
      'room.updated': <String, Object?>{
        'room_id': room,
        'version': '2',
        'changes': <Object?>['group_name'],
        'name': 'Angkatan 29',
        'avatar_url': null,
        'closed_at': null,
      },
      'room.member_changed': <String, Object?>{
        'room_id': room,
        'user_id': user,
        'change': 'joined',
        'role': 'member',
        'member_count': 3,
        'actor_user_id': user,
      },
      'typing': <String, Object?>{'room_id': room, 'user_id': user, 'ttl_seconds': 5},
      'presence': <String, Object?>{'user_id': user, 'status': 'online', 'ttl_seconds': 60},
      'notification.created': <String, Object?>{
        'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4ea0',
        'category': 'chat',
        'title': 'Undangan grup baru',
        'body': null,
        'deep_link': 'kapdh://app/chat/invitations',
        'created_at': ts,
        'unread_count': 1,
      },
      'session.revoked': <String, Object?>{'reason': 'logout_all', 'all_sessions': true},
    };

    test('setiap jenis kontrak menjadi subkelas sendiri dan switch exhaustive', () {
      for (final type in RealtimeEventType.values.where((t) => t != RealtimeEventType.unknown)) {
        final payload = samplePayloads[type.value];
        expect(payload, isNotNull, reason: 'contoh payload ${type.value} belum ada');
        final event = RealtimeEvent.fromJson(eventJson(type.value, payload!));
        expect(event.type, type);
        expect(event, isNot(isA<UnknownRealtimeEvent>()));
        expect(event.eventId, '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f');
        expect(event.ts, DateTime.utc(2026, 10, 12, 3, 15));
      }
      final event = RealtimeEvent.fromJson(eventJson('session.revoked', samplePayloads['session.revoked']!));
      final handled = switch (event) {
        SessionRevokedEvent(:final payload) => payload.reason == SessionRevokedPayloadReason.logoutAll ? 'logout' : 'lain',
        UnknownRealtimeEvent() => 'abaikan',
        _ => 'lain',
      };
      expect(handled, 'logout');
    });

    test('message.created bertipe, isi pesan tidak tercetak, dan bentuknya sama dengan ChatMessage HTTP', () {
      final event = RealtimeEvent.fromJson(eventJson('message.created', samplePayloads['message.created']!));
      final realtime = switch (event) {
        MessageCreatedEvent(:final payload) => payload.message,
        _ => null,
      };
      expect(realtime, isNotNull);
      expect(realtime!.body, 'Isi rahasia');
      expect(realtime.kind, RealtimeChatMessageKind.text);
      expect(realtime.sender?.fullName, 'Ahmad Islam');
      expect(event.toString(), isNot(contains('Isi rahasia')));
      expect(realtime.toString(), isNot(contains('Isi rahasia')));
      // Klien menyimpan pesan realtime dengan model HTTP yang sama (chat.yaml ChatMessage).
      final http = ChatMessage.fromJson(realtime.toJson());
      expect(http.id, message);
      expect(http.kind, ChatMessageKind.text);
      expect(http.replyTo?.available, isFalse);
      expect(http.reactions, isEmpty);
    });

    test('payload menyimpang (field wajib hilang) melempar FormatException', () {
      expect(
        () => RealtimeEvent.fromJson(eventJson('typing', <String, Object?>{'room_id': room})),
        throwsFormatException,
      );
    });

    test('jenis yang belum dikenal menjadi UnknownRealtimeEvent (kompatibilitas maju, N-13)', () {
      final event = RealtimeEvent.fromJson(eventJson('poll.created', <String, Object?>{'x': 1}));
      expect(event, isA<UnknownRealtimeEvent>());
      expect(event.type, RealtimeEventType.unknown);
      expect(event, RealtimeEvent.fromJson(eventJson('poll.created', <String, Object?>{'x': 1})));
    });

    test('amplop yang menyimpang melempar FormatException', () {
      final json = eventJson('typing', <String, Object?>{})..remove('event_id');
      expect(() => RealtimeEvent.fromJson(json), throwsFormatException);
    });
  });
}
