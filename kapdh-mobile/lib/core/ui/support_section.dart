import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../design/support_contact_card.dart';
import '../app_gate/app_gate.dart';
import 'external_links.dart';

/// Kontak dukungan dari GET /public/config (`support`) dengan tautan email/WhatsApp (PRD 4.5, 8.3).
class SupportSection extends ConsumerWidget {
  const SupportSection({super.key, this.subject = 'Bantuan Aplikasi KAPDH', this.title = 'Butuh bantuan?'});

  /// Subjek email bantuan; tidak memuat data pribadi.
  final String subject;
  final String title;

  Future<void> _open(BuildContext context, WidgetRef ref, Uri? uri) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final opened = uri != null && await ref.read(externalLinkLauncherProvider)(uri);
    if (!opened) {
      messenger?.showSnackBar(const SnackBar(content: Text('Tidak ada aplikasi yang dapat membuka kontak ini.')));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final support = ref.watch(appGateProvider.select((gate) => gate.support));
    return SupportContactCard(
      title: title,
      email: support?.email,
      whatsapp: support?.whatsapp,
      onEmail: (email) => _open(context, ref, supportEmailUri(email, subject: subject)),
      onWhatsApp: (number) => _open(context, ref, supportWhatsAppUri(number)),
    );
  }
}
