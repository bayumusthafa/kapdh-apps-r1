import { describe, expect, it } from "vitest";
import {
  firstRow,
  isCheckViolation,
  isFkViolation,
  isInsufficientPrivilege,
  isRetryableTransactionError,
  isUniqueViolation,
  pgErrorInfo,
  rows,
} from "./index.js";

/** Bentuk galat driver postgres-js (PostgresError). */
function postgresJsError(code: string, constraint?: string) {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    name: "PostgresError",
    severity: "ERROR",
    severity_local: "ERROR",
    code,
    constraint_name: constraint,
    table_name: "users",
  });
}

/** Bentuk galat PGlite (DatabaseError). */
function pgliteError(code: string, constraint?: string) {
  return Object.assign(new Error("violates"), {
    name: "error",
    severity: "ERROR",
    code,
    constraint,
    table: "users",
  });
}

/** Drizzle 0.45 membungkus galat driver; pesannya memuat SQL + parameter (tidak boleh dicocokkan/dicatat). */
function drizzleWrap(cause: unknown) {
  return Object.assign(
    new Error("Failed query: insert into users ...\nparams: rahasia@contoh.test,$2b$hash"),
    {
      query: "insert into users ...",
      params: ["rahasia@contoh.test"],
      cause,
    },
  );
}

describe("inspeksi galat PostgreSQL lintas driver (ARCHITECTURE §4.2)", () => {
  it.each([
    ["postgres-js", postgresJsError],
    ["PGlite", pgliteError],
  ])("%s: unique violation dikenali lewat cause DrizzleQueryError beserta nama constraint", (_name, make) => {
    const error = drizzleWrap(make("23505", "users_kind_email_key"));
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, "users_kind_email_key")).toBe(true);
    expect(isUniqueViolation(error, "lain_key")).toBe(false);
    expect(pgErrorInfo(error)).toEqual({
      code: "23505",
      constraint: "users_kind_email_key",
      table: "users",
      column: null,
    });
  });

  it("FK violation menerima 23503 (PostgreSQL 17) dan 23001 (PGlite/PG 18 RESTRICT)", () => {
    expect(isFkViolation(drizzleWrap(postgresJsError("23503", "payments_user_id_fkey")))).toBe(true);
    expect(isFkViolation(drizzleWrap(pgliteError("23001", "events_category_id_fkey")))).toBe(true);
    expect(isFkViolation(drizzleWrap(pgliteError("23505")))).toBe(false);
  });

  it("check, privilege append-only, dan galat yang aman diulang", () => {
    expect(
      isCheckViolation(pgliteError("23514", "admins_last_super_admin_chk"), "admins_last_super_admin_chk"),
    ).toBe(true);
    expect(isInsufficientPrivilege(drizzleWrap(postgresJsError("42501")))).toBe(true);
    expect(isRetryableTransactionError(postgresJsError("40P01"))).toBe(true);
    expect(isRetryableTransactionError(postgresJsError("40001"))).toBe(true);
    expect(isRetryableTransactionError(postgresJsError("23505"))).toBe(false);
  });

  it("galat non-PostgreSQL (kode Node tanpa severity, nilai sembarang) tidak dianggap galat database", () => {
    const node = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(pgErrorInfo(node)).toBeNull();
    expect(pgErrorInfo(Object.assign(new Error("x"), { code: "23505" }))).toBeNull();
    expect(pgErrorInfo(null)).toBeNull();
    expect(pgErrorInfo("23505")).toBeNull();
    expect(isUniqueViolation(new Error("users_kind_email_key"))).toBe(false);
  });

  it("rantai cause yang melingkar tidak membuat loop tanpa akhir", () => {
    const a: { cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(pgErrorInfo(a)).toBeNull();
  });
});

describe("rows() menormalkan hasil kueri mentah (ARCHITECTURE §4.10)", () => {
  it("postgres-js (array) dan PGlite ({rows})", () => {
    expect(rows<{ n: number }>([{ n: 1 }])).toEqual([{ n: 1 }]);
    expect(rows<{ n: number }>({ rows: [{ n: 2 }], fields: [] })).toEqual([{ n: 2 }]);
    expect(firstRow<{ n: number }>({ rows: [] })).toBeUndefined();
    expect(() => rows({ bukan: "hasil" })).toThrow();
  });
});
