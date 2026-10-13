import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';
import 'outgoing_message.dart';

/// Emoji reaksi cepat di lembar tindakan pesan (F-11).
const List<String> quickReactions = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/// Status kirim pesan milik sendiri yang ditampilkan di gelembung (AC F11-2). Selalu label + ikon (N-11).
enum DeliveryStatus {
  sending('Mengirim', Icons.schedule),
  failed('Gagal terkirim', Icons.error_outline),
  held('Ditahan', Icons.pause_circle_outline),
  sent('Terkirim', Icons.done),
  read('Dibaca', Icons.done_all);

  const DeliveryStatus(this.label, this.icon);

  final String label;
  final IconData icon;
}

DeliveryStatus deliveryOf(OutgoingStatus status) => switch (status) {
  OutgoingStatus.sending => DeliveryStatus.sending,
  OutgoingStatus.failed => DeliveryStatus.failed,
  OutgoingStatus.held => DeliveryStatus.held,
};

/// Pratinjau satu baris untuk balasan dan laporan.
String messagePreviewText(ChatMessage message) {
  if (message.deletedAt != null) return 'Pesan dihapus';
  final body = message.body?.trim();
  if (message.image != null) return body == null || body.isEmpty ? 'Foto' : 'Foto · $body';
  return body ?? '';
}

/// Rujukan balasan dari pesan server (salinan lokal saat menulis, chat.yaml ChatMessageReply).
OutgoingReply replyFrom(ChatMessage message) => OutgoingReply(
  messageId: message.id,
  senderName: message.sender?.fullName,
  preview: message.deletedAt == null ? message.body : null,
  hasImage: message.image != null,
);

/// Warna gelembung (prototipe gaya KAPDH): milik sendiri hijau tua bertulisan putih, orang lain putih bergaris.
class _BubbleColors {
  const _BubbleColors(this.background, this.foreground, this.muted, this.border);

  static const mine = _BubbleColors(KapdhColors.green700, KapdhColors.onPrimary, KapdhExtraColors.mutedOnDark, null);
  static const theirs = _BubbleColors(
    KapdhColors.surface,
    KapdhColors.text,
    KapdhColors.textMuted,
    KapdhColors.divider,
  );

  final Color background;
  final Color foreground;
  final Color muted;
  final Color? border;
}

/// Kutipan pesan yang dibalas. `available=false` (riwayat di luar jangkauan atau terhapus; selalu false pada event
/// realtime) memakai salinan lokal pesan [localCopy] bila ada.
class ReplyQuote extends StatelessWidget {
  const ReplyQuote({
    super.key,
    required this.senderName,
    required this.preview,
    required this.hasImage,
    required this.available,
    this.onDark = false,
  });

  factory ReplyQuote.fromReply(ChatMessageReply reply, {ChatMessage? localCopy, bool onDark = false}) {
    if (!reply.available && localCopy != null && localCopy.deletedAt == null) {
      return ReplyQuote(
        senderName: localCopy.sender?.fullName,
        preview: localCopy.body,
        hasImage: localCopy.image != null,
        available: true,
        onDark: onDark,
      );
    }
    return ReplyQuote(
      senderName: reply.senderName,
      preview: reply.preview,
      hasImage: reply.hasImage,
      available: reply.available,
      onDark: onDark,
    );
  }

  final String? senderName;
  final String? preview;
  final bool hasImage;
  final bool available;
  final bool onDark;

  @override
  Widget build(BuildContext context) {
    final text = !available
        ? 'Pesan tidak tersedia'
        : [if (hasImage) 'Foto', if (preview != null && preview!.trim().isNotEmpty) preview!.trim()].join(' · ');
    final fg = onDark ? KapdhColors.onPrimary : KapdhColors.text;
    final muted = onDark ? KapdhExtraColors.mutedOnDark : KapdhColors.textMuted;
    return Container(
      margin: const EdgeInsets.only(bottom: KapdhSpace.s1),
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s2, KapdhSpace.s1, KapdhSpace.s2, KapdhSpace.s1),
      decoration: BoxDecoration(
        color: onDark ? const Color(0x26FFFFFF) : KapdhColors.green50,
        borderRadius: BorderRadius.circular(KapdhRadius.sm),
        border: Border(left: BorderSide(color: onDark ? KapdhColors.gold400 : KapdhColors.primary, width: 3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (available && senderName != null)
            Text(
              senderName!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: KapdhFontSize.overline, fontWeight: FontWeight.w600, color: fg),
            ),
          Text(
            text.isEmpty ? 'Pesan' : text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: KapdhFontSize.caption,
              color: muted,
              fontStyle: available ? FontStyle.normal : FontStyle.italic,
            ),
          ),
        ],
      ),
    );
  }
}

/// Gambar pesan dari URL bertanda tangan (maksimal 10 menit, PRD 5.4). Gagal dimuat (URL kedaluwarsa, offline)
/// menampilkan tombol muat ulang yang memperbarui jendela pesan dari server.
class ChatImageView extends StatelessWidget {
  const ChatImageView({super.key, required this.image, required this.onReload, this.onOpen});

