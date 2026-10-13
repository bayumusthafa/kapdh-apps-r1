import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

/// Batas teks pesan (D5 v3.2, `app_settings.chat.max_text_chars`, chat.yaml ChatSendMessageRequest.body).
const int maxChatTextChars = 4000;

/// Panjang teks dalam karakter yang dihitung server (titik kode Unicode, bukan unit UTF-16), sehingga emoji tidak
/// dihitung ganda saat membandingkan dengan batas 4.000.
int chatTextLength(String text) => text.runes.length;

/// Keadaan pesan keluar milik perangkat ini sebelum ack server (AC F11-2, PRD 4.3, 4.5).
enum OutgoingStatus {
  /// Sedang diunggah/dikirim, atau menunggu giliran kirim ulang otomatis.
  sending,

  /// Gagal; dapat dikirim ulang dengan `client_message_id` yang SAMA sehingga server tidak menduplikasi pesan.
  failed,

  /// Ditahan karena keanggotaan tidak aktif (MEMBERSHIP_REQUIRED/ACCOUNT_SUSPENDED, PRD 4.5 "Keanggotaan berakhir
  /// saat chat"): tetap di antrean lokal dengan `client_message_id` yang sama sampai keanggotaan aktif kembali.
  held,
}

/// Golongan kegagalan kirim.
enum SendFailureKind {
  /// Tanpa respons, timeout, 5xx, 429 atau maintenance: hasil belum pasti atau sementara; dikirim ulang otomatis
  /// saat koneksi kembali (aman karena `client_message_id` sama, AC F11-2).
  transient,

  /// Ditolak server secara pasti (400/403/404/409): perlu tindakan pengguna (buka blokir, ubah isi, buang).
  rejected,

  /// Keanggotaan tidak aktif: tahan pengiriman dan tampilkan ajakan perpanjang (PRD 4.5).
  membership,
}

/// Menggolongkan galat pengiriman pesan (AC F11-2, F11-6, PRD 4.5).
SendFailureKind classifySendFailure(ApiException error) {
  if (error.kind != ApiFailureKind.api) return SendFailureKind.transient;
  final code = error.code;
  if (code == ErrorCode.membershipRequired || code == ErrorCode.accountSuspended) return SendFailureKind.membership;
  final status = error.statusCode ?? 0;
  if (code == ErrorCode.rateLimited || code == ErrorCode.maintenance || status == 408 || status >= 500) {
    return SendFailureKind.transient;
  }
  return SendFailureKind.rejected;
}

/// Rujukan pesan yang dibalas, disalin saat menulis agar pratinjau tampil walaupun pesan itu belum/tidak dimuat.
@immutable
class OutgoingReply {
  const OutgoingReply({
    required this.messageId,
    required this.senderName,
    required this.preview,
    required this.hasImage,
  });

  final String messageId;
  final String? senderName;
  final String? preview;
  final bool hasImage;
}

/// Gambar lokal yang akan dikirim (purpose chat_image, N-10). [uploadedFileId] terisi setelah POST /files berhasil
/// sehingga kirim ulang tidak mengunggah dua kali.
@immutable
class OutgoingImage {
  const OutgoingImage({required this.bytes, required this.filename, required this.mime, this.uploadedFileId});

  final Uint8List bytes;
  final String filename;
  final String mime;
  final String? uploadedFileId;

  OutgoingImage withUploadedFile(String fileId) =>
      OutgoingImage(bytes: bytes, filename: filename, mime: mime, uploadedFileId: fileId);
}

