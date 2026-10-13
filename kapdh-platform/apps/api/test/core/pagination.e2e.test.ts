import type { PGlite } from "@electric-sql/pglite";
import { auditLogs } from "@kapdh/database";
import { and, asc, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/core/db/types.js";
import {
  decodeCursor,
  encodeCursor,
  type KeysetKey,
  keysetAfter,
  type Page,
  pageOf,
  parsePageQuery,
} from "../../src/core/pagination/cursor.js";
import { createTestDatabase } from "../support/test-app.js";

let pg: PGlite;
let db: Db;
const ENTITY = "uji_pagination";
const base = new Date("2026-10-13T02:00:00.000Z").getTime();

/** 10 baris; beberapa berbagi created_at yang sama sehingga id menjadi pemutus urutan. */
const seeded: { id: string; createdAt: Date }[] = [];

beforeAll(async () => {
  ({ pg, db } = await createTestDatabase());
  for (let i = 0; i < 10; i++) {
    const row = { id: uuidv7(), createdAt: new Date(base + Math.floor(i / 3) * 1000) };
    seeded.push(row);
    await db.insert(auditLogs).values({
      id: row.id,
      effectiveRole: "system",
      action: "uji.pagination",
      entityType: ENTITY,
      entityId: String(i),
      requestId: "uji",
      createdAt: row.createdAt,
    });
  }
});
afterAll(async () => {
  await pg.close();
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("tidak melempar");
}

const cursorSchema = z.object({ created_at: z.coerce.date(), id: z.uuid() });

async function pageThrough(direction: { createdAt: "asc" | "desc"; id: "asc" | "desc" }, limit: number) {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const after: z.infer<typeof cursorSchema> | null = cursor ? decodeCursor(cursor, cursorSchema) : null;
    const keys: KeysetKey[] | null = after
      ? [
          { column: auditLogs.createdAt, value: after.created_at, direction: direction.createdAt },
          { column: auditLogs.id, value: after.id, direction: direction.id },
        ]
      : null;
    const result: { id: string; createdAt: Date }[] = await db
      .select({ id: auditLogs.id, createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, ENTITY), keys ? keysetAfter(keys) : undefined))
      .orderBy(
        direction.createdAt === "asc" ? asc(auditLogs.createdAt) : desc(auditLogs.createdAt),
        direction.id === "asc" ? asc(auditLogs.id) : desc(auditLogs.id),
      )
      .limit(limit + 1);
    const page: Page<string> = pageOf(result, limit, {
      cursorOf: (r) => ({ created_at: r.createdAt, id: r.id }),
      toItem: (r) => r.id,
    });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    seen.push(...page.items);
    if (!page.next_cursor) return seen;
    cursor = page.next_cursor;
  }
  throw new Error("pagination tidak berhenti");
}

function expected(direction: { createdAt: "asc" | "desc"; id: "asc" | "desc" }) {
  return [...seeded]
    .sort((a, b) => {
      const byTime = a.createdAt.getTime() - b.createdAt.getTime();
      if (byTime !== 0) return direction.createdAt === "asc" ? byTime : -byTime;
      const byId = a.id < b.id ? -1 : 1;
      return direction.id === "asc" ? byId : -byId;
    })
    .map((r) => r.id);
}

describe("pagination keyset (ARCHITECTURE §4.10)", () => {
  it.each([
    { createdAt: "desc", id: "desc" },
    { createdAt: "asc", id: "asc" },
    { createdAt: "asc", id: "desc" },
  ] as const)(
    "urutan %j: setiap baris tepat sekali, urutan stabil walau created_at sama",
    async (direction) => {
      expect(await pageThrough(direction, 3)).toEqual(expected(direction));
      expect(await pageThrough(direction, 100)).toEqual(expected(direction));
    },
  );

  it("pageOf: tanpa baris ekstra next_cursor null; total untuk tabel admin", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(pageOf(rows, 2, { cursorOf: (r) => r })).toEqual({ items: rows, next_cursor: null });
    expect(pageOf(rows, 1, { cursorOf: (r) => r, total: 2 })).toEqual({
      items: [{ id: "a" }],
      next_cursor: encodeCursor({ id: "a" }),
      total: 2,
    });
  });

  it("cursor opaque base64url; cursor rusak/dimanipulasi → 400 VALIDATION_ERROR field cursor", () => {
    const cursor = encodeCursor({ created_at: new Date(base).toISOString(), id: seeded[0]!.id });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, cursorSchema)).toEqual({ created_at: new Date(base), id: seeded[0]!.id });
    const forged = [
      "abc",
      Buffer.from(JSON.stringify({ v: 2, p: {} })).toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, p: { created_at: "x", id: "1' or 1=1" } })).toString("base64url"),
      "a".repeat(600),
      "bukan+base64/==",
    ];
    for (const value of forged) {
      expect(
        thrown(() => decodeCursor(value, cursorSchema)),
        value,
      ).toMatchObject({
        status: 400,
        code: "VALIDATION_ERROR",
        extra: { fieldErrors: { cursor: expect.any(Array) } },
      });
    }
  });

  it("parsePageQuery: limit bawaan 30, rentang 1..100, nilai bukan angka ditolak", () => {
    expect(parsePageQuery({})).toEqual({ cursor: undefined, limit: 30 });
    expect(parsePageQuery({ limit: "100", cursor: "abc" })).toEqual({ cursor: "abc", limit: 100 });
    expect(parsePageQuery({}, { defaultLimit: 20, maxLimit: 50 })).toEqual({ cursor: undefined, limit: 20 });
    for (const limit of ["0", "101", "abc", "1.5"])
      expect(
        thrown(() => parsePageQuery({ limit })),
        limit,
      ).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });
});
