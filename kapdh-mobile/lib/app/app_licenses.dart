import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Lisensi font pihak ketiga yang tidak terhimpun otomatis ke `NOTICES` paket pub (THIRD_PARTY_NOTICES.md): font
/// ikon Phosphor (ADR-027) dan Poppins dibundel langsung sebagai font aset. Nama paket
/// tampil sebagai judul di halaman Akun > Lisensi sumber terbuka; berkasnya terdaftar sebagai aset di pubspec.
const appLicenseAssets = <({String package, String asset})>[
  (package: 'Phosphor Icons', asset: 'assets/fonts/phosphor/LICENSE'),
  (package: 'Poppins', asset: 'assets/licenses/Poppins-OFL.txt'),
];

bool _registered = false;

/// Mendaftarkan [appLicenseAssets] ke [LicenseRegistry], sekali saja walau dipanggil ulang. Tidak menunda start:
/// teks baru dibaca dari [rootBundle] saat halaman lisensi menghimpun entri, tanpa disimpan di cache bundel.
void registerAppLicenses() {
  if (_registered) return;
  _registered = true;
  LicenseRegistry.addLicense(_appLicenses);
}

Stream<LicenseEntry> _appLicenses() async* {
  for (final license in appLicenseAssets) {
    yield LicenseEntryWithLineBreaks([license.package], await rootBundle.loadString(license.asset, cache: false));
  }
}
