import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

/// Urutan keyset pesan `(created_at, id)` yang sama dengan urutan commit server per room (AC F11-3, chat.yaml).
int compareMessages(ChatMessage a, ChatMessage b) {
  final byTime = a.createdAt.compareTo(b.createdAt);
  return byTime != 0 ? byTime : a.id.compareTo(b.id);
}

/// Salinan pesan dari event `message.created` (bentuk JSON `RealtimeChatMessage` sama dengan `ChatMessage` HTTP,
/// events/README.md), sehingga satu model dipakai untuk riwayat dan event.
ChatMessage chatMessageFromRealtime(RealtimeChatMessage message) => ChatMessage.fromJson(message.toJson());

/// Garis waktu pesan satu room di klien (F-11, AC F11-3, N-02). Kelas murni dan imutabel agar aturan sinkron dapat
/// diuji tanpa jaringan:
///
/// - [messages] selalu urut naik `(created_at, id)` dan unik per `id` (penggabungan berdasarkan ID, tanpa duplikat
///   antara event dan halaman HTTP).
/// - [syncAnchor] = ID pesan terbaru yang diperoleh dari respons HTTP `GET /chat/rooms/{roomId}/messages` (halaman
///   tanpa celah). Event `message.created` dan ack pengiriman TIDAK memajukannya, karena event dari transaksi berbeda
///   dapat tiba tidak berurutan atau hilang saat koneksi putus. Setelah reconnect klien memanggil `after=<jangkar>`
///   sampai `next_cursor` null.
/// - [olderCursor] = `next_cursor` untuk memuat pesan lebih lama (`before`).
@immutable
class ChatTimeline {
  const ChatTimeline._({required this.messages, this.syncAnchor, this.olderCursor, this.loaded = false});

  static const ChatTimeline empty = ChatTimeline._(messages: []);

  /// Pesan urut naik `(created_at, id)`.
  final List<ChatMessage> messages;

  /// Jangkar sinkron dari halaman HTTP; null bila belum ada pesan yang dimuat lewat HTTP.
  final String? syncAnchor;

  /// Cursor `before` untuk halaman lebih lama; null bila riwayat yang boleh dibaca sudah habis.
  final String? olderCursor;

  /// Halaman HTTP terbaru sudah pernah diterima (membedakan "kosong" dari "belum dimuat").
  final bool loaded;

  bool get hasOlder => olderCursor != null;

  bool get isEmpty => messages.isEmpty;

  ChatMessage? get newest => messages.isEmpty ? null : messages.last;

  ChatMessage? get oldest => messages.isEmpty ? null : messages.first;

  int indexOf(String id) => messages.indexWhere((m) => m.id == id);

  ChatMessage? byId(String id) {
    final index = indexOf(id);
    return index < 0 ? null : messages[index];
  }

  /// Pesan milik [userId] dengan `client_message_id` tertentu (mencocokkan pesan optimistis, AC F11-2).
  ChatMessage? byClientId(String userId, String clientMessageId) {
    for (final message in messages.reversed) {
      if (message.clientMessageId == clientMessageId && message.sender?.userId == userId) return message;
    }
    return null;
  }

  ChatTimeline _copy({List<ChatMessage>? messages, String? syncAnchor, String? olderCursor, bool? loaded}) =>
      ChatTimeline._(
        messages: messages ?? this.messages,
        syncAnchor: syncAnchor ?? this.syncAnchor,
        olderCursor: olderCursor,
        loaded: loaded ?? this.loaded,
      );

  /// Menggabungkan [incoming] berdasarkan `id`; salinan baru MENGGANTI salinan lokal (isi, gambar, reaksi,
  /// deleted_at), lalu diurutkan ulang.
  static List<ChatMessage> _merge(List<ChatMessage> current, Iterable<ChatMessage> incoming) {
    final byId = <String, ChatMessage>{for (final m in current) m.id: m};
    for (final m in incoming) {
      byId[m.id] = m;
    }
    return byId.values.toList()..sort(compareMessages);
  }

  /// Halaman terbaru (tanpa cursor), saat room dibuka atau setelah reconnect. Salinan lokal pesan di halaman ini
  /// diganti dengan versi server sehingga penghapusan dan reaksi yang terjadi saat offline tetap diterapkan
  /// (events/README.md "Sinkron setelah reconnect" butir 4). Jangkar maju ke pesan terbaru halaman.
  ///
  /// [fresh] true: garis waktu dimulai ulang dari halaman ini (room baru dibuka, atau jangkar tidak lagi sah);
  /// pesan lokal di luar halaman dibuang agar tidak ada celah tersembunyi di antara keduanya.
  ChatTimeline applyLatestPage(ChatMessagePage page, {bool fresh = false}) {
    final base = fresh ? const <ChatMessage>[] : messages;
    final merged = _merge(base, page.items);
    final pageOldest = page.items.isEmpty ? null : page.items.first;
    // Pesan lokal yang lebih lama dari halaman ini sudah termuat lewat `before`: cursor lama tetap berlaku.
    final keepOlderCursor =
        !fresh && pageOldest != null && merged.isNotEmpty && compareMessages(merged.first, pageOldest) < 0;
    return ChatTimeline._(
      messages: merged,
      syncAnchor: page.items.isEmpty ? (fresh ? null : syncAnchor) : page.items.last.id,
      olderCursor: keepOlderCursor ? olderCursor : page.nextCursor,
      loaded: true,
    );
  }

