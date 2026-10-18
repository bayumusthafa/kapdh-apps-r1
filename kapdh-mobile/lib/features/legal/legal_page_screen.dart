import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_widget_from_html_core/flutter_widget_from_html_core.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/format/formatters.dart';
import '../../core/ui/external_links.dart';
import '../../core/ui/support_section.dart';
import '../../design/design.dart';
import '../account/widgets/scroll_column.dart';

/// Tautan isi halaman yang boleh dibuka di aplikasi luar: hanya `https` dengan host dan `mailto`. Skema lain
/// (javascript:, intent:, file:, http:, tautan relatif) ditolak (N-09).
Uri? legalExternalLink(String url) {
  final uri = Uri.tryParse(url.trim());
  if (uri == null) return null;
  if (uri.scheme == 'https' && uri.host.isNotEmpty) return uri;
  if (uri.scheme == 'mailto' && uri.path.isNotEmpty) return uri;
  return null;
}

/// Halaman legal dan informasi versi tayang (GET /public/pages/{slug}; F-08, PRD 3.8). Terbuka untuk semua status,
/// sebelum login dan dari portal status (PRD 2.2: legal selalu boleh). HTML sudah disanitasi server; tautan hanya
/// dibuka di aplikasi luar bila https atau email, sehingga isi halaman tidak dapat mengarahkan aplikasi ke skema
/// lain.
class LegalPageScreen extends ConsumerStatefulWidget {
  const LegalPageScreen({super.key, required this.slug});

  /// Parameter rute `slug`.
  final String slug;

  @override
  ConsumerState<LegalPageScreen> createState() => _LegalPageScreenState();
}

class _LegalPageScreenState extends ConsumerState<LegalPageScreen> {
  PublicPage? _page;
  ApiException? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void didUpdateWidget(LegalPageScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.slug != widget.slug) unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await ref.read(kapdhApiProvider).content.getPublicPage(widget.slug);
      if (!mounted) return;
      setState(() {
        _page = page;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  Future<bool> _openLink(String url) async {
    final uri = legalExternalLink(url);
    final messenger = ScaffoldMessenger.maybeOf(context);
    final opened = uri != null && await ref.read(externalLinkLauncherProvider)(uri);
    if (!opened) {
      messenger?.showSnackBar(const SnackBar(content: Text('Tautan ini tidak dapat dibuka.')));
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(title: _page?.title ?? 'Informasi', fallbackLocation: '/', body: _body());
  }

  Widget _body() {
    if (_loading) return const LoadingSkeleton(showCard: false, lines: 10, semanticsLabel: 'Memuat halaman');
    final error = _error;
    if (error != null) {
      if (error.code == ErrorCode.notFound || error.code == ErrorCode.validationError) {
        return const ScrollColumn(
          padding: EdgeInsets.all(KapdhSpace.s5),
          children: [
            SizedBox(
              height: 320,
              child: EmptyState(
                icon: KapdhIcons.descriptionOutlined,
                title: 'Halaman belum tersedia',
                message: 'Halaman ini belum diterbitkan pengurus. Hubungi pengurus bila Anda membutuhkan informasinya.',
              ),
            ),
            SupportSection(),
          ],
        );
      }
      return ErrorState.fromException(error, onRetry: _load);
    }
    final page = _page!;
    return ScrollColumn(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s8),
      children: [
        Semantics(
          header: true,
          child: Text(
            page.title,
            style: const TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w600, height: 1.3),
          ),
        ),
        const SizedBox(height: KapdhSpace.s1),
        Text(
          'Versi ${page.version} · diterbitkan ${formatDate(page.publishedAt)}',
          style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
        ),
        const SizedBox(height: KapdhSpace.s4),
        const Divider(height: 1),
        const SizedBox(height: KapdhSpace.s4),
        HtmlWidget(
          page.bodyHtml,
          textStyle: const TextStyle(fontSize: KapdhFontSize.body, height: 1.6, color: KapdhColors.text),
          onTapUrl: _openLink,
        ),
      ],
    );
  }
}
