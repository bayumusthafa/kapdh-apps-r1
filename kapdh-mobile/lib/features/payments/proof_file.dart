import 'dart:io';

import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

/// Batas ukuran gambar bukti (N-10: gambar <= 5 MB; sama dengan `MAX_IMAGE_BYTES` server).
const int maxProofImageBytes = 5 * 1024 * 1024;

/// Batas ukuran PDF bukti (N-10: PDF <= 10 MB, hanya untuk bukti pembayaran; `MAX_PDF_BYTES` server).
const int maxProofPdfBytes = 10 * 1024 * 1024;

/// Kompresi foto saat diambil/dipilih agar hasilnya jauh di bawah 5 MB tanpa membuat nominal dan tanggal transfer
/// sulit dibaca pengurus (N-10). JPEG kualitas 80 pada sisi terpanjang 2048 px biasanya < 1,5 MB.
const double proofImageMaxDimension = 2048;
const int proofImageQuality = 80;

/// Jenis berkas bukti yang diterima (N-10, PRD 2.5: PDF hanya untuk bukti pembayaran).
enum ProofKind {
  jpeg('image/jpeg', 'jpg'),
  png('image/png', 'png'),
  webp('image/webp', 'webp'),
  pdf('application/pdf', 'pdf');

  const ProofKind(this.mime, this.extension);

  final String mime;
  final String extension;

  bool get isImage => this != pdf;

  int get maxBytes => this == pdf ? maxProofPdfBytes : maxProofImageBytes;
}

