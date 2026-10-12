import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/auth/session.dart';

/// Penanda layar yang dibangun pada irisan berikutnya; tetap memakai tema dan rute nyata.
class PlaceholderScreen extends ConsumerWidget {
  const PlaceholderScreen({super.key, required this.title, required this.note});

  final String title;
  final String note;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(sessionProvider).me;
    final number = me?['member_number'] as String?;
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: ListView(
        padding: const EdgeInsets.all(KapdhSpace.s5),
        children: [
          if (me != null) Text('Assalamu\'alaikum, ${(me['profile'] as Map<String, dynamic>?)?['full_name'] ?? ''}', style: Theme.of(context).textTheme.titleMedium),
          if (number != null) Padding(padding: const EdgeInsets.only(top: KapdhSpace.s2), child: Text('Nomor anggota $number')),
          const SizedBox(height: KapdhSpace.s4),
          Text(note),
          const SizedBox(height: KapdhSpace.s6),
          OutlinedButton(onPressed: () => ref.read(sessionProvider.notifier).logout(), child: const Text('Keluar')),
        ],
      ),
    );
  }
}
