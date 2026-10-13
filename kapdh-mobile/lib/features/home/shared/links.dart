import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/deep_link/deep_links.dart';
import '../../../core/ui/app_keys.dart';
import '../../../core/ui/external_links.dart';

/// Pesan seragam untuk target konten yang sudah tidak tersedia (AC F08-2, AC F13-3).
const String unavailableTargetMessage = 'Konten tujuan sudah tidak tersedia. Mungkin sudah diarsipkan atau dibatalkan.';

/// Tautan luar yang boleh dibuka dari konten: hanya http(s) dengan host, bukan tautan aplikasi KAPDH.
Uri? externalLinkUri(String? raw) {
  if (raw == null) return null;
  final uri = Uri.tryParse(raw.trim());
  if (uri == null || !uri.hasAuthority) return null;
  if (uri.scheme != 'https' && uri.scheme != 'http') return null;
  return uri;
}

/// Menampilkan snackbar singkat lewat messenger akar.
void showAppSnackBar(WidgetRef ref, String message) => showMessengerSnackBar(ref.read(scaffoldMessengerKeyProvider), message);

/// Snackbar lewat kunci messenger akar yang sudah diambil sebelumnya. Dipakai sesudah `await`: kunci messenger
/// hidup selama aplikasi, sedangkan WidgetRef layar tidak boleh dipakai lagi bila layarnya sudah ditutup.
void showMessengerSnackBar(
  GlobalKey<ScaffoldMessengerState> messenger,
  String message, {
  SnackBarAction? action,
  Duration duration = const Duration(seconds: 4),
}) {
  messenger.currentState
    ?..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message), action: action, duration: duration));
}

/// Membuka tautan dari konten (body berita, banner, peta lokasi event):
/// - tautan aplikasi (`kapdh://app/...`, `https://kapdh.or.id/app/...`, path internal) dibuka di dalam aplikasi;
///   router tetap memeriksa akses status (AC F13-3);
/// - tautan luar http(s) dibuka di aplikasi luar sesudah konfirmasi yang menyebut domainnya, sehingga anggota
///   tahu ia meninggalkan aplikasi (PRD 3.8 "tautan luar diberi indikasi yang jelas");
/// - skema lain ditolak dengan pesan.
///
/// Mengembalikan true bila tautan ditangani (dipakai `HtmlWidget.onTapUrl`).
Future<bool> openContentLink(BuildContext context, WidgetRef ref, String raw) async {
  final internal = _internalRoute(raw);
  if (internal != null) {
    unawaited(GoRouter.of(context).push(internal));
    return true;
  }
  final external = externalLinkUri(raw);
  if (external == null) {
    showAppSnackBar(ref, 'Tautan ini tidak dapat dibuka.');
    return true;
  }
  await confirmAndLaunchExternal(context, ref, external);
  return true;
}

/// Konfirmasi lalu buka tautan luar (PRD 3.8). Peluncur dan messenger diambil sebelum dialog karena layar asal
/// bisa ditutup selama dialog terbuka (WidgetRef tidak boleh dipakai sesudahnya).
Future<void> confirmAndLaunchExternal(BuildContext context, WidgetRef ref, Uri uri) async {
  final launcher = ref.read(externalLinkLauncherProvider);
  final messenger = ref.read(scaffoldMessengerKeyProvider);
  if (!await confirmExternalLink(context, uri)) return;
  final launched = await launcher(uri);
  if (!launched) showMessengerSnackBar(messenger, 'Tidak ada aplikasi yang dapat membuka tautan ini.');
}

String? _internalRoute(String raw) {
  final uri = Uri.tryParse(raw.trim());
  if (uri == null) return null;
  final isAppLink =
      uri.scheme.toLowerCase() == DeepLinks.scheme ||
      (uri.scheme.toLowerCase() == 'https' &&
          DeepLinks.webHosts.contains(uri.host.toLowerCase()) &&
          (uri.path == DeepLinks.webPrefix || uri.path.startsWith('${DeepLinks.webPrefix}/'))) ||
      (!uri.hasScheme && !uri.hasAuthority && uri.path.startsWith('/'));
  if (!isAppLink) return null;
  final normalized = DeepLinks.normalize(uri);
  if (normalized == null || normalized.path == '/') return null;
  return normalized.toString();
}

/// Konfirmasi sebelum meninggalkan aplikasi ke tautan luar (PRD 3.8).
Future<bool> confirmExternalLink(BuildContext context, Uri uri) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      icon: const Icon(Icons.open_in_new, color: KapdhColors.primary),
      title: const Text('Buka tautan luar?'),
      content: Text.rich(
        TextSpan(
          children: [
            const TextSpan(text: 'Anda akan meninggalkan aplikasi KAPDH menuju '),
            TextSpan(
              text: uri.host,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const TextSpan(text: '. Isi situs tersebut di luar tanggung jawab pengurus.'),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Batal')),
        TextButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: const Text('Buka')),
      ],
    ),
  );
  return result ?? false;
}

/// Penanda tautan luar: ikon panah keluar dan label pembaca layar (PRD 3.8, N-11).
class ExternalLinkMark extends StatelessWidget {
  const ExternalLinkMark({super.key, this.color = KapdhColors.primary, this.size = 14});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'tautan luar',
    child: Icon(Icons.open_in_new, size: size, color: color),
  );
}
