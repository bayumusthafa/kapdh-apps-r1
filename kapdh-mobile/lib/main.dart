import 'bootstrap.dart';

/// Titik masuk aplikasi anggota KAPDH. Lingkungan dipilih dengan
/// `--dart-define-from-file=config/<development|staging|production>.json` (lihat README).
Future<void> main() => bootstrap();
