import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/format/formatters.dart';

void main() {
  group('Rupiah dari Money string tanpa floating point (ARCHITECTURE §2 butir 5)', () {
    test('format tampilan', () {
      expect(formatRupiah('60000.00'), 'Rp60.000');
      expect(formatRupiah('10000'), 'Rp10.000');
      expect(formatRupiah('0.00'), 'Rp0');
      expect(formatRupiah('1234567.50'), 'Rp1.234.567,50');
      expect(formatRupiah('999.5'), 'Rp999,50');
      expect(formatRupiah('0001000.00'), 'Rp1.000');
      expect(formatRupiah('-25000.00'), '-Rp25.000');
      expect(formatRupiah('-0.00'), 'Rp0');
      expect(formatRupiah('9007199254740993.00'), 'Rp9.007.199.254.740.993');
    });

    test('nilai tidak valid ditolak', () {
      for (final bad in ['', 'abc', '1,000.00', '1.234.56', '60000.123']) {
        expect(() => formatRupiah(bad), throwsFormatException, reason: bad);
      }
    });

    test('nominal salin hanya digit', () {
      expect(rupiahDigits('60000.00'), '60000');
      expect(rupiahDigits('60000.50'), '60000,50');
    });
  });

  group('waktu Asia/Jakarta dan zona event (PRD 2.1)', () {
    final instant = DateTime.utc(2026, 10, 12, 7, 20);

    test('WIB bawaan, tidak bergantung zona perangkat', () {
      expect(formatDateTime(instant), '12 Okt 2026, 14.20 WIB');
      expect(formatDate(instant), '12 Okt 2026');
      expect(formatTime(instant), '14.20 WIB');
      expect(formatDateNumeric(DateTime.utc(2027, 10, 12, 18)), '13/10/2027');
    });

    test('event dengan zona sendiri: WITA dan WIT', () {
      expect(formatDateTime(instant, zone: 'Asia/Makassar'), '12 Okt 2026, 15.20 WITA');
      expect(formatDateTime(instant, zone: 'Asia/Jayapura'), '12 Okt 2026, 16.20 WIT');
    });

    test('zona tidak dikenal kembali ke Asia/Jakarta', () {
      expect(formatTime(instant, zone: 'Bukan/Zona'), '14.20 WIB');
    });

    test('waktu relatif', () {
      final now = DateTime.utc(2026, 10, 12, 7);
      expect(formatRelative(now.subtract(const Duration(seconds: 20)), now: now), 'baru saja');
      expect(formatRelative(now.subtract(const Duration(minutes: 5)), now: now), '5 menit lalu');
      expect(formatRelative(now.subtract(const Duration(hours: 3)), now: now), '3 jam lalu');
      expect(formatRelative(DateTime.utc(2026, 10, 11, 9), now: now), 'kemarin, 16.00 WIB');
      expect(formatRelative(DateTime.utc(2026, 10, 8, 9), now: now), '4 hari lalu');
      expect(formatRelative(DateTime.utc(2026, 9, 1, 9), now: now), '1 Sep 2026');
      // Jam perangkat tertinggal dari server.
      expect(formatRelative(now.add(const Duration(seconds: 30)), now: now), 'baru saja');
    });

    test('pergantian hari mengikuti WIB, bukan UTC', () {
      // 12 Okt 18.30 UTC = 13 Okt 01.30 WIB; sekarang 13 Okt 08.00 WIB.
      final now = DateTime.utc(2026, 10, 13, 1);
      expect(formatRelative(DateTime.utc(2026, 10, 12, 18, 30), now: now), '6 jam lalu');
      expect(formatRelative(DateTime.utc(2026, 10, 12, 16, 30), now: now), 'kemarin, 23.30 WIB');
    });
  });

  test('hitung mundur m:ss dibulatkan ke atas', () {
    expect(formatCountdown(const Duration(seconds: 42)), '0:42');
    expect(formatCountdown(const Duration(milliseconds: 41100)), '0:42');
    expect(formatCountdown(const Duration(minutes: 1, seconds: 5)), '1:05');
    expect(formatCountdown(const Duration(seconds: -3)), '0:00');
  });

  test('ukuran berkas', () {
    expect(formatFileSize(512), '512 B');
    expect(formatFileSize(850 * 1024), '850 KB');
    expect(formatFileSize((1.2 * 1024 * 1024).round()), '1,2 MB');
  });

  test('inisial nama', () {
    expect(initialsOf('Ahmad Islam'), 'AI');
    expect(initialsOf('  siti  '), 'S');
    expect(initialsOf('Muhammad Nur Hidayat'), 'MH');
    expect(initialsOf(''), '?');
  });
}
