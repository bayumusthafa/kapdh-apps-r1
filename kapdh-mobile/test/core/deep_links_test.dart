import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/deep_link/deep_links.dart';

void main() {
  test('bentuk tautan aplikasi yang sah dinormalkan ke rute internal (ARCHITECTURE §4.7)', () {
    expect(DeepLinks.parse('/payments/pay-1').toString(), '/payments/pay-1');
    expect(DeepLinks.parse('kapdh://app/payments/pay-1').toString(), '/payments/pay-1');
    expect(DeepLinks.parse('KAPDH://APP/news/berita?ref=push').toString(), '/news/berita?ref=push');
    expect(DeepLinks.parse('https://kapdh.or.id/app/tickets/tk-1').toString(), '/tickets/tk-1');
    expect(DeepLinks.parse('https://www.kapdh.or.id/app').toString(), '/');
    expect(DeepLinks.parse('/app/kta/').toString(), '/kta');
    expect(DeepLinks.parse('  /notifications  ').toString(), '/notifications');
  });

  test('tautan luar, host lain, path traversal dan nilai kosong ditolak', () {
    for (final raw in [
      null,
      '',
      'https://evil.example/app/kta',
      'http://kapdh.or.id/app/kta',
      'https://kapdh.or.id/kta',
      'kapdh://lain/kta',
      'javascript:alert(1)',
      '//evil.example/kta',
      'kta',
      '/${'a' * 2100}',
    ]) {
      expect(DeepLinks.parse(raw), isNull, reason: raw);
    }
  });

  test('segmen titik dinormalkan sehingga tetap di dalam rute aplikasi', () {
    expect(DeepLinks.parse('/payments/../admin').toString(), '/admin');
    expect(DeepLinks.parse('kapdh://app/./kta').toString(), '/kta');
  });
}
