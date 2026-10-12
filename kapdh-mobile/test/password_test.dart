import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/validation/password.dart';

void main() {
  test('sandi lengkap valid', () => expect(checkPassword('Kapdh#2026').valid, isTrue));
  test('menghitung byte UTF-8, bukan karakter', () {
    final s = 'Aa1!${'a' * 67}é'; // 72 karakter, 73 byte
    expect(checkPassword(s).bytes, 73);
    expect(checkPassword(s).lengthOk, isFalse);
  });
  test('tanpa simbol tidak valid', () => expect(checkPassword('Kapdh2026').valid, isFalse));
}
