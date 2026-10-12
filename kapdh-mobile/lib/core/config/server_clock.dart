import 'dart:io' show HttpDate, HttpException;

import 'clock.dart';

/// Perkiraan jam server dari header HTTP `Date` (RFC 9110 §6.6.1) pada setiap respons API.
///
/// Server adalah sumber kebenaran waktu (PRD 2.1). Jam perangkat bisa melenceng jauh, misalnya jam lokal benar
/// tetapi zona waktu disetel UTC sehingga waktu UTC perangkat maju sekitar 7 jam. Stempel absolut dari server
/// (`expires_at` OTP, `access_expires_at` token) karena itu tidak boleh dibandingkan langsung dengan jam perangkat.
/// Kelas ini menyimpan selisih jam server terhadap jam perangkat dari respons terakhir, sehingga
/// `now()` memberi perkiraan waktu server saat ini (ketelitian sekitar satu detik ditambah latensi jaringan).
///
/// Sebelum ada respons berheader `Date` ([isSynced] false), selisih dianggap nol; pemakai yang keputusannya
/// bergantung pada ketepatan jam (kedaluwarsa OTP, refresh proaktif) wajib menyerahkan keputusan ke server pada
/// keadaan itu.
class ServerClock {
  ServerClock({Clock clock = systemClock}) : _clock = clock;

  final Clock _clock;
  Duration? _offset;

  /// Sudah menerima minimal satu stempel waktu server.
  bool get isSynced => _offset != null;

  /// Jam server dikurangi jam perangkat (nol sebelum tersinkron).
  Duration get offset => _offset ?? Duration.zero;

  /// Jam perangkat saat ini (UTC). Dipakai untuk mengukur durasi yang sudah berlalu secara lokal.
  DateTime deviceNow() => _clock().toUtc();

  /// Perkiraan waktu server saat ini (UTC).
  DateTime now() => deviceNow().add(offset);

  /// Mengubah stempel waktu server menjadi waktu menurut jam perangkat (untuk dibandingkan dengan [deviceNow]).
  DateTime toDeviceTime(DateTime serverInstant) => serverInstant.toUtc().subtract(offset);

  /// Mencatat waktu server yang diketahui pada saat ini (mis. dari header `Date`).
  void observe(DateTime serverTime) {
    _offset = serverTime.toUtc().difference(deviceNow());
  }

  /// Membaca header `Date` (dan `Age` bila respons berasal dari cache perantara: `Date` adalah waktu respons asli
  /// dibuat, sehingga umur cache ditambahkan; RFC 9111 §5.1). Resolusi `Date` satu detik dan dibulatkan ke bawah oleh
  /// server, sehingga titik tengah detik itu (+500 ms) menjadi perkiraan terbaik. Header kosong atau rusak diabaikan.
  void observeDateHeader(String? value, {String? age}) {
    if (value == null || value.trim().isEmpty) return;
    final DateTime parsed;
    try {
      parsed = HttpDate.parse(value.trim());
    } on HttpException {
      return;
    } on FormatException {
      return;
    } on RangeError {
      return;
    }
    final ageSeconds = int.tryParse(age?.trim() ?? '');
    final cached = ageSeconds != null && ageSeconds > 0 ? Duration(seconds: ageSeconds) : Duration.zero;
    observe(parsed.add(cached).add(const Duration(milliseconds: 500)));
  }
}
