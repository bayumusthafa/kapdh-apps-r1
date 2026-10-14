import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

/// Batas foto profil (N-10, PRD 2.5): JPG/PNG/WebP maksimal 5 MB. Server memeriksa ulang magic bytes, dimensi dan
/// membuang EXIF; pemeriksaan klien hanya mencegah unggahan yang pasti ditolak (dan kuota yang terbuang).
const int avatarMaxBytes = 5 * 1024 * 1024;

/// Sumber foto yang dipilih pengguna.
enum AvatarSource { camera, gallery }

/// Foto yang dipilih: isi dan nama berkas (nama hanya untuk multipart; server tidak menyimpan nama asli).
@immutable
class PickedAvatar {
  const PickedAvatar({required this.bytes, required this.name});

  final Uint8List bytes;
  final String name;
}

typedef AvatarPicker = Future<PickedAvatar?> Function(AvatarSource source);

/// Pemilih foto (image_picker); diganti tiruan pada uji. Foto diperkecil ke sisi terpanjang 1024 px agar unggahan
/// ringan; server tetap meng-encode ulang.
final avatarPickerProvider = Provider<AvatarPicker>((ref) {
  final picker = ImagePicker();
  return (source) async {
    final file = await picker.pickImage(
      source: source == AvatarSource.camera ? ImageSource.camera : ImageSource.gallery,
      maxWidth: 1024,
      maxHeight: 1024,
      imageQuality: 88,
      preferredCameraDevice: CameraDevice.front,
    );
    if (file == null) return null;
    return PickedAvatar(bytes: await file.readAsBytes(), name: file.name);
  };
});

/// Jenis gambar dari magic bytes (bukan ekstensi), sama seperti pemeriksaan server (PRD 2.5).
String? imageMimeOf(Uint8List bytes) {
  bool startsWith(List<int> signature, [int offset = 0]) {
    if (bytes.length < offset + signature.length) return false;
    for (var i = 0; i < signature.length; i++) {
      if (bytes[offset + i] != signature[i]) return false;
    }
    return true;
  }

  if (startsWith(const [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (startsWith(const [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  // RIFF....WEBP
  if (startsWith(const [0x52, 0x49, 0x46, 0x46]) && startsWith(const [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

/// Pesan penolakan lokal untuk foto profil; null bila boleh diunggah.
String? avatarProblem(PickedAvatar avatar) {
  if (avatar.bytes.isEmpty) return 'Foto kosong atau tidak dapat dibaca.';
  if (imageMimeOf(avatar.bytes) == null) return 'Gunakan foto JPG, PNG atau WebP.';
  if (avatar.bytes.length > avatarMaxBytes) return 'Ukuran foto melebihi 5 MB.';
  return null;
}

/// Bagian multipart `file` untuk POST /files (purpose avatar).
MultipartFile avatarMultipart(PickedAvatar avatar) {
  final mime = imageMimeOf(avatar.bytes) ?? 'application/octet-stream';
  final extension = switch (mime) {
    'image/png' => 'png',
    'image/webp' => 'webp',
    _ => 'jpg',
  };
  return MultipartFile.fromBytes(avatar.bytes, filename: 'avatar.$extension', contentType: DioMediaType.parse(mime));
}
