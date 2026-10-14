import 'package:flutter/painting.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Membuang gambar yang sudah didekode dari cache gambar MEMORI Flutter (`PaintingBinding.imageCache`).
///
/// Foto anggota lain (direktori, chat, peserta event; `AlumniAvatar`) dan bukti bayar sendiri (`ProofImageViewer`)
/// adalah berkas privat dari URL bertanda tangan (PRD 5.4) yang sengaja tidak pernah ditulis ke cache disk, tetapi
/// salinan terdekodenya tetap tinggal di memori proses sampai tergusur. Logout, sesi dicabut dan pergantian akun
/// mengosongkannya agar tidak ada gambar akun sebelumnya yang tertinggal di perangkat bersama (PRD 5.2, N-09). Gambar
/// publik (cover, banner) hanya perlu didekode ulang dari cache disknya.
typedef DecodedImageEvictor = void Function();

final decodedImageEvictorProvider = Provider<DecodedImageEvictor>((ref) => evictDecodedImages);

/// Implementasi bawaan [decodedImageEvictorProvider]. Tidak pernah melempar.
void evictDecodedImages() {
  final ImageCache cache;
  try {
    cache = PaintingBinding.instance.imageCache;
  } on Object {
    // Tanpa binding Flutter (uji unit murni) belum ada gambar yang pernah didekode.
    return;
  }
  cache
    ..clear()
    ..clearLiveImages();
}
