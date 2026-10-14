import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:uuid/uuid.dart';

import '../../core/api/api_providers.dart';
import '../../core/session/session_controller.dart';
import 'chat_repository.dart';
import 'outgoing_message.dart';

/// Pembuat `client_message_id` (UUID v7 berurut waktu); dapat diganti pada uji.
final clientMessageIdProvider = Provider<String Function()>((ref) {
  const uuid = Uuid();
  return uuid.v7;
});

/// Antrean pesan keluar per room (outbox), hidup selama sesi aplikasi sehingga pesan tertunda, gagal atau ditahan
/// tidak hilang saat pengguna meninggalkan layar percakapan (PRD 4.3, 4.5; AC F11-2). Isi pesan hanya di memori
/// perangkat dan tidak pernah dicatat di log (ARCHITECTURE §2 butir 3); antrean dikosongkan saat akun berganti atau
/// keluar.
///
/// Pengiriman per room berurutan (satu per satu sesuai urutan tulis) agar urutan commit server mengikuti urutan
/// pengguna. Setiap percobaan memakai `client_message_id` yang SAMA, sehingga kirim ulang setelah respons hilang
/// mengembalikan pesan yang sama tanpa duplikasi (AC F11-2).
final chatOutboxProvider = NotifierProvider<ChatOutbox, Map<String, List<OutgoingMessage>>>(ChatOutbox.new);

class ChatOutbox extends Notifier<Map<String, List<OutgoingMessage>>> {
  final StreamController<ChatMessage> _acks = StreamController<ChatMessage>.broadcast();
  final Map<String, Future<void>> _chains = {};
  final Set<String> _inFlight = {};

  /// Pesan yang sudah di-ack server (201 baru atau 200 pengulangan) untuk digabung ke garis waktu dan daftar room.
  Stream<ChatMessage> get acknowledged => _acks.stream;

  @override
  Map<String, List<OutgoingMessage>> build() {
    ref.listen<String?>(sessionProvider.select((s) => s.userId), (previous, next) {
      if (previous != next) {
        _chains.clear();
        _inFlight.clear();
        state = const {};
      }
    });
    ref.onDispose(() => unawaited(_acks.close()));
    return const {};
  }

  ChatRepository get _repo => ref.read(chatRepositoryProvider);

  List<OutgoingMessage> forRoom(String roomId) => state[roomId] ?? const [];

  OutgoingMessage? _find(String roomId, String clientMessageId) {
    for (final entry in forRoom(roomId)) {
      if (entry.clientMessageId == clientMessageId) return entry;
    }
    return null;
  }

  void _put(OutgoingMessage entry) {
    final list = [...forRoom(entry.roomId)];
    final index = list.indexWhere((e) => e.clientMessageId == entry.clientMessageId);
    if (index < 0) {
      list.add(entry);
    } else {
      list[index] = entry;
    }
    state = {...state, entry.roomId: list};
  }

  void _remove(String roomId, String clientMessageId) {
    final list = forRoom(roomId).where((e) => e.clientMessageId != clientMessageId).toList();
    final next = {...state};
    if (list.isEmpty) {
      next.remove(roomId);
    } else {
      next[roomId] = list;
    }
    state = next;
  }

  /// Menulis pesan teks baru (1..4000 karakter, tidak hanya spasi; D5 v3.2) lalu mengirimnya. Dengan
  /// [holdReason] pesan langsung ditahan tanpa dikirim (keanggotaan tidak aktif, PRD 4.5).
  OutgoingMessage sendText(String roomId, String text, {OutgoingReply? replyTo, String? holdReason}) => _enqueue(
    OutgoingMessage(
      clientMessageId: ref.read(clientMessageIdProvider)(),
      roomId: roomId,
      kind: ChatSendKind.text,
      createdAt: ref.read(clockProvider)().toUtc(),
      body: text,
      replyTo: replyTo,
    ),
    holdReason,
  );

  /// Menulis pesan gambar (diunggah dulu sebagai chat_image) dengan keterangan opsional.
  OutgoingMessage sendImage(
    String roomId,
    OutgoingImage image, {
    String? caption,
    OutgoingReply? replyTo,
    String? holdReason,
  }) => _enqueue(
    OutgoingMessage(
      clientMessageId: ref.read(clientMessageIdProvider)(),
      roomId: roomId,
      kind: ChatSendKind.image,
      createdAt: ref.read(clockProvider)().toUtc(),
      body: caption == null || caption.trim().isEmpty ? null : caption,
      image: image,
      replyTo: replyTo,
    ),
    holdReason,
  );

