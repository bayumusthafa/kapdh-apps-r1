import 'dart:convert';

/// Kebijakan sandi PRD 2.5: 8 sampai 72 byte UTF-8 (bukan karakter), huruf besar, kecil, angka, dan simbol.
const passwordMinBytes = 8;
const passwordMaxBytes = 72;

class PasswordCheck {
  const PasswordCheck({
    required this.bytes,
    required this.lengthOk,
    required this.hasUpper,
    required this.hasLower,
    required this.hasDigit,
    required this.hasSymbol,
  });

  final int bytes;
  final bool lengthOk;
  final bool hasUpper;
  final bool hasLower;
  final bool hasDigit;
  final bool hasSymbol;

  bool get valid => lengthOk && hasUpper && hasLower && hasDigit && hasSymbol;
}

final _upper = RegExp(r'\p{Lu}', unicode: true);
final _lower = RegExp(r'\p{Ll}', unicode: true);
final _digit = RegExp(r'\p{Nd}', unicode: true);
final _symbol = RegExp(r'[^\p{L}\p{Nd}\s]', unicode: true);

PasswordCheck checkPassword(String value) {
  final bytes = utf8.encode(value).length;
  return PasswordCheck(
    bytes: bytes,
    lengthOk: bytes >= passwordMinBytes && bytes <= passwordMaxBytes,
    hasUpper: _upper.hasMatch(value),
    hasLower: _lower.hasMatch(value),
    hasDigit: _digit.hasMatch(value),
    hasSymbol: _symbol.hasMatch(value),
  );
}