  final ChatImage image;
  final VoidCallback onReload;
  final VoidCallback? onOpen;

  static const double maxWidth = 220;

  @override
  Widget build(BuildContext context) {
    final w = image.width;
    final h = image.height;
    final aspect = (w != null && h != null && w > 0 && h > 0) ? (w / h).clamp(0.5, 2.0) : 4 / 3;
    // Node semantik sendiri (bukan bagian label gelembung): "Foto" dapat diketuk untuk dibuka layar penuh, dan tombol
    // "Muat ulang foto" saat URL gagal dimuat menjadi anaknya (N-11).
    return Semantics(
      container: true,
      image: true,
      label: 'Foto',
      button: onOpen != null,
      onTapHint: onOpen == null ? null : 'buka foto',
      child: GestureDetector(
        onTap: onOpen,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(KapdhRadius.sm),
          child: SizedBox(
            width: maxWidth,
            child: AspectRatio(
              aspectRatio: aspect.toDouble(),
              child: Image.network(
                image.url,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => ColoredBox(
                  color: KapdhColors.neutral100,
                  child: Center(
                    child: TextButton.icon(
                      onPressed: onReload,
                      icon: const Icon(Icons.refresh),
                      label: const Text('Muat ulang foto'),
                    ),
                  ),
                ),
                loadingBuilder: (_, child, progress) => progress == null
                    ? child
                    : const ColoredBox(
                        color: KapdhColors.neutral100,
                        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Baris reaksi di bawah gelembung; ketuk untuk menambah/menghapus reaksi sendiri.
class ReactionRow extends StatelessWidget {
  const ReactionRow({super.key, required this.reactions, required this.onToggle});

  final List<ChatReaction> reactions;
  final ValueChanged<String>? onToggle;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: KapdhSpace.s1,
      runSpacing: KapdhSpace.s1,
      children: [
        for (final reaction in reactions)
          Semantics(
            button: onToggle != null,
            label: '${reaction.emoji} ${reaction.count}${reaction.reactedByMe ? ', termasuk Anda' : ''}',
            excludeSemantics: true,
            child: InkWell(
              borderRadius: BorderRadius.circular(KapdhRadius.pill),
              onTap: onToggle == null ? null : () => onToggle!(reaction.emoji),
              child: Container(
                constraints: const BoxConstraints(minHeight: 32, minWidth: 44),
                padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s2, vertical: 2),
                decoration: BoxDecoration(
                  color: reaction.reactedByMe ? KapdhColors.green100 : KapdhColors.surface,
                  borderRadius: BorderRadius.circular(KapdhRadius.pill),
                  border: Border.all(color: reaction.reactedByMe ? KapdhColors.primary : KapdhColors.divider),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(reaction.emoji, style: const TextStyle(fontSize: KapdhFontSize.body)),
                    const SizedBox(width: 4),
                    Text('${reaction.count}', style: const TextStyle(fontSize: KapdhFontSize.caption)),
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// Keterangan waktu dan status kirim di bawah isi gelembung.
class BubbleMeta extends StatelessWidget {
  const BubbleMeta({super.key, required this.time, this.status, this.statusDetail, this.onDark = false});

  final String time;
  final DeliveryStatus? status;

  /// Teks tambahan status (mis. "Dibaca 3" di grup).
  final String? statusDetail;
  final bool onDark;

  @override
  Widget build(BuildContext context) {
    final muted = onDark ? KapdhExtraColors.mutedOnDark : KapdhColors.textMuted;
    final statusColor = switch (status) {
      DeliveryStatus.failed => onDark ? const Color(0xFFFFB4AB) : KapdhColors.danger,
      DeliveryStatus.read => onDark ? KapdhColors.gold400 : KapdhColors.info,
      _ => muted,
    };
    // Wrap, bukan Row: pada teks 200 % waktu dan status ("Gagal terkirim", "Dibaca 12") turun ke baris berikut di
    // dalam gelembung yang lebarnya dibatasi, bukan meluap (N-11).
    return Wrap(
      alignment: WrapAlignment.end,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: KapdhSpace.s1,
      children: [
        Text(
          time,
          style: TextStyle(fontSize: KapdhFontSize.overline, color: muted),
        ),
        if (status != null)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(status!.icon, size: 14, color: statusColor),
              const SizedBox(width: 2),
              Flexible(
                child: Text(
                  statusDetail ?? status!.label,
                  style: TextStyle(fontSize: KapdhFontSize.overline, color: statusColor),
                ),
              ),
            ],
          ),
      ],
    );
  }
}

/// Gelembung pesan (server atau keluar) dengan nama pengirim grup, kutipan balasan, gambar, isi, waktu, status dan
/// reaksi.
class ChatBubble extends StatelessWidget {
  const ChatBubble({
    super.key,
    required this.mine,
    required this.time,
    required this.semanticsLabel,
    this.senderName,
    this.reply,
    this.image,
    this.body,
    this.deleted = false,
    this.status,
    this.statusDetail,
    this.reactions = const [],
    this.onToggleReaction,
    this.onLongPress,
    this.onTap,
    this.footer,
  });

  final bool mine;
  final String time;
  final String semanticsLabel;
  final String? senderName;
  final Widget? reply;
  final Widget? image;
  final String? body;
  final bool deleted;
  final DeliveryStatus? status;
  final String? statusDetail;
  final List<ChatReaction> reactions;
  final ValueChanged<String>? onToggleReaction;
  final VoidCallback? onLongPress;
  final VoidCallback? onTap;

  /// Baris di bawah gelembung (mis. galat dan tombol kirim ulang).
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final colors = mine ? _BubbleColors.mine : _BubbleColors.theirs;
    final width = MediaQuery.sizeOf(context).width;
    // Teks gelembung sudah diringkas di [semanticsLabel] sehingga dikecualikan dari pohon semantik; gambar TIDAK,
    // agar tombol "buka foto" dan "Muat ulang foto" (URL bertanda tangan kedaluwarsa) dapat dijangkau pembaca layar
    // (N-11, PRD 5.4).
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (senderName != null)
          ExcludeSemantics(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: Text(
                senderName!,
                style: const TextStyle(
                  fontSize: KapdhFontSize.caption,
                  fontWeight: FontWeight.w600,
                  color: KapdhColors.primary,
                ),
              ),
            ),
          ),
        if (reply != null) ExcludeSemantics(child: reply),
        if (image != null)
          Padding(
            padding: const EdgeInsets.only(bottom: KapdhSpace.s1),
            child: image,
          ),
        if (deleted)
          ExcludeSemantics(
            child: Text(
              'Pesan ini telah dihapus',
              style: TextStyle(fontStyle: FontStyle.italic, color: colors.muted, fontSize: KapdhFontSize.body),
            ),
          )
        else if (body != null && body!.isNotEmpty)
          ExcludeSemantics(
            child: Text(
              body!,
              style: TextStyle(color: colors.foreground, fontSize: KapdhFontSize.body, height: 1.4),
            ),
          ),
        const SizedBox(height: 2),
        ExcludeSemantics(
          child: Align(
            alignment: Alignment.centerRight,
            widthFactor: 1,
            child: BubbleMeta(time: time, status: status, statusDetail: statusDetail, onDark: mine),
          ),
        ),
      ],
    );
    final bubble = GestureDetector(
      onLongPress: onLongPress,
      onTap: onTap,
      // Tindakan semantik disediakan Semantics di atas gelembung (satu node berlabel), bukan node kosong kedua.
      excludeFromSemantics: true,
      child: Container(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s3, KapdhSpace.s2, KapdhSpace.s3, KapdhSpace.s1),
        decoration: BoxDecoration(
          color: colors.background,
          border: colors.border == null ? null : Border.all(color: colors.border!),
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(KapdhRadius.lg),
            topRight: const Radius.circular(KapdhRadius.lg),
            bottomLeft: Radius.circular(mine ? KapdhRadius.lg : 4),
            bottomRight: Radius.circular(mine ? 4 : KapdhRadius.lg),
          ),
        ),
        child: content,
      ),
    );
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: width * 0.78),
        child: Column(
          crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            // Isi gelembung dibacakan sebagai satu label; gambar, reaksi dan keterangan galat tetap dapat dijangkau
            // pembaca layar sebagai elemen terpisah (N-11).
            Semantics(
              container: true,
              label: semanticsLabel,
              onLongPress: onLongPress,
              onTap: onTap,
              onLongPressHint: onLongPress == null ? null : 'tindakan pesan',
              onTapHint: onTap == null ? null : 'pilihan pesan',
              child: bubble,
            ),
            if (reactions.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: ReactionRow(reactions: reactions, onToggle: onToggleReaction),
              ),
            ?footer,
          ],
        ),
      ),
    );
  }
}

/// Pesan sistem (anggota bergabung/keluar, nama grup berubah): pil abu di tengah.
class SystemMessageView extends StatelessWidget {
  const SystemMessageView({super.key, required this.text, required this.time});

  final String text;
  final DateTime time;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: KapdhSpace.s1),
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s3, vertical: KapdhSpace.s1),
        decoration: BoxDecoration(color: KapdhColors.neutralBg, borderRadius: BorderRadius.circular(KapdhRadius.pill)),
        child: Text(
          '$text · ${formatTime(time)}',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.neutral),
        ),
      ),
    );
  }
}

/// Pemisah tanggal di riwayat (zona WIB).
class DateSeparator extends StatelessWidget {
  const DateSeparator({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: KapdhSpace.s2),
      child: Row(
        children: [
          const Expanded(child: Divider()),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s2),
            child: Text(
              label,
              style: const TextStyle(fontSize: KapdhFontSize.overline, color: KapdhColors.textMuted),
            ),
          ),
          const Expanded(child: Divider()),
        ],
      ),
    );
  }
}