  OutgoingMessage _enqueue(OutgoingMessage entry, String? holdReason) {
    if (holdReason != null) {
      final held = entry.heldLocally(holdReason);
      _put(held);
      return held;
    }
    _put(entry);
    _schedule(entry);
    return entry;
  }

  /// Kirim ulang pesan gagal/ditahan dengan `client_message_id` yang sama (AC F11-2).
  void retry(String roomId, String clientMessageId) {
    final entry = _find(roomId, clientMessageId);
    if (entry == null || entry.status == OutgoingStatus.sending) return;
    _put(entry.started());
    _schedule(entry);
  }

  /// Kirim ulang otomatis setelah koneksi kembali atau room dibuka lagi: pesan gagal sementara, dan (bila
  /// [includeHeld]) pesan yang ditahan karena keanggotaan setelah keanggotaan aktif kembali (PRD 4.5).
  void resume(String roomId, {bool includeHeld = false}) {
    final candidates = forRoom(roomId).where(
      (e) => (e.status == OutgoingStatus.failed && e.autoRetry) || (includeHeld && e.status == OutgoingStatus.held),
    );
    for (final entry in [...candidates]..sort((a, b) => a.createdAt.compareTo(b.createdAt))) {
      retry(roomId, entry.clientMessageId);
    }
  }

  /// Tahan seluruh pesan tertunda room ini tanpa mengirim (keanggotaan berakhir menurut `expires_at`, PRD 4.5).
  void holdAll(String roomId, String message) {
    for (final entry in forRoom(roomId)) {
      if (entry.status != OutgoingStatus.held && !_inFlight.contains(entry.clientMessageId)) {
        _put(entry.heldLocally(message));
      }
    }
  }

  /// Pengguna membuang pesan yang gagal/ditahan.
  void discard(String roomId, String clientMessageId) {
    final entry = _find(roomId, clientMessageId);
    if (entry == null || _inFlight.contains(clientMessageId)) return;
    _remove(roomId, clientMessageId);
  }

  /// Pesan server dengan `client_message_id` ini sudah terlihat (event `message.created` atau halaman sinkron),
  /// sehingga salinan lokal dilepas walaupun respons HTTP-nya hilang (AC F11-2, F11-3).
  void resolve(String roomId, String clientMessageId) {
    if (_find(roomId, clientMessageId) == null) return;
    _remove(roomId, clientMessageId);
  }

  /// Membuang antrean room yang tidak lagi dapat diakses (keluar/dikeluarkan dari grup, AC F11-4).
  void clearRoom(String roomId) {
    if (!state.containsKey(roomId)) return;
    state = {...state}..remove(roomId);
  }

  void _schedule(OutgoingMessage entry) {
    final roomId = entry.roomId;
    final previous = _chains[roomId] ?? Future<void>.value();
    final next = previous.then((_) => _attempt(roomId, entry.clientMessageId));
    _chains[roomId] = next;
    unawaited(
      next.whenComplete(() {
        if (identical(_chains[roomId], next)) _chains.remove(roomId);
      }),
    );
  }

  Future<void> _attempt(String roomId, String clientMessageId) async {
    var entry = _find(roomId, clientMessageId);
    // Sudah selesai, dibuang, atau ditahan/digagalkan sebelum gilirannya.
    if (entry == null || entry.status != OutgoingStatus.sending || !_inFlight.add(clientMessageId)) return;
    if (entry.attempts == 0) {
      entry = entry.started();
      _put(entry);
    }
    try {
      final image = entry.image;
      if (entry.needsUpload && image != null) {
        final file = await _repo.uploadChatImage(image.bytes, filename: image.filename, mime: image.mime);
        if (!ref.mounted) return;
        entry = (_find(roomId, clientMessageId) ?? entry).uploaded(file.id);
        _put(entry);
      }
      final message = await _repo.send(roomId, entry.toRequest());
      if (!ref.mounted) return;
      _remove(roomId, clientMessageId);
      if (!_acks.isClosed) _acks.add(message);
    } on ApiException catch (error) {
      if (!ref.mounted) return;
      final current = _find(roomId, clientMessageId);
      if (current != null) _put(current.failedWith(error));
    } catch (error) {
      // Kegagalan di luar SDK (mis. berkas lokal tidak terbaca): hasil belum pasti, pesan tetap dapat dikirim ulang.
      if (!ref.mounted) return;
      final current = _find(roomId, clientMessageId);
      if (current != null) _put(current.failedWith(ApiException(kind: ApiFailureKind.unexpected, cause: error)));
    } finally {
      _inFlight.remove(clientMessageId);
    }
  }
}
