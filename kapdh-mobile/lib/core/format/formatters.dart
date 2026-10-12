import 'package:intl/date_symbol_data_local.dart';
import 'package:intl/intl.dart';
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

/// Zona waktu tampilan bawaan (PRD 2.1): tanggal ditampilkan dalam Asia/Jakarta kecuali event menetapkan zona lain.
const String jakartaZone = 'Asia/Jakarta';

bool _initialized = false;

/// Inisialisasi data tanggal Bahasa Indonesia dan basis data zona waktu. Dipanggil sekali saat bootstrap dan di uji.
Future<void> initFormatting() async {
  if (_initialized) return;
  tzdata.initializeTimeZones();
  await initializeDateFormatting('id');
  Intl.defaultLocale = 'id';
  _initialized = true;
}

/// Format uang Rupiah dari string desimal kontrak `Money` ("60000.00") tanpa aritmetika floating point
/// (ARCHITECTURE §2 butir 5): `Rp60.000`, `Rp1.234.567,50`.
String formatRupiah(String money) {
  final value = money.trim();
  final match = RegExp(r'^(-)?(\d+)(?:\.(\d{1,2}))?$').firstMatch(value);
  if (match == null) throw FormatException('Nilai uang tidak valid', money);
  final negative = match.group(1) != null;
  final integer = match.group(2)!.replaceFirst(RegExp(r'^0+(?=\d)'), '');
  final fraction = (match.group(3) ?? '').padRight(2, '0');
  final grouped = StringBuffer();
  for (var i = 0; i < integer.length; i++) {
    if (i > 0 && (integer.length - i) % 3 == 0) grouped.write('.');
    grouped.write(integer[i]);
  }
  final isZero = integer == '0' && fraction == '00';
  final sign = negative && !isZero ? '-' : '';
  final cents = fraction == '00' ? '' : ',$fraction';
  return '${sign}Rp$grouped$cents';
}

/// Nominal untuk disalin ke aplikasi bank: hanya digit, tanpa pemisah (mis. "60000").
String rupiahDigits(String money) {
  final match = RegExp(r'^(\d+)(?:\.(\d{1,2}))?$').firstMatch(money.trim());
  if (match == null) throw FormatException('Nilai uang tidak valid', money);
  final fraction = match.group(2) ?? '';
  final integer = match.group(1)!.replaceFirst(RegExp(r'^0+(?=\d)'), '');
  return fraction.replaceAll('0', '').isEmpty ? integer : '$integer,${fraction.padRight(2, '0')}';
}

tz.Location _location(String zone) {
  try {
    return tz.getLocation(zone);
  } on Object {
    return tz.getLocation(jakartaZone);
  }
}

/// Singkatan zona Indonesia (WIB/WITA/WIT); zona lain memakai singkatan basis data tz.
String zoneAbbreviation(tz.TZDateTime local) => switch (local.location.name) {
  'Asia/Jakarta' || 'Asia/Pontianak' => 'WIB',
  'Asia/Makassar' => 'WITA',
  'Asia/Jayapura' => 'WIT',
  _ => local.timeZoneName,
};

/// `12 Okt 2026, 14.20 WIB` (prototipe layar 4, 7). [zone] untuk event dengan zona sendiri (PRD 2.1).
String formatDateTime(DateTime instant, {String zone = jakartaZone}) {
  final local = tz.TZDateTime.from(instant.toUtc(), _location(zone));
  return '${DateFormat('d MMM y', 'id').format(local)}, ${DateFormat('HH.mm', 'id').format(local)} '
      '${zoneAbbreviation(local)}';
}

/// `12 Okt 2026` dalam zona tampilan.
String formatDate(DateTime instant, {String zone = jakartaZone}) =>
    DateFormat('d MMM y', 'id').format(tz.TZDateTime.from(instant.toUtc(), _location(zone)));

/// `13/10/2027` untuk masa berlaku KTA (prototipe layar 7, guideline hal. 6).
String formatDateNumeric(DateTime instant, {String zone = jakartaZone}) =>
    DateFormat('dd/MM/yyyy', 'id').format(tz.TZDateTime.from(instant.toUtc(), _location(zone)));

/// `14.20 WIB`.
String formatTime(DateTime instant, {String zone = jakartaZone}) {
  final local = tz.TZDateTime.from(instant.toUtc(), _location(zone));
  return '${DateFormat('HH.mm', 'id').format(local)} ${zoneAbbreviation(local)}';
}

/// Waktu relatif untuk kotak masuk dan chat: "baru saja", "5 menit lalu", "kemarin", lalu tanggal.
String formatRelative(DateTime instant, {required DateTime now, String zone = jakartaZone}) {
  final diff = now.toUtc().difference(instant.toUtc());
  if (diff.isNegative) {
    // Jam perangkat tertinggal dari server: jangan tampilkan "dalam x menit" yang membingungkan.
    return diff.abs() < const Duration(minutes: 1) ? 'baru saja' : formatDateTime(instant, zone: zone);
  }
  if (diff < const Duration(minutes: 1)) return 'baru saja';
  if (diff < const Duration(hours: 1)) return '${diff.inMinutes} menit lalu';
  final location = _location(zone);
  final localNow = tz.TZDateTime.from(now.toUtc(), location);
  final localThen = tz.TZDateTime.from(instant.toUtc(), location);
  final today = DateTime(localNow.year, localNow.month, localNow.day);
  final thatDay = DateTime(localThen.year, localThen.month, localThen.day);
  final days = today.difference(thatDay).inDays;
  if (days == 0) return '${diff.inHours} jam lalu';
  if (days == 1) return 'kemarin, ${formatTime(instant, zone: zone)}';
  if (days < 7) return '$days hari lalu';
  return formatDate(instant, zone: zone);
}

/// Hitung mundur `m:ss` untuk cooldown OTP dan RATE_LIMITED (prototipe layar 1: "Kirim ulang dalam 0:42").
String formatCountdown(Duration remaining) {
  final value = remaining.isNegative ? Duration.zero : remaining;
  final totalSeconds = (value.inMilliseconds / 1000).ceil();
  final minutes = totalSeconds ~/ 60;
  final seconds = totalSeconds % 60;
  return '$minutes:${seconds.toString().padLeft(2, '0')}';
}

/// Ukuran berkas untuk tile unggah: `1,2 MB`, `850 KB`.
String formatFileSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).round()} KB';
  final mb = bytes / (1024 * 1024);
  return '${NumberFormat('#,##0.0', 'id').format(mb)} MB';
}

/// Inisial untuk avatar tanpa foto (prototipe layar 6: "AI").
String initialsOf(String fullName) {
  final parts = fullName.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  String firstRune(String part) => String.fromCharCode(part.runes.first);
  final second = parts.length > 1 ? firstRune(parts.last) : '';
  return (firstRune(parts.first) + second).toUpperCase();
}
