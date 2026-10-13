import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/features/chat/outgoing_message.dart';

import '../../support/fakes.dart';

OutgoingMessage _draft() => OutgoingMessage(
  clientMessageId: 'c-1',
  roomId: 'room-1',
  kind: ChatSendKind.text,
  createdAt: testNow,
  body: 'Assalamualaikum',
);

void main() {
  group('Mesin keadaan pesan keluar (AC F11-2, PRD 4.3, 4.5)', () {
    test('AC F11-2: galat jaringan/5xx/429/maintenance = sementara; dikirim ulang otomatis', () {
      expect(classifySendFailure(networkError()), SendFailureKind.transient);
      expect(classifySendFailure(apiError(500, 'INTERNAL_ERROR', 'Galat')), SendFailureKind.transient);
      expect(classifySendFailure(apiError(429, 'RATE_LIMITED', 'Terlalu cepat')), SendFailureKind.transient);
      expect(classifySendFailure(apiError(503, 'MAINTENANCE', 'Pemeliharaan')), SendFailureKind.transient);
    });

    test('AC F11-6: MEMBERSHIP_REQUIRED/ACCOUNT_SUSPENDED = ditahan; 400/403/404/409 = ditolak pasti', () {
      expect(classifySendFailure(apiError(403, 'MEMBERSHIP_REQUIRED', 'Kedaluwarsa')), SendFailureKind.membership);
      expect(classifySendFailure(apiError(403, 'ACCOUNT_SUSPENDED', 'Dibatasi')), SendFailureKind.membership);
      expect(classifySendFailure(apiError(403, 'FORBIDDEN', 'Diblokir')), SendFailureKind.rejected);
      expect(classifySendFailure(apiError(400, 'VALIDATION_ERROR', 'Isi')), SendFailureKind.rejected);
      expect(classifySendFailure(apiError(409, 'IDEMPOTENCY_CONFLICT', 'Konflik')), SendFailureKind.rejected);
    });

    test('AC F11-2: sending -> failed -> kirim ulang memakai client_message_id yang SAMA', () {
      final first = _draft().started();
      expect(first.status, OutgoingStatus.sending);
      expect(first.attempts, 1);
      final failed = first.failedWith(networkError());
      expect(failed.status, OutgoingStatus.failed);
      expect(failed.autoRetry, isTrue);
      expect(failed.failureMessage, isNotEmpty);
      final retry = failed.started();
      expect(retry.status, OutgoingStatus.sending);
      expect(retry.attempts, 2);
      expect(retry.failureMessage, isNull);
      expect(retry.toRequest().clientMessageId, first.toRequest().clientMessageId);
    });

    test('AC F11-2: ditolak pasti tidak dikirim ulang otomatis', () {
      final failed = _draft().started().failedWith(apiError(403, 'FORBIDDEN', 'Tidak dapat mengirim'));
      expect(failed.status, OutgoingStatus.failed);
      expect(failed.autoRetry, isFalse);
      expect(failed.failureMessage, 'Tidak dapat mengirim');
    });

    test('PRD 4.5: keanggotaan berakhir menahan pesan (held) tanpa membuangnya', () {
      final held = _draft().started().failedWith(apiError(403, 'MEMBERSHIP_REQUIRED', 'Perpanjang KTA'));
      expect(held.status, OutgoingStatus.held);
      expect(held.autoRetry, isFalse);
      final local = _draft().heldLocally('Ditahan');
      expect(local.status, OutgoingStatus.held);
      expect(local.attempts, 0);
    });

    test('gambar: unggahan tercatat sehingga kirim ulang tidak mengunggah dua kali', () {
      final draft = OutgoingMessage(
        clientMessageId: 'c-2',
        roomId: 'room-1',
        kind: ChatSendKind.image,
        createdAt: testNow,
        image: OutgoingImage(bytes: Uint8List.fromList([0xFF, 0xD8, 0xFF]), filename: 'a.jpg', mime: 'image/jpeg'),
      );
      expect(draft.needsUpload, isTrue);
      final uploaded = draft.uploaded('file-9');
      expect(uploaded.needsUpload, isFalse);
      final request = uploaded.toRequest();
      expect(request.imageFileId, 'file-9');
      expect(request.body, isNull);
      expect(request.kind, ChatSendKind.image);
    });

    test('balasan: reply_to_id dikirim; tanpa balasan field tidak dikirim', () {
      final reply = OutgoingMessage(
        clientMessageId: 'c-3',
        roomId: 'room-1',
        kind: ChatSendKind.text,
        createdAt: testNow,
        body: 'Setuju',
        replyTo: const OutgoingReply(messageId: 'm-1', senderName: 'Gamerisa', preview: 'Halo', hasImage: false),
      );
      expect(reply.toRequest().toJson()['reply_to_id'], 'm-1');
      expect(_draft().toRequest().toJson().containsKey('reply_to_id'), isFalse);
    });

    test('D5 v3.2: panjang teks dihitung per titik kode (emoji tidak dihitung ganda)', () {
      expect(chatTextLength('a' * maxChatTextChars), maxChatTextChars);
      expect(chatTextLength('😀' * 10), 10);
    });
  });
}
