/**
 * Aturan nomor anggota KTA AA.SS.JK.N (PRD 3.5, disahkan v3.4).
 * Fungsi murni: tanpa I/O, dipakai oleh layanan keanggotaan di dalam transaksi.
 */

export type Gender = "male" | "female";
export type EducationStatus = "01" | "02" | "03";

/** Kelas 1-3 = 1-3 MTs, kelas 4-6 = 1-3 Aliyah. */
export const MIN_CLASS = 1;
export const MAX_CLASS = 6;
export const COHORT_BASE_YEAR = 1996;

export class InvalidAcademicDataError extends Error {}

export function assertClasses(classIn: number, classOut: number): void {
  const valid = (c: number) => Number.isInteger(c) && c >= MIN_CLASS && c <= MAX_CLASS;
  if (!valid(classIn) || !valid(classOut)) throw new InvalidAcademicDataError("Kelas harus 1 sampai 6");
  if (classOut < classIn)
    throw new InvalidAcademicDataError("Kelas keluar tidak boleh lebih rendah dari kelas masuk");
}

/**
 * 01 = tamat MTs dan Aliyah, 02 = tamat salah satu, 03 = tidak tamat.
 * Tamat MTs: masuk di MTs (kelas 1-3) dan keluar paling cepat kelas 3. Tamat Aliyah: keluar di kelas 6.
 */
export function educationStatus(classIn: number, classOut: number): EducationStatus {
  assertClasses(classIn, classOut);
  const finishedMts = classIn <= 3 && classOut >= 3;
  const finishedAliyah = classOut === 6;
  if (finishedMts && finishedAliyah) return "01";
  if (finishedMts || finishedAliyah) return "02";
  return "03";
}

export function genderCode(gender: Gender): "01" | "02" {
  return gender === "male" ? "01" : "02";
}

export function assertCohort(cohort: number): void {
  if (!Number.isInteger(cohort) || cohort < 1 || cohort > 99)
    throw new InvalidAcademicDataError("Angkatan harus 1 sampai 99");
}

/** Prefix AA.SS.JK yang dihitung ulang saat data dikoreksi admin; N tidak pernah berubah. */
export function memberNumberPrefix(input: {
  cohort: number;
  classIn: number;
  classOut: number;
  gender: Gender;
}): string {
  assertCohort(input.cohort);
  const aa = String(input.cohort).padStart(2, "0");
  return `${aa}.${educationStatus(input.classIn, input.classOut)}.${genderCode(input.gender)}`;
}

/** Nomor lengkap; N tanpa nol di depan dan tanpa batas digit. */
export function memberNumber(input: {
  cohort: number;
  classIn: number;
  classOut: number;
  gender: Gender;
  seq: number;
}): string {
  if (!Number.isSafeInteger(input.seq) || input.seq < 1)
    throw new InvalidAcademicDataError("Nomor urut harus bilangan bulat positif");
  return `${memberNumberPrefix(input)}.${input.seq}`;
}

export const MEMBER_NUMBER_PATTERN = /^\d{2}\.0[1-3]\.0[12]\.[1-9]\d*$/;

/** Tahun lulus = 1996 + angkatan; tahun masuk dan keluar dihitung mundur sesuai kelas. */
export function academicYears(cohort: number, classIn: number, classOut: number) {
  assertCohort(cohort);
  assertClasses(classIn, classOut);
  const graduationYear = COHORT_BASE_YEAR + cohort;
  return {
    graduationYear,
    exitYear: graduationYear - (MAX_CLASS - classOut),
    entryYear: graduationYear - (MAX_CLASS - classIn) - 1,
  };
}

export function cohortCode(cohort: number): string {
  assertCohort(cohort);
  return `KAPDH ${cohort}`;
}
