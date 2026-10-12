import 'package:flutter/painting.dart';

/// Warna tambahan dari prototipe yang belum ada di `packages/design-tokens/tokens.json` (PRD 4.6). Diusulkan
/// masuk ke tokens.json oleh pemilik design-tokens; sampai itu dipakai hanya lewat konstanta ini.
abstract final class KapdhExtraColors {
  /// Teks redup di atas latar gelap (label kartu KTA, kotak nominal): prototipe layar 2, 3, 6, 7.
  static const mutedOnDark = Color(0xFFC9D6C8);

  /// Garis kartu alasan penolakan: prototipe layar 5.
  static const rejectionBorder = Color(0xFFF3C3BF);

  /// Kotak QR tertutup pada KTA tidak aktif: putih 8 % dengan garis putih 25 % (prototipe layar 6).
  static const qrPlaceholderFill = Color(0x14FFFFFF);
  static const qrPlaceholderBorder = Color(0x40FFFFFF);

  /// Pita hijau header bergradasi vertikal (prototipe layar 1 sampai 5).
  static const bandGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFF215E1E), Color(0xFF1A4B17)],
  );
}

/// Ukuran komponen dari prototipe yang tidak ada di token.
abstract final class KapdhComponentSize {
  /// Tombol aksi utama bergradasi (prototipe layar 1 sampai 5).
  static const double primaryButtonHeight = 52;

  /// Kotak digit OTP (prototipe layar 1).
  static const double otpBoxHeight = 56;

  /// Lingkaran ikon StatusHero (prototipe layar 4, 5).
  static const double heroIcon = 72;

  /// Lingkaran langkah stepper (prototipe layar 1, 2) dan versi ringkas (layar 3).
  static const double stepperDot = 36;
  static const double stepperDotCompact = 32;

  /// Kotak QR pada KTA (prototipe layar 6, 7).
  static const double ktaQr = 128;
}
