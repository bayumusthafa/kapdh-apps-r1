// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

// Pembantu dekode/enkode JSON untuk model terbangkit. Internal paket kapdh_api (tidak diekspor barrel).
// Semua galat bentuk dilaporkan sebagai FormatException beserta jalur field agar mudah dilacak.

import 'optional.dart';

/// Membaca field wajib [key] dengan [decode]; galat bentuk menyertakan nama field.
T readField<T>(Map<String, Object?> json, String key, T Function(Object? value) decode) {
  try {
    return decode(json[key]);
  } on FormatException catch (error) {
    throw FormatException('$key: ${error.message}');
  }
}

/// Membaca field opsional atau nullable; `null` bila tidak ada atau bernilai null.
T? readOptionalField<T>(Map<String, Object?> json, String key, T Function(Object? value) decode) {
  final value = json[key];
  if (value == null) return null;
  try {
    return decode(value);
  } on FormatException catch (error) {
    throw FormatException('$key: ${error.message}');
  }
}

/// Membaca field yang opsional sekaligus nullable dengan tiga keadaan (tidak ada, null, nilai).
Optional<T?> readPresentField<T>(Map<String, Object?> json, String key, T Function(Object? value) decode) {
  if (!json.containsKey(key)) return const Optional.absent();
  return Optional<T?>(readOptionalField(json, key, decode));
}

String decodeString(Object? value) {
  if (value is String) return value;
  throw FormatException('diharapkan string, diterima ${_describe(value)}');
}

int decodeInt(Object? value) {
  if (value is int) return value;
  if (value is double && value.isFinite && value == value.truncateToDouble()) return value.toInt();
  throw FormatException('diharapkan bilangan bulat, diterima ${_describe(value)}');
}

double decodeDouble(Object? value) {
  if (value is num) return value.toDouble();
  throw FormatException('diharapkan angka, diterima ${_describe(value)}');
}

bool decodeBool(Object? value) {
  if (value is bool) return value;
  throw FormatException('diharapkan boolean, diterima ${_describe(value)}');
}

/// Waktu RFC 3339 dari server (UTC). Ditampilkan klien dalam Asia/Jakarta (ARCHITECTURE §2 butir 6).
DateTime decodeDateTime(Object? value) {
  final text = decodeString(value);
  final parsed = DateTime.tryParse(text);
  if (parsed == null) throw FormatException('tanggal-waktu RFC 3339 tidak valid: $text');
  return parsed;
}

/// Nilai JSON bebas (skema tanpa tipe), dikembalikan apa adanya.
Object? decodeAny(Object? value) => value;

/// Isi respons biner (mis. berkas ekspor).
List<int> decodeBytes(Object? value) {
  if (value is List<int>) return value;
  throw FormatException('diharapkan data biner, diterima ${_describe(value)}');
}

Map<String, Object?> decodeObject(Object? value) {
  if (value is Map<String, Object?>) return value;
  throw FormatException('diharapkan objek JSON, diterima ${_describe(value)}');
}

/// Array JSON menjadi list tak dapat diubah (model imutabel).
List<T> decodeList<T>(Object? value, T Function(Object? item) decodeItem) {
  if (value is! List<Object?>) {
    throw FormatException('diharapkan array JSON, diterima ${_describe(value)}');
  }
  return List<T>.unmodifiable(<T>[
    for (var i = 0; i < value.length; i++) _at('[$i]', () => decodeItem(value[i])),
  ]);
}

/// Objek JSON berkunci bebas menjadi map tak dapat diubah.
Map<String, T> decodeMap<T>(Object? value, T Function(Object? item) decodeValue) {
  final object = decodeObject(value);
  return Map<String, T>.unmodifiable(<String, T>{
    for (final entry in object.entries) entry.key: _at(entry.key, () => decodeValue(entry.value)),
  });
}

T? decodeNullable<T>(Object? value, T Function(Object? value) decode) => value == null ? null : decode(value);

/// Waktu dikirim selalu dalam UTC RFC 3339 (ARCHITECTURE §2 butir 6).
String encodeDateTime(DateTime value) => value.toUtc().toIso8601String();

R? encodeNullable<T extends Object, R>(T? value, R Function(T value) encode) =>
    value == null ? null : encode(value);

/// Kesamaan struktural untuk list, map dan nilai JSON bebas.
bool deepEquals(Object? a, Object? b) {
  if (identical(a, b)) return true;
  if (a is List<Object?> && b is List<Object?>) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is Map<Object?, Object?> && b is Map<Object?, Object?>) {
    if (a.length != b.length) return false;
    for (final key in a.keys) {
      if (!b.containsKey(key) || !deepEquals(a[key], b[key])) return false;
    }
    return true;
  }
  return a == b;
}

/// Hash yang konsisten dengan [deepEquals].
int deepHash(Object? value) {
  if (value is List<Object?>) return Object.hashAll(value.map(deepHash));
  if (value is Map<Object?, Object?>) {
    // Urutan kunci map tidak memengaruhi kesamaan, sehingga hash entri dijumlahkan.
    var hash = 0;
    for (final entry in value.entries) {
      hash = (hash + Object.hash(deepHash(entry.key), deepHash(entry.value))) & 0x3fffffff;
    }
    return hash;
  }
  return value.hashCode;
}

T _at<T>(String path, T Function() run) {
  try {
    return run();
  } on FormatException catch (error) {
    throw FormatException('$path: ${error.message}');
  }
}

String _describe(Object? value) => value == null ? 'null' : value.runtimeType.toString();
