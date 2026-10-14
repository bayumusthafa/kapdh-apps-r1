import 'package:flutter_test/flutter_test.dart';

/// Pemeriksaan otomatis pedoman aksesibilitas Flutter pada layar yang sedang tampil (N-11, U-13):
/// - target sentuh minimal 48×48 dp (Android) dan 44×44 pt (iOS);
/// - setiap elemen yang dapat diketuk berlabel untuk pembaca layar;
/// - kontras teks minimal 4,5:1 (3:1 untuk teks besar, WCAG AA).
///
/// Melengkapi uji pembesaran teks 200 % dan label semantik per layar; pemeriksaan manual TalkBack/VoiceOver tetap
/// dicatat di laporan UAT.
Future<void> expectMeetsAccessibilityGuidelines(WidgetTester tester) async {
  final semantics = tester.ensureSemantics();
  try {
    await tester.pump();
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
  } finally {
    semantics.dispose();
  }
}
