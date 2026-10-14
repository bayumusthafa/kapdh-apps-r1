import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/error_presenter.dart';
import '../../core/ui/app_keys.dart';
import 'moderation_repository.dart';

/// Konfirmasi blokir (PRD 4.5, 3.12): efek dua arah dijelaskan sebelum dijalankan.
Future<bool> confirmBlock(BuildContext context, String name) async {
  final result = await showDialog<bool>(
    context: context,
    useRootNavigator: true,
    builder: (dialogContext) => AlertDialog(
      title: Text('Blokir $name?'),
      content: Text(
        'Anda dan $name tidak dapat saling mengirim pesan langsung, reaksi di percakapan langsung, atau undangan '
        'grup. Riwayat pesan lama tetap tersimpan, dan $name tidak diberi tahu. Di grup yang sama, gunakan bisukan '
        'atau laporan.',
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Batal')),
        TextButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: const Text('Blokir')),
      ],
    ),
  );
  return result ?? false;
}

/// Konfirmasi buka blokir; undangan yang sudah dibatalkan tidak dipulihkan (moderation.yaml unblockMember).
Future<bool> confirmUnblock(BuildContext context, String name) async {
  final result = await showDialog<bool>(
    context: context,
    useRootNavigator: true,
    builder: (dialogContext) => AlertDialog(
      title: Text('Buka blokir $name?'),
      content: Text(
        'Anda dapat kembali saling mengirim pesan langsung dengan $name, kecuali bila $name juga membatasi '
        'percakapan. Undangan grup yang sudah dibatalkan tidak dipulihkan.',
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Batal')),
        TextButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: const Text('Buka blokir')),
      ],
    ),
  );
  return result ?? false;
}

void _snack(WidgetRef ref, String message) {
  ref.read(scaffoldMessengerKeyProvider).currentState
    ?..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}

/// Konfirmasi lalu blokir [userId] (AC F12-1). True bila blokir aktif.
Future<bool> blockWithConfirmation(
  BuildContext context,
  WidgetRef ref, {
  required String userId,
  required String name,
}) async {
  if (!await confirmBlock(context, name)) return false;
  try {
    await ref.read(moderationRepositoryProvider).block(userId);
    _snack(ref, '$name diblokir.');
    return true;
  } on ApiException catch (error) {
    await ref.read(errorPresenterProvider).present(error);
    return false;
  }
}

/// Konfirmasi lalu buka blokir [userId]. True bila berhasil.
Future<bool> unblockWithConfirmation(
  BuildContext context,
  WidgetRef ref, {
  required String userId,
  required String name,
}) async {
  if (!await confirmUnblock(context, name)) return false;
  try {
    await ref.read(moderationRepositoryProvider).unblock(userId);
    _snack(ref, 'Blokir $name dibuka.');
    return true;
  } on ApiException catch (error) {
    await ref.read(errorPresenterProvider).present(error);
    return false;
  }
}
