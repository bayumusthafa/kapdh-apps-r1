import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../design/kapdh_button.dart';
import '../../design/kapdh_text_field.dart';
import '../session/repositories.dart';

/// Dialog konfirmasi sandi untuk tindakan sensitif (POST /auth/reauth, token berlaku 10 menit; ARCHITECTURE §4.3).
/// Mengembalikan `reauth_token` atau null bila dibatalkan. Sandi tidak pernah disimpan atau dicatat.
Future<String?> showReauthDialog(BuildContext context, {String? reason}) {
  return showDialog<String>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _ReauthDialog(reason: reason),
  );
}

class _ReauthDialog extends ConsumerStatefulWidget {
  const _ReauthDialog({this.reason});

  final String? reason;

  @override
  ConsumerState<_ReauthDialog> createState() => _ReauthDialogState();
}

class _ReauthDialogState extends ConsumerState<_ReauthDialog> {
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_password.text.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await ref.read(authRepositoryProvider).reauthenticate(_password.text);
      if (mounted) Navigator.of(context).pop(response.reauthToken);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.fieldErrors['password']?.join(' ') ?? error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Konfirmasi identitas'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              widget.reason ?? 'Masukkan password Anda untuk melanjutkan tindakan ini.',
              style: TextStyle(fontSize: KapdhFontSize.body, color: context.kc.textMuted),
            ),
            const SizedBox(height: KapdhSpace.s4),
            KapdhTextField(
              label: 'Password',
              controller: _password,
              hint: 'Masukkan password',
              obscurable: true,
              autofocus: true,
              autofillHints: const [AutofillHints.password],
              errorText: _error,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _submit(),
              onChanged: (_) => setState(() {}),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: const Text('Batal')),
        KapdhButton.solid(
          label: 'Konfirmasi',
          busyLabel: 'Memeriksa...',
          busy: _busy,
          expand: false,
          onPressed: _password.text.isEmpty ? null : _submit,
        ),
      ],
    );
  }
}
