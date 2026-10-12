// Uji kelas API terbangkit di atas Dio yang diinjeksi: path/query/header (Idempotency-Key, If-Match,
// X-Reauth-Token), body JSON dan multipart (termasuk kirim ulang), respons bertipe, 204 -> void, serta pemetaan
// galat ke ApiException (server, jaringan, dan kegagalan tak terduga).
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:test/test.dart';

/// Adapter HTTP palsu: merekam request beserta body terkirim dan mengembalikan respons dari [handler].
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);

  final ResponseBody Function(RequestOptions options) handler;
  final List<RequestOptions> requests = <RequestOptions>[];

  /// Body mentah setiap request (stream dibaca habis seperti adapter sungguhan).
  final List<String> bodies = <String>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final bytes = <int>[];
    if (requestStream != null) {
      await for (final chunk in requestStream) {
        bytes.addAll(chunk);
      }
    }
    bodies.add(latin1.decode(bytes));
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody jsonBody(Object? body, int status, {Map<String, List<String>> headers = const {}}) =>
    ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: <String, List<String>>{
        Headers.contentTypeHeader: <String>[Headers.jsonContentType],
        ...headers,
      },
    );

(Dio, FakeAdapter) dioWith(ResponseBody Function(RequestOptions options) handler) {
  final adapter = FakeAdapter(handler);
  final dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))..httpClientAdapter = adapter;
  return (dio, adapter);
}

Map<String, Object?> paymentJson() => <String, Object?>{
      'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f',
      'type': 'registration',
      'status': 'pending',
      'amount': '60000.00',
      'lines': <Object?>[],
      'method': <String, Object?>{
        'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e60',
        'kind': 'bank',
        'provider': 'BSI',
        'account_number': '7123456789',
        'account_holder': 'KAPDH',
      },
      'proof_version': 2,
      'created_at': '2026-10-12T03:00:00.000Z',
      'version': '4',
      'stage': 'awaiting_review',
      'actions': <String, Object?>{'can_submit_proof': true, 'can_change_method': false, 'can_cancel': false},
      'events': <Object?>[],
      'adjustments': <Object?>[],
      'method_active': true,
      'instructions_hidden': false,
    };

Map<String, Object?> errorJson(String code, {Object? current, int? retry}) => <String, Object?>{
      'code': code,
      'message': 'Pesan dari server.',
      'request_id': 'req-123',
      'current': ?current,
      'retry_after_seconds': ?retry,
    };

