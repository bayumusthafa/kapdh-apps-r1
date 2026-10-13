import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

/// Panjang minimum kata kunci nama setelah dipangkas (network.yaml `q` minLength 2).
const int directoryMinQueryLength = 2;

/// Panjang maksimum kata kunci nama (network.yaml `q` maxLength 100).
const int directoryMaxQueryLength = 100;

/// Pencarian dan filter direktori (F-10, AC F10-1): nama, angkatan, kelas, kota, profesi dan keahlian (master
/// terkontrol), digabung AND oleh server. Imutabel; setiap perubahan memulai paging dari halaman pertama agar tidak
/// ada duplikasi antarhalaman.
@immutable
class DirectoryFilter {
  const DirectoryFilter({
    this.query,
    this.cohort,
    this.classLevel,
    this.city,
    this.profession,
    this.skill,
    this.sort = DirectorySort.nameAsc,
  });

  static const DirectoryFilter empty = DirectoryFilter();

  /// Kata kunci nama (sudah dipangkas, minimal 2 karakter) atau null.
  final String? query;

  /// Angkatan 1-99 (AA nomor anggota, PRD 3.5).
  final int? cohort;

  /// Kelas 1-6 (1-3 MTs, 4-6 Aliyah).
  final int? classLevel;
  final String? city;

  /// Master profesi terpilih (ID dikirim, label untuk chip filter).
  final MasterItem? profession;
  final MasterItem? skill;
  final DirectorySort sort;

  /// Kata kunci mentah dari kotak pencarian: dipangkas; kurang dari 2 karakter berarti tanpa kata kunci.
  static String? normalizeQuery(String raw) {
    final trimmed = raw.trim();
    if (trimmed.length < directoryMinQueryLength) return null;
    return trimmed.length > directoryMaxQueryLength ? trimmed.substring(0, directoryMaxQueryLength) : trimmed;
  }

  /// Jumlah filter lembar (tanpa kata kunci dan urutan) untuk lencana tombol filter.
  int get activeFilterCount => [cohort, classLevel, city, profession, skill].where((v) => v != null).length;

  bool get hasFilters => activeFilterCount > 0 || sort != DirectorySort.nameAsc;

  bool get isEmpty => query == null && !hasFilters;

  DirectoryFilter withQuery(String? query) => DirectoryFilter(
    query: query,
    cohort: cohort,
    classLevel: classLevel,
    city: city,
    profession: profession,
    skill: skill,
    sort: sort,
  );

  /// Filter lembar baru dengan kata kunci yang sama.
  DirectoryFilter withSheet(DirectoryFilter sheet) => DirectoryFilter(
    query: query,
    cohort: sheet.cohort,
    classLevel: sheet.classLevel,
    city: sheet.city,
    profession: sheet.profession,
    skill: sheet.skill,
    sort: sheet.sort,
  );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DirectoryFilter &&
          other.query == query &&
          other.cohort == cohort &&
          other.classLevel == classLevel &&
          other.city == city &&
          other.profession?.id == profession?.id &&
          other.skill?.id == skill?.id &&
          other.sort == sort;

  @override
  int get hashCode => Object.hash(query, cohort, classLevel, city, profession?.id, skill?.id, sort);
}
