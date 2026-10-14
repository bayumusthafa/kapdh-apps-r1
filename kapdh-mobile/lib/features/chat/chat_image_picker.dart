import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import 'outgoing_message.dart';

/// Batas foto chat sebelum diunggah (N-10: JPG/PNG maksimal 5 MB). Server tetap memvalidasi dan menyandikan ulang.
const int chatImageMaxBytes = 5 * 1024 * 1024;

/// Sumber gambar chat.
enum ChatImageSource { camera, gallery }

/// Gambar yang tidak dapat dikirim (bukan JPG/PNG atau terlalu besar).
class ChatImageException implements Exception {
  const ChatImageException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// Memilih gambar chat; null bila pengguna membatalkan. Diganti tiruan pada uji.
typedef ChatImagePicker = Future<OutgoingImage?> Function(ChatImageSource source);

/// Jenis MIME dari tanda tangan berkas (bukan dari nama berkas yang dapat dipalsukan): JPEG `FF D8 FF`, PNG
/// `89 50 4E 47`. Null bila bukan keduanya.
String? sniffChatImageMime(List<int> bytes) {
  if (bytes.length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) {
    return 'image/png';
  }
  return null;
}

final chatImagePickerProvider = Provider<ChatImagePicker>((ref) {
  final picker = ImagePicker();
  return (source) async {
    final file = await picker.pickImage(
      source: source == ChatImageSource.camera ? ImageSource.camera : ImageSource.gallery,
      maxWidth: 2048,
      maxHeight: 2048,
      imageQuality: 85,
      requestFullMetadata: false,
    );
    if (file == null) return null;
    final bytes = await file.readAsBytes();
    final mime = sniffChatImageMime(bytes);
    if (mime == null) throw const ChatImageException('Gunakan foto JPG atau PNG.');
    if (bytes.length > chatImageMaxBytes) throw const ChatImageException('Ukuran foto maksimal 5 MB.');
    final name = file.name.isEmpty ? (mime == 'image/png' ? 'foto.png' : 'foto.jpg') : file.name;
    return OutgoingImage(bytes: bytes, filename: name, mime: mime);
  };
});