void main() {
  test('submitPaymentProof: PUT path terenkode, Idempotency-Key, body JSON dan respons PaymentDetail', () async {
    final (dio, adapter) = dioWith((_) => jsonBody(paymentJson(), 200));
    final payment = await KapdhApi(dio).payments.submitPaymentProof(
          '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f',
          const SubmitPaymentProofRequest(
            fileId: '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e64',
            transferNote: 'BSI',
            expectedProofVersion: 1,
          ),
          idempotencyKey: '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e65',
        );
    expect(payment.proofVersion, 2);
    expect(payment.stage, PaymentStage.awaitingReview);
    final request = adapter.requests.single;
    expect(request.method, 'PUT');
    expect(request.uri.toString(),
        'http://api.test/api/v1/me/payments/0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f/proof');
    expect(request.headers['Idempotency-Key'], '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e65');
    expect(request.data, <String, Object?>{
      'file_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e64',
      'transfer_note': 'BSI',
      'expected_proof_version': 1,
    });
    expect(request.extra[kapdhOperationIdKey], 'submitPaymentProof');
    expect(request.extra[kapdhAuthRequiredKey], isTrue);
  });

  test('operasi publik ditandai authRequired=false agar interceptor tidak refresh (ARCHITECTURE §8.3)', () async {
    final (dio, adapter) = dioWith(
      (_) => jsonBody(<String, Object?>{
        'next': 'home',
        'session': <String, Object?>{
          'access_token': 'a',
          'access_expires_at': '2026-10-12T03:15:00.000Z',
        },
      }, 200),
    );
    final result = await AuthApi(dio).login(const LoginRequest(email: 'a@contoh.id', password: 'Kapdh#2026'));
    expect(result.next, LoginNext.home);
    expect(adapter.requests.single.extra[kapdhAuthRequiredKey], isFalse);
  });

  test('respons 204 menjadi Future<void>', () async {
    final (dio, adapter) = dioWith((_) => ResponseBody.fromString('', 204));
    await AuthApi(dio).logout();
    expect(adapter.requests.single.path, '/auth/logout');
  });

  test('query opsional dikirim hanya bila diisi; enum memakai nilai kontrak', () async {
    final (dio, adapter) = dioWith(
      (_) => jsonBody(<String, Object?>{'items': <Object?>[], 'total': 0, 'next_cursor': null}, 200),
    );
    final page = await AdminPaymentsApi(dio).adminListPayments(status: PaymentStatus.pending, limit: 50);
    expect(page.total, 0);
    expect(adapter.requests.single.queryParameters, <String, Object?>{'status': 'pending', 'limit': 50});
  });

  test('If-Match dan X-Reauth-Token dikirim sebagai header (AC F15-3)', () async {
    final (dio, adapter) = dioWith(
      (_) => jsonBody(<String, Object?>{
        'registration_fee': '50000.00',
        'card_fee': '10000.00',
        'renewal_fee': '15000.00',
        'registration_total': '60000.00',
        'version': '2',
        'effective_from': '2026-10-12T03:00:00.000Z',
      }, 200),
    );
    final fees = await AdminSettingsApi(dio).adminUpdateFees(
      const FeeSettingsInput(registrationFee: '50000.00', cardFee: '10000.00', renewalFee: '15000.00'),
      ifMatch: '1',
      reauthToken: 'reauth-xyz',
    );
    expect(fees.renewalFee, '15000.00');
    final headers = adapter.requests.single.headers;
    expect(headers['If-Match'], '1');
    expect(headers['X-Reauth-Token'], 'reauth-xyz');
  });

  test('parameter path enum dan unggah multipart/form-data', () async {
    final (dio, adapter) = dioWith(
      (options) => options.path.startsWith('/masters')
          ? jsonBody(<String, Object?>{
              'items': <Object?>[
                <String, Object?>{'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e66', 'label': 'Guru'},
              ],
            }, 200)
          : jsonBody(<String, Object?>{
              'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e67',
              'purpose': 'payment_proof',
              'mime': 'image/png',
              'bytes': 3,
            }, 201),
    );
    final masters = await MeApi(dio).listMasters(MasterKind.professions);
    expect(masters.items.single.label, 'Guru');
    expect(adapter.requests.first.path, '/masters/professions');

    final file = await FilesApi(dio).uploadFile(
      FileUploadRequest(
        purpose: FilePurpose.paymentProof,
        file: MultipartFile.fromBytes(<int>[1, 2, 3], filename: 'bukti.png'),
      ),
    );
    expect(file.purpose, FilePurpose.paymentProof);
    final upload = adapter.requests.last;
    expect(upload.data, isA<FormData>());
    final form = upload.data as FormData;
    expect(form.fields.single.key, 'purpose');
    expect(form.fields.single.value, 'payment_proof');
    expect(form.files.single.key, 'file');
    expect(form.files.single.value.filename, 'bukti.png');
  });

  group('multipart dapat dikirim ulang (PRD 4.3, F03-2)', () {
    Map<String, Object?> fileJson() => <String, Object?>{
          'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e67',
          'purpose': 'payment_proof',
          'mime': 'image/png',
          'bytes': 3,
        };

    test('objek request yang sama dikirim dua kali ("Coba lagi") tanpa galat finalized', () async {
      final (dio, adapter) = dioWith((_) => jsonBody(fileJson(), 201));
      final request = FileUploadRequest(
        purpose: FilePurpose.paymentProof,
        file: MultipartFile.fromBytes(<int>[0x41, 0x42, 0x43], filename: 'bukti.png'),
      );
      final api = FilesApi(dio);
      await api.uploadFile(request);
      await api.uploadFile(request);
      expect(adapter.requests, hasLength(2));
      for (final body in adapter.bodies) {
        expect(body, contains('filename="bukti.png"'));
        expect(body, contains('ABC'));
      }
    });

    test('interceptor refresh 401 mengirim ulang body multipart lewat retryableRequest (ARCHITECTURE §8.3)', () async {
      var calls = 0;
      final (dio, adapter) = dioWith((_) {
        calls += 1;
        return calls == 1 ? jsonBody(errorJson('UNAUTHENTICATED'), 401) : jsonBody(fileJson(), 201);
      });
      dio.interceptors.add(InterceptorsWrapper(
        onError: (error, handler) async {
          if (error.response?.statusCode != 401 || error.requestOptions.extra['retried'] == true) {
            handler.next(error);
            return;
          }
          final retry = retryableRequest(error.requestOptions)..extra['retried'] = true;
          try {
            handler.resolve(await dio.fetch<Object?>(retry));
          } on DioException catch (e) {
            handler.next(e);
          }
        },
      ));
      final file = await FilesApi(dio).uploadFile(
        FileUploadRequest(
          purpose: FilePurpose.paymentProof,
          file: MultipartFile.fromBytes(<int>[0x41, 0x42, 0x43], filename: 'bukti.png'),
        ),
      );
      expect(file.bytes, 3);
      expect(adapter.requests, hasLength(2));
      expect(adapter.bodies.last, contains('ABC'));
    });
  });

  group('ApiException dari skema Error (PRD 5.2)', () {
    test('konflik versi membawa kode, current dan perilaku muat ulang', () async {
      final (dio, _) = dioWith(
        (_) => jsonBody(errorJson('VERSION_CONFLICT', current: <String, Object?>{'version': '5'}), 409),
      );
      final error = await MeApi(dio)
          .updateMyProfile(const ProfileUpdate(city: 'Bandung'), ifMatch: '4')
          .then<ApiException?>((_) => null, onError: (Object e) => e as ApiException);
      expect(error, isNotNull);
      expect(error!.kind, ApiFailureKind.api);
      expect(error.statusCode, 409);
      expect(error.code, ErrorCode.versionConflict);
      expect(error.current, <String, Object?>{'version': '5'});
      expect(error.ui.action, ErrorUiAction.reloadLatest);
      expect(error.message, 'Pesan dari server.');
      expect(error.requestId, 'req-123');
      expect(error.operationId, 'updateMyProfile');
    });

    test('RATE_LIMITED memakai retry_after_seconds atau header Retry-After', () async {
      final (dio, _) = dioWith(
        (_) => jsonBody(errorJson('RATE_LIMITED'), 429, headers: <String, List<String>>{
          'retry-after': <String>['42'],
        }),
      );
      await expectLater(
        AuthApi(dio).resendOtp(const OtpResendRequest(challengeId: '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e68')),
        throwsA(isA<ApiException>()
            .having((e) => e.retryAfter, 'retryAfter', const Duration(seconds: 42))
            .having((e) => e.ui.action, 'action', ErrorUiAction.showCountdown)),
      );
    });

    test('kode galat yang belum dikenal tetap aman (cadangan unknown)', () async {
      final (dio, _) = dioWith((_) => jsonBody(errorJson('KODE_MASA_DEPAN'), 400));
      await expectLater(
        MeApi(dio).getMe(),
        throwsA(isA<ApiException>()
            .having((e) => e.code, 'code', ErrorCode.unknown)
            .having((e) => e.ui.action, 'action', ErrorUiAction.showRetry)
            .having((e) => e.message, 'message', 'Pesan dari server.')),
      );
    });

    test('jaringan putus menjadi network, bukan logout atau tidak ditemukan (PRD 4.5)', () async {
      final (dio, _) = dioWith((options) => throw DioException.connectionError(
            requestOptions: options,
            reason: 'offline',
          ));
      await expectLater(
        MeApi(dio).getMe(),
        throwsA(isA<ApiException>()
            .having((e) => e.kind, 'kind', ApiFailureKind.network)
            .having((e) => e.isNetwork, 'isNetwork', isTrue)
            .having((e) => e.ui.action, 'action', ErrorUiAction.showOffline)),
      );
    });

    test('galat I/O soket dan timeout menjadi network', () async {
      final (dio, _) = dioWith((_) => throw const SocketException('Network is unreachable'));
      await expectLater(
        MeApi(dio).getMe(),
        throwsA(isA<ApiException>().having((e) => e.kind, 'kind', ApiFailureKind.network)),
      );
      final timeout = ApiException.fromDio(
        DioException.connectionTimeout(
          timeout: const Duration(seconds: 10),
          requestOptions: RequestOptions(path: '/me'),
        ),
      );
      expect(timeout.kind, ApiFailureKind.network);
    });

    test('galat pemrograman/interceptor dan sertifikat ditolak bukan offline (PRD 4.5)', () async {
      final (dio, _) = dioWith((_) => throw StateError('bug di interceptor'));
      await expectLater(
        MeApi(dio).getMe(),
        throwsA(isA<ApiException>()
            .having((e) => e.kind, 'kind', ApiFailureKind.unexpected)
            .having((e) => e.isNetwork, 'isNetwork', isFalse)
            .having((e) => e.ui.action, 'action', ErrorUiAction.showRetry)
            .having((e) => e.cause, 'cause', isA<DioException>())),
      );
      final certificate = ApiException.fromDio(
        DioException.badCertificate(requestOptions: RequestOptions(path: '/me')),
      );
      expect(certificate.kind, ApiFailureKind.unexpected);
      expect(certificate.ui.action, ErrorUiAction.showRetry);
    });

    test('HTML 502 dari proxy menjadi invalidResponse dengan pesan cadangan', () async {
      final (dio, _) = dioWith(
        (_) => ResponseBody.fromString('<html>Bad Gateway</html>', 502, headers: <String, List<String>>{
          Headers.contentTypeHeader: <String>['text/html'],
          'x-request-id': <String>['req-proxy'],
        }),
      );
      await expectLater(
        PublicApi(dio).getPublicConfig(),
        throwsA(isA<ApiException>()
            .having((e) => e.kind, 'kind', ApiFailureKind.invalidResponse)
            .having((e) => e.statusCode, 'statusCode', 502)
            .having((e) => e.requestId, 'requestId', 'req-proxy')
            .having((e) => e.message, 'message', 'Terjadi kesalahan. Coba lagi.')),
      );
    });

    test('body sukses yang menyimpang dari kontrak menjadi invalidResponse', () async {
      final (dio, _) = dioWith((_) => jsonBody(<String, Object?>{'tidak': 'sesuai'}, 200));
      await expectLater(
        MeApi(dio).getMe(),
        throwsA(isA<ApiException>().having((e) => e.kind, 'kind', ApiFailureKind.invalidResponse)),
      );
    });
  });
}
