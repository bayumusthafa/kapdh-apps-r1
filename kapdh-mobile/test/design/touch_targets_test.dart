import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/features/chat/chat_message_widgets.dart';
import 'package:kapdh_api/kapdh_api.dart' show ChatReaction;
import 'package:kapdh_mobile/features/network/widgets/tag_chip.dart';

import '../support/widget_harness.dart';
import 'package:kapdh_mobile/design/kapdh_icons.dart';

/// Target sentuh minimal 48 dp (ui-ux-pro-max `touch-target-size`, Material) untuk kontrol kecil hasil audit mockup.
void main() {
  testWidgets('chip filter: seluruh chip menghapus filter, area ketuk setinggi 48', (tester) async {
    var deleted = 0;
    await pumpDesign(
      tester,
      Center(
        child: TagChip(label: 'Angkatan 12', onDeleted: () => deleted++),
      ),
    );
    expect(tester.getSize(find.byType(InputChip)).height, greaterThanOrEqualTo(48));
    await tester.tap(find.text('Angkatan 12'));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.byIcon(KapdhIcons.close));
    await tester.pump(const Duration(milliseconds: 400));
    expect(deleted, 2);
  });

  testWidgets('reaksi chat: pil 32 dp dengan area ketuk 48 dp', (tester) async {
    final toggled = <String>[];
    await pumpDesign(
      tester,
      Center(
        child: ReactionRow(
          reactions: const [ChatReaction(emoji: '👍', count: 2, reactedByMe: true)],
          onToggle: toggled.add,
        ),
      ),
    );
    final ink = tester.getRect(find.byType(InkWell));
    expect(ink.height, greaterThanOrEqualTo(48));
    // Ketukan di tepi atas area (di luar pil terlihat) tetap mengubah reaksi.
    await tester.tapAt(Offset(ink.center.dx, ink.top + 3));
    expect(toggled, ['👍']);
  });
}
