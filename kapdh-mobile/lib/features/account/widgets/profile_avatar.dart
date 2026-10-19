import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../../app/theme/kapdh_palette.dart';
import '../../../core/format/formatters.dart';

/// Foto profil bulat (guideline hal. 7). Urutan sumber: [bytes] pratinjau lokal (foto baru yang belum disimpan),
/// lalu [url] (publik atau bertanda tangan <= 10 menit, PRD 5.4), lalu inisial nama. Foto gagal dimuat jatuh ke
/// inisial, tidak pernah menampilkan galat mentah.
class ProfileAvatar extends StatelessWidget {
  const ProfileAvatar({super.key, required this.name, this.url, this.bytes, this.size = 72});

  final String name;
  final String? url;
  final Uint8List? bytes;
  final double size;

  @override
  Widget build(BuildContext context) {
    final initials = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      color: context.kc.tintStrong,
      child: Text(
        initialsOf(name),
        maxLines: 1,
        softWrap: false,
        // Lingkaran berukuran tetap: inisial tidak ikut skala teks (mockup .avatar--profile tanpa var(--ts)).
        textScaler: TextScaler.noScaling,
        style: TextStyle(fontSize: size * 0.34, fontWeight: FontWeight.w600, height: 1, color: context.kc.primary),
      ),
    );
    final Widget image;
    final local = bytes;
    final remote = url;
    if (local != null) {
      image = Image.memory(
        local,
        width: size,
        height: size,
        fit: BoxFit.cover,
        gaplessPlayback: true,
        errorBuilder: (_, _, _) => initials,
      );
    } else if (remote != null && remote.isNotEmpty) {
      image = Image.network(
        remote,
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => initials,
        loadingBuilder: (context, child, progress) => progress == null ? child : initials,
      );
    } else {
      image = initials;
    }
    return Semantics(
      image: true,
      label: 'Foto profil $name',
      excludeSemantics: true,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: context.kc.surface, width: 3),
          boxShadow: const [BoxShadow(color: Color(0x1F000000), blurRadius: 8, offset: Offset(0, 2))],
        ),
        child: ClipOval(child: image),
      ),
    );
  }
}
