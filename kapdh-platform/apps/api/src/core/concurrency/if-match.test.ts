import { describe, expect, it } from "vitest";
import { AppException } from "../errors/app-exception.js";
import { assertVersion, parseIfMatch, throwVersionConflict } from "./if-match.js";

function caught(fn: () => unknown): AppException {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("tidak melempar");
}

describe("If-Match (ARCHITECTURE §4.10, AC F15-4)", () => {
  it.each([
    ["3", 3],
    ["0", 0],
    ['"3"', 3],
    ['W/"12"', 12],
    [" 7 ", 7],
    [["5", "9"], 5],
  ])("mengurai %j menjadi versi %i", (header, version) => {
    expect(parseIfMatch(header as string | string[])).toBe(version);
  });

  it.each([undefined, "", "abc", "-1", "1.5", "*", '"3', '3"', "W/3", "9999999999"])(
    "menolak %j dengan 400 VALIDATION_ERROR pada field If-Match",
    (header) => {
      const error = caught(() => parseIfMatch(header));
      expect(error.status).toBe(400);
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(Object.keys(error.extra.fieldErrors ?? {})).toEqual(["If-Match"]);
    },
  );

  it("assertVersion: versi sama lolos, berbeda 409 VERSION_CONFLICT dengan current, tidak ada 404", () => {
    expect(() => assertVersion({ id: "a", version: 2 }, 2)).not.toThrow();
    const conflict = caught(() =>
      assertVersion({ id: "a", version: 3 }, 2, (row) => ({ id: row.id, version: String(row.version) })),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("VERSION_CONFLICT");
    expect(conflict.extra.current).toEqual({ id: "a", version: "3" });
    expect(caught(() => assertVersion(undefined, 1)).code).toBe("NOT_FOUND");
  });

  it("throwVersionConflict membaca ulang keadaan terbaru setelah UPDATE bersyarat gagal", async () => {
    await expect(throwVersionConflict(async () => ({ version: 4 }))).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      extra: { current: { version: 4 } },
    });
    await expect(throwVersionConflict(async () => null)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
