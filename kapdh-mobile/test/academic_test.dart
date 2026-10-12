import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/features/membership/academic.dart';

void main() {
  test('kode status pendidikan sesuai tabel PRD 3.5', () {
    expect(educationStatus(1, 6), '01');
    expect(educationStatus(1, 3), '02');
    expect(educationStatus(4, 6), '02');
    expect(educationStatus(4, 5), '03');
    expect(educationStatus(1, 2), '03');
  });
  test('tahun akademik contoh guidelines', () {
    final y = academicYears(30, 1, 6);
    expect([y.entryYear, y.exitYear, y.graduationYear], [2020, 2026, 2026]);
  });
  test('label kelas', () {
    expect(classLabel(1), 'Kelas 1 (1 MTs)');
    expect(classLabel(6), 'Kelas 6 (3 Aliyah)');
  });
}