/// Jenis berkas dari magic bytes (bukan ekstensi, sama seperti pemeriksaan server); null bila tidak dikenal.
ProofKind? detectProofKind(List<int> header) {
  bool startsWith(List<int> signature, [int offset = 0]) {
    if (header.length < offset + signature.length) return false;
    for (var i = 0; i < signature.length; i++) {
      if (header[offset + i] != signature[i]) return false;
    }
    return true;
  }

  if (startsWith(const [0xFF, 0xD8, 0xFF])) return ProofKind.jpeg;
  if (startsWith(const [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return ProofKind.png;
  // RIFF....WEBP
  if (startsWith(const [0x52, 0x49, 0x46, 0x46]) && startsWith(const [0x57, 0x45, 0x42, 0x50], 8)) {
    return ProofKind.webp;
  }
  if (startsWith(const [0x25, 0x50, 0x44, 0x46, 0x2D])) return ProofKind.pdf; // %PDF-
  return null;
}

/// Hasil pemeriksaan berkas di perangkat sebelum diunggah. Server tetap memeriksa ulang (magic bytes, decoding aman,
/// EXIF, kuota; PRD 2.1) sehingga ini hanya pra-validasi agar pengguna segera tahu tipe/ukuran yang diterima
/// (PRD 4.5 "Bukti tidak valid").
@immutable
sealed class ProofCheck {
  const ProofCheck();
}

final class ProofAccepted extends ProofCheck {
  const ProofAccepted(this.kind);

  final ProofKind kind;
}

final class ProofRejected extends ProofCheck {
  const ProofRejected(this.message);

  final String message;
}

/// Pra-validasi bukti: tipe dari [header] (minimal 12 byte pertama) dan [sizeBytes] terhadap batas N-10.
/// [expectPdf] true bila dipilih lewat pemilih PDF (berkas berekstensi .pdf yang isinya bukan PDF ditolak).
ProofCheck checkProof({required List<int> header, required int sizeBytes, bool expectPdf = false}) {
  if (sizeBytes <= 0) return const ProofRejected('Berkas kosong atau tidak dapat dibaca. Pilih berkas lain.');
  final kind = detectProofKind(header);
  if (kind == null || (expectPdf && kind != ProofKind.pdf)) {
    return const ProofRejected('Berkas harus berupa foto JPG/PNG atau PDF.');
  }
  if (sizeBytes > kind.maxBytes) {
    return ProofRejected(
      kind == ProofKind.pdf
          ? 'PDF maksimal 10 MB. Pilih PDF lain atau kirim foto/tangkapan layar bukti transfer.'
          : 'Foto maksimal 5 MB. Ambil ulang foto atau kirim tangkapan layar dari aplikasi bank.',
    );
  }
  return ProofAccepted(kind);
}

/// Berkas bukti terpilih yang sudah lolos pra-validasi.
@immutable
class PickedProof {
  const PickedProof({required this.name, required this.sizeBytes, required this.kind, this.path, this.bytes})
    : assert(path != null || bytes != null, 'path atau bytes wajib diisi');

  /// Nama tampilan pada tile unggah (prototipe layar 3 "bukti-transfer.jpg").
  final String name;
  final int sizeBytes;
  final ProofKind kind;
  final String? path;
  final Uint8List? bytes;

  bool get isPdf => kind == ProofKind.pdf;

  /// Nama berkas yang dikirim: ekstensi selalu sesuai isi, karena server menolak ekstensi/Content-Type yang
  /// menyamarkan tipe (415). Nama asli tidak dikirim (dapat memuat data pribadi).
  String get uploadName => 'bukti-transfer.${kind.extension}';

  Future<MultipartFile> toMultipartFile() async {
    final contentType = DioMediaType.parse(kind.mime);
    final data = bytes;
    if (data != null) return MultipartFile.fromBytes(data, filename: uploadName, contentType: contentType);
    return MultipartFile.fromFile(path!, filename: uploadName, contentType: contentType);
  }
}

/// Sumber berkas bukti (PRD 4.6 "bayar iuran": foto kamera, galeri, atau PDF).
enum ProofSource { camera, gallery, pdf }

/// Hasil memilih berkas: dibatalkan pengguna, diterima, atau ditolak pra-validasi.
@immutable
sealed class ProofPickResult {
  const ProofPickResult();
}

final class ProofPickCancelled extends ProofPickResult {
  const ProofPickCancelled();
}

final class ProofPicked extends ProofPickResult {
  const ProofPicked(this.proof);

  final PickedProof proof;
}

final class ProofPickRejected extends ProofPickResult {
  const ProofPickRejected(this.message);

  final String message;
}

/// Pemilih berkas bukti; diganti tiruan pada uji.
abstract interface class ProofPicker {
  Future<ProofPickResult> pick(ProofSource source);
}

/// image_picker (kamera/galeri, terkompresi) dan file_picker (PDF).
class DeviceProofPicker implements ProofPicker {
  DeviceProofPicker({ImagePicker? imagePicker}) : _images = imagePicker ?? ImagePicker();

  final ImagePicker _images;

  @override
  Future<ProofPickResult> pick(ProofSource source) async {
    try {
      return switch (source) {
        ProofSource.camera => await _pickImage(ImageSource.camera),
        ProofSource.gallery => await _pickImage(ImageSource.gallery),
        ProofSource.pdf => await _pickPdf(),
      };
    } on Exception catch (error) {
      // Izin kamera/galeri ditolak atau pemilih gagal dibuka; tidak ada data berkas yang dicatat.
      debugPrint('bukti: pemilih berkas gagal (${error.runtimeType})');
      return const ProofPickRejected(
        'Berkas tidak dapat dibuka. Periksa izin kamera/penyimpanan untuk aplikasi KAPDH lalu coba lagi.',
      );
    }
  }

  Future<ProofPickResult> _pickImage(ImageSource source) async {
    final file = await _images.pickImage(
      source: source,
      maxWidth: proofImageMaxDimension,
      maxHeight: proofImageMaxDimension,
      imageQuality: proofImageQuality,
      // Metadata lokasi tidak diminta; server tetap membuang EXIF (N-10).
      requestFullMetadata: false,
    );
    if (file == null) return const ProofPickCancelled();
    final size = await file.length();
    final header = await _header(file.openRead(0, 16));
    return _result(name: file.name, path: file.path, sizeBytes: size, header: header);
  }

  Future<ProofPickResult> _pickPdf() async {
    final result = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: const ['pdf']);
    final file = result?.files.singleOrNull;
    final path = file?.path;
    if (file == null || path == null) return const ProofPickCancelled();
    final header = await _header(File(path).openRead(0, 16));
    return _result(name: file.name, path: path, sizeBytes: file.size, header: header, expectPdf: true);
  }

  static Future<List<int>> _header(Stream<List<int>> stream) async {
    final bytes = <int>[];
    await for (final chunk in stream) {
      bytes.addAll(chunk);
      if (bytes.length >= 16) break;
    }
    return bytes;
  }

  static ProofPickResult _result({
    required String name,
    required String path,
    required int sizeBytes,
    required List<int> header,
    bool expectPdf = false,
  }) => switch (checkProof(header: header, sizeBytes: sizeBytes, expectPdf: expectPdf)) {
    ProofAccepted(:final kind) => ProofPicked(PickedProof(name: name, path: path, sizeBytes: sizeBytes, kind: kind)),
    ProofRejected(:final message) => ProofPickRejected(message),
  };
}

final proofPickerProvider = Provider<ProofPicker>((ref) => DeviceProofPicker());
