import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessMismatches, spec } from "../support/contract.js";
import { routeAccessList } from "../support/routes.js";
import type { TestApp } from "../support/test-app.js";
import { createPaymentsApp } from "./support.js";

/**
 * Deklarasi akses modul payments (ARCHITECTURE §4.3): setiap operasi kontrak domain `payments` dan `admin-payments`
 * memiliki rute server dengan dekorator yang persis sama dengan `x-kapdh-access` (audience, member_access, permissions,
 * reauth, idempotent), dan tidak ada rute tanpa autentikasi.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createPaymentsApp();
});
afterAll(async () => {
  await t.app.close();
});

const PAYMENT_TAGS = new Set(["Payments", "Admin Payments"]);
const normalize = (path: string) => path.replace(/\{[^}]+\}/g, "{}");

/** Operasi kontrak bertag Payments/Admin Payments: [metode, path template]. */
function contractOperations(): [string, string][] {
  const operations: [string, string][] = [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, operation] of Object.entries(item as Record<string, { tags?: string[] }>))
      if (operation?.tags?.some((tag) => PAYMENT_TAGS.has(tag))) operations.push([method, path]);
  return operations;
}

describe("ARCHITECTURE §4.3: dekorator controller payments = x-kapdh-access kontrak", () => {
  it("setiap operasi payments.yaml dan admin-payments.yaml diimplementasikan dengan dekorator yang sama persis", () => {
    const operations = contractOperations();
    expect(operations).toHaveLength(27);
    const routes = routeAccessList(t.app);
    const paymentRoutes = routes.filter((route) =>
      operations.some(
        ([method, path]) => method === route.method && normalize(path) === normalize(route.path),
      ),
    );
    for (const [method, path] of operations)
      expect(
        paymentRoutes.some((route) => route.method === method && normalize(route.path) === normalize(path)),
        `${method.toUpperCase()} ${path} belum diimplementasikan`,
      ).toBe(true);
    expect(paymentRoutes).toHaveLength(27);
    for (const route of paymentRoutes) expect(route.meta.problems, route.name).toEqual([]);
    expect(accessMismatches(paymentRoutes)).toEqual([]);
    for (const [method, path] of operations) {
      const access = (spec.paths[path] as Record<string, Record<string, unknown>>)[method]!["x-kapdh-access"];
      expect(access, `${method} ${path} tanpa x-kapdh-access`).toBeDefined();
    }
  });

  it("tanpa token setiap operasi pembayaran ditolak 401 UNAUTHENTICATED", async () => {
    for (const [method, path] of contractOperations()) {
      const url = `/api/v1${path.replace(/\{[^}]+\}/g, uuidv7())}`;
      const res = await t.app.inject({
        method: method.toUpperCase() as "GET",
        url,
        ...(method === "get" || method === "delete" ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });
});
