import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

/// Membuka tautan di aplikasi luar (toko aplikasi, email, WhatsApp). Mengembalikan false bila tidak ada aplikasi yang
/// dapat membukanya. Diganti tiruan pada uji.
typedef ExternalLinkLauncher = Future<bool> Function(Uri uri);

final externalLinkLauncherProvider = Provider<ExternalLinkLauncher>(
  (ref) =>
      (uri) => launchUrl(uri, mode: LaunchMode.externalApplication),
);

/// Tautan email bantuan (PRD 8.3, `app_settings.support.email`).
Uri supportEmailUri(String email, {String? subject}) =>
    Uri(scheme: 'mailto', path: email, query: subject == null ? null : 'subject=${Uri.encodeComponent(subject)}');

/// Tautan WhatsApp bantuan dari nomor di `app_settings.support.whatsapp` (mis. "+62 812-3456-7890" atau
/// "0812..."). Nomor lokal berawalan 0 diubah ke kode negara 62. Null bila nomor tidak sah.
Uri? supportWhatsAppUri(String number) {
  var digits = number.replaceAll(RegExp(r'[^0-9]'), '');
  if (digits.startsWith('0')) digits = '62${digits.substring(1)}';
  if (digits.length < 8 || digits.length > 15) return null;
  return Uri.https('wa.me', '/$digits');
}
