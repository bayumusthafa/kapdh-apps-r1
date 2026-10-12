/// Pratinjau data akademik di form daftar (PRD 3.5, v3.4). Server tetap sumber kebenaran nomor dan tahun.
const cohortBaseYear = 1996;

/// Label kelas 1-6: 1-3 MTs, 4-6 = 1-3 Aliyah.
String classLabel(int kelas) => kelas <= 3 ? 'Kelas $kelas ($kelas MTs)' : 'Kelas $kelas (${kelas - 3} Aliyah)';

bool classesValid(int classIn, int classOut) =>
    classIn >= 1 && classIn <= 6 && classOut >= 1 && classOut <= 6 && classOut >= classIn;

/// 01 tamat MTs dan Aliyah, 02 tamat salah satu, 03 tidak tamat.
String educationStatus(int classIn, int classOut) {
  final finishedMts = classIn <= 3 && classOut >= 3;
  final finishedAliyah = classOut == 6;
  if (finishedMts && finishedAliyah) return '01';
  if (finishedMts || finishedAliyah) return '02';
  return '03';
}

class AcademicYears {
  const AcademicYears(this.entryYear, this.exitYear, this.graduationYear);
  final int entryYear;
  final int exitYear;
  final int graduationYear;
}

AcademicYears academicYears(int cohort, int classIn, int classOut) {
  final graduation = cohortBaseYear + cohort;
  return AcademicYears(graduation - (6 - classIn) - 1, graduation - (6 - classOut), graduation);
}

/// Angkatan terbaru = tahun berjalan - 1996 (angkatan 30 lulus 2026).
int latestCohort(DateTime now) => now.year - cohortBaseYear;
