// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:meta/meta.dart';

import 'json.dart';

/// Nilai tiga keadaan untuk field body request yang opsional DAN nullable (mis. PATCH profil):
/// [Optional.absent] berarti field tidak dikirim (tidak diubah), `Optional(null)` berarti dikirim `null`
/// (dikosongkan), dan `Optional(nilai)` berarti dikirim nilai tersebut.
@immutable
final class Optional<T> {
  /// Field dikirim dengan [value] (boleh `null` bila [T] nullable).
  const Optional(T value)
      : _value = value,
        isPresent = true;

  /// Field tidak dikirim.
  const Optional.absent()
      : _value = null,
        isPresent = false;

  final T? _value;

  /// Apakah field dikirim.
  final bool isPresent;

  /// Nilai field; melempar [StateError] bila [isPresent] false.
  T get value {
    if (!isPresent) throw StateError('Optional.absent tidak memiliki nilai.');
    return _value as T;
  }

  /// Nilai field atau `null` bila tidak dikirim.
  T? get valueOrNull => _value;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Optional<T> && other.isPresent == isPresent && deepEquals(other._value, _value);

  @override
  int get hashCode => Object.hash(isPresent, deepHash(_value));

  @override
  String toString() => isPresent ? 'Optional($_value)' : 'Optional.absent()';
}
