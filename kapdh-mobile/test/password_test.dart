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
  test('penghitung: kemajuan menuju minimum, batas 72 byte hanya saat mendekat', () {
    expect(passwordCounter(checkPassword('')), (text: '0/8', problem: true));
    expect(passwordCounter(checkPassword('Kapdh#2')), (text: '7/8', problem: true));
    expect(passwordCounter(checkPassword('Kapdh#2026')), (text: '8/8', problem: false));
    expect(passwordCounter(checkPassword('a' * 70)), (text: '70/72', problem: false));
    expect(passwordCounter(checkPassword('a' * 73)), (text: '73/72', problem: true));
  });
}