/// Pesan keluar di antrean lokal (outbox). Mesin keadaan:
///
/// ```
/// sending --ack 200/201--------------------------> (selesai, keluar dari antrean)
/// sending --galat transient----------------------> failed (autoRetry: true)
/// sending --galat rejected-----------------------> failed (autoRetry: false)
/// sending --MEMBERSHIP_REQUIRED/ACCOUNT_SUSPENDED-> held
/// failed|held --kirim ulang----------------------> sending (client_message_id SAMA)
/// apa pun --pesan server dengan client_message_id sama terlihat (event/sinkron)--> selesai
/// failed|held --buang----------------------------> (keluar dari antrean)
/// ```
@immutable
class OutgoingMessage {
  const OutgoingMessage({
    required this.clientMessageId,
    required this.roomId,
    required this.kind,
    required this.createdAt,
    this.body,
    this.replyTo,
    this.image,
    this.status = OutgoingStatus.sending,
    this.failureMessage,
    this.autoRetry = false,
    this.attempts = 0,
  });

  /// UUID klien yang dipakai ulang di setiap percobaan (AC F11-2, unique messages_sender_id_client_message_id_key).
  final String clientMessageId;
  final String roomId;
  final ChatSendKind kind;

  /// Waktu dibuat di perangkat; hanya untuk urutan tampilan antrean, bukan stempel server.
  final DateTime createdAt;
  final String? body;
  final OutgoingReply? replyTo;
  final OutgoingImage? image;
  final OutgoingStatus status;

  /// Pesan galat terakhir untuk ditampilkan (dari server atau katalog galat).
  final String? failureMessage;

  /// Dikirim ulang otomatis saat koneksi realtime kembali atau room dibuka lagi.
  final bool autoRetry;

  /// Jumlah percobaan kirim yang sudah dimulai.
  final int attempts;

  bool get needsUpload => kind == ChatSendKind.image && image?.uploadedFileId == null;

  OutgoingMessage _copy({
    OutgoingStatus? status,
    String? failureMessage,
    bool clearFailure = false,
    bool? autoRetry,
    int? attempts,
    OutgoingImage? image,
  }) => OutgoingMessage(
    clientMessageId: clientMessageId,
    roomId: roomId,
    kind: kind,
    createdAt: createdAt,
    body: body,
    replyTo: replyTo,
    image: image ?? this.image,
    status: status ?? this.status,
    failureMessage: clearFailure ? null : (failureMessage ?? this.failureMessage),
    autoRetry: autoRetry ?? this.autoRetry,
    attempts: attempts ?? this.attempts,
  );

  /// Percobaan kirim dimulai (pertama kali atau kirim ulang).
  OutgoingMessage started() =>
      _copy(status: OutgoingStatus.sending, clearFailure: true, autoRetry: false, attempts: attempts + 1);

  /// Unggahan gambar selesai; percobaan berikutnya memakai berkas yang sama.
  OutgoingMessage uploaded(String fileId) => _copy(image: image?.withUploadedFile(fileId));

  /// Percobaan gagal dengan [error].
  OutgoingMessage failedWith(ApiException error) => switch (classifySendFailure(error)) {
    SendFailureKind.transient => _copy(status: OutgoingStatus.failed, failureMessage: error.message, autoRetry: true),
    SendFailureKind.rejected => _copy(status: OutgoingStatus.failed, failureMessage: error.message, autoRetry: false),
    SendFailureKind.membership => _copy(status: OutgoingStatus.held, failureMessage: error.message, autoRetry: false),
  };

  /// Ditahan tanpa mencoba server (klien sudah tahu keanggotaan berakhir dari `expires_at` GET /me, PRD 4.5).
  OutgoingMessage heldLocally(String message) =>
      _copy(status: OutgoingStatus.held, failureMessage: message, autoRetry: false);

  /// Body request kirim; `client_message_id` selalu sama untuk pesan ini (AC F11-2).
  ChatSendMessageRequest toRequest() {
    final text = body?.trim();
    return ChatSendMessageRequest(
      clientMessageId: clientMessageId,
      kind: kind,
      body: text == null || text.isEmpty ? null : body,
      imageFileId: image?.uploadedFileId,
      replyToId: replyTo == null ? const Optional<String?>.absent() : Optional<String?>(replyTo!.messageId),
    );
  }
}