  /// Halaman lebih lama (`before`): menambah riwayat di atas tanpa mengubah jangkar.
  ChatTimeline applyOlderPage(ChatMessagePage page) =>
      _copy(messages: _merge(messages, page.items), olderCursor: page.nextCursor);

  /// Halaman lama yang dimuat ulang setelah reconnect: mengganti salinan lokal tanpa mengubah cursor lama.
  ChatTimeline replaceWindow(Iterable<ChatMessage> items) =>
      _copy(messages: _merge(messages, items), olderCursor: olderCursor);

  /// Halaman sinkron `after=<jangkar>` (AC F11-3): digabung berdasarkan `id`, jangkar maju ke pesan terbaru halaman.
  ChatTimeline applyAfterPage(ChatMessagePage page) => _copy(
    messages: _merge(messages, page.items),
    syncAnchor: page.items.isEmpty ? syncAnchor : page.items.last.id,
    olderCursor: olderCursor,
  );

  /// Pesan dari event `message.created` atau ack pengiriman: digabung, jangkar TIDAK maju.
  ChatTimeline upsert(ChatMessage message) => _copy(messages: _merge(messages, [message]), olderCursor: olderCursor);

  /// Event `message.deleted`: placeholder tanpa isi, gambar dan reaksi (chat.yaml ChatMessage).
  ChatTimeline markDeleted(String messageId, DateTime deletedAt) {
    final index = indexOf(messageId);
    if (index < 0) return this;
    final current = messages[index];
    final placeholder = ChatMessage(
      id: current.id,
      roomId: current.roomId,
      clientMessageId: current.clientMessageId,
      kind: current.kind,
      sender: current.sender,
      body: null,
      image: null,
      replyTo: current.replyTo,
      reactions: const [],
      createdAt: current.createdAt,
      deletedAt: current.deletedAt ?? deletedAt,
    );
    return _copy(messages: [...messages]..[index] = placeholder, olderCursor: olderCursor);
  }

  /// Ringkasan reaksi terbaru dari respons HTTP (`ChatMessageReactions`).
  ChatTimeline replaceReactions(String messageId, List<ChatReaction> reactions) {
    final index = indexOf(messageId);
    if (index < 0) return this;
    return _copy(
      messages: [...messages]..[index] = _withReactions(messages[index], reactions),
      olderCursor: olderCursor,
    );
  }

  /// Event `reaction.updated`: `counts` adalah ringkasan terbaru semua emoji; `reacted_by_me` dihitung klien dari
  /// `user_id` dan `action` (events/reaction.updated.schema.json).
  ChatTimeline applyReactionEvent(ReactionUpdatedPayload payload, {required String myUserId}) {
    final index = indexOf(payload.messageId);
    if (index < 0) return this;
    final current = messages[index];
    if (current.deletedAt != null) return this;
    final mine = {for (final r in current.reactions) r.emoji: r.reactedByMe};
    final reactions = [
      for (final count in payload.counts)
        ChatReaction(
          emoji: count.emoji,
          count: count.count,
          reactedByMe: payload.userId == myUserId && payload.emoji == count.emoji
              ? payload.action == ReactionUpdatedPayloadAction.added
              : (mine[count.emoji] ?? false),
        ),
    ];
    return _copy(messages: [...messages]..[index] = _withReactions(current, reactions), olderCursor: olderCursor);
  }

  /// Apakah pembaca dengan read cursor [cursorId] sudah membaca [message] (status "terbaca", F-11). Cursor yang
  /// tidak ada di jendela lokal dianggap lebih lama (tidak mengklaim terbaca tanpa bukti).
  bool isReadBy(String? cursorId, ChatMessage message) {
    if (cursorId == null) return false;
    final cursorIndex = indexOf(cursorId);
    if (cursorIndex < 0) return false;
    final messageIndex = indexOf(message.id);
    return messageIndex >= 0 && cursorIndex >= messageIndex;
  }

  static ChatMessage _withReactions(ChatMessage m, List<ChatReaction> reactions) => ChatMessage(
    id: m.id,
    roomId: m.roomId,
    clientMessageId: m.clientMessageId,
    kind: m.kind,
    sender: m.sender,
    body: m.body,
    image: m.image,
    replyTo: m.replyTo,
    reactions: reactions,
    createdAt: m.createdAt,
    deletedAt: m.deletedAt,
  );
}
