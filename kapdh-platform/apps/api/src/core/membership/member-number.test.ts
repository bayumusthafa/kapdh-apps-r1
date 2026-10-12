import { describe, expect, it } from "vitest";
import {
  academicYears,
  cohortCode,
  educationStatus,
  InvalidAcademicDataError,
  MEMBER_NUMBER_PATTERN,
  memberNumber,
  memberNumberPrefix,
} from "./member-number.js";

describe("educationStatus (tabel SS PRD 3.5)", () => {
  it.each([
    [1, 6, "01"],
    [2, 6, "01"],
    [3, 6, "01"],
    [1, 3, "02"],
    [2, 3, "02"],
    [3, 3, "02"],
    [1, 4, "02"],
    [3, 5, "02"],
    [4, 6, "02"],
    [5, 6, "02"],
    [6, 6, "02"],
    [4, 4, "03"],
    [4, 5, "03"],
    [5, 5, "03"],
    [1, 1, "03"],
    [1, 2, "03"],
    [2, 2, "03"],
  ])("masuk %i keluar %i menghasilkan %s", (classIn, classOut, expected) => {
    expect(educationStatus(classIn, classOut)).toBe(expected);
  });

  it("menolak kelas keluar lebih rendah dari kelas masuk", () => {
    expect(() => educationStatus(5, 3)).toThrow(InvalidAcademicDataError);
  });
  it("menolak kelas di luar 1 sampai 6", () => {
    expect(() => educationStatus(0, 6)).toThrow(InvalidAcademicDataError);
    expect(() => educationStatus(1, 7)).toThrow(InvalidAcademicDataError);
  });
});

describe("memberNumber", () => {
  it("contoh PRD: angkatan 12, tamat MTs dan Aliyah, laki-laki, urut 7", () => {
    expect(memberNumber({ cohort: 12, classIn: 1, classOut: 6, gender: "male", seq: 7 })).toBe("12.01.01.7");
  });
  it("nomor urut tanpa nol di depan dan tanpa batas digit", () => {
    expect(memberNumber({ cohort: 3, classIn: 4, classOut: 6, gender: "female", seq: 1234 })).toBe(
      "03.02.02.1234",
    );
  });
  it("koreksi admin menghitung ulang prefix tetapi N tetap (AC F05-6)", () => {
    const before = memberNumber({ cohort: 12, classIn: 1, classOut: 3, gender: "male", seq: 7 });
    const after = memberNumber({ cohort: 12, classIn: 1, classOut: 6, gender: "male", seq: 7 });
    expect(before).toBe("12.02.01.7");
    expect(after).toBe("12.01.01.7");
  });
  it("hasil cocok dengan pola nomor", () => {
    expect(MEMBER_NUMBER_PATTERN.test("29.01.01.7")).toBe(true);
    expect(MEMBER_NUMBER_PATTERN.test("29.01.01.007")).toBe(false);
    expect(MEMBER_NUMBER_PATTERN.test("01.03.02.12")).toBe(true);
    // Angkatan 00 tidak ada (angkatan dimulai dari 1).
    expect(MEMBER_NUMBER_PATTERN.test("00.01.01.7")).toBe(false);
  });
  it("menolak nomor urut tidak valid", () => {
    expect(() => memberNumber({ cohort: 1, classIn: 1, classOut: 6, gender: "male", seq: 0 })).toThrow();
  });
  it("prefix tanpa N", () => {
    expect(memberNumberPrefix({ cohort: 30, classIn: 2, classOut: 2, gender: "female" })).toBe("30.03.02");
  });
});

describe("academicYears", () => {
  it("contoh guidelines: angkatan 30, kelas 1 sampai 6", () => {
    expect(academicYears(30, 1, 6)).toEqual({ graduationYear: 2026, exitYear: 2026, entryYear: 2020 });
  });
  it("angkatan pertama lulus 1997", () => {
    expect(academicYears(1, 1, 6).graduationYear).toBe(1997);
  });
  it("keluar di kelas 3 MTs", () => {
    expect(academicYears(30, 1, 3)).toEqual({ graduationYear: 2026, exitYear: 2023, entryYear: 2020 });
  });
  it("masuk di kelas 4 (1 Aliyah)", () => {
    expect(academicYears(30, 4, 6).entryYear).toBe(2023);
  });
});

describe("cohortCode", () => {
  it("KAPDH diikuti nomor angkatan", () => {
    expect(cohortCode(25)).toBe("KAPDH 25");
  });
});
