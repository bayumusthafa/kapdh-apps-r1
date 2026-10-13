/**
 * Deklarasi akses setiap controller modul auth cocok dengan `x-kapdh-access` kontrak auth.yaml (ARCHITECTURE §4.3,
 * §6): audience public → @Public, selain itu @Audience; member_access → @MemberAccess; idempotent → @Idempotent.
 * Setiap operasi domain auth diimplementasikan tepat satu handler modul ini.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessMismatches, spec } from "../support/contract.js";
import { type RouteAccess, routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

let t: TestApp;
let routes: RouteAccess[];

beforeAll(async () => {
  t = await createTestApp();
  routes = routeAccessList(t.app);
});
afterAll(async () => {
  await t.app.close();
});

/** Operasi kontrak bertag Auth (domain auth.yaml): `METHOD /path`. */
function authOperations(): string[] {
  const operations: string[] = [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, operation] of Object.entries(item as Record<string, { tags?: string[] }>))
      if (operation?.tags?.includes("Auth")) operations.push(`${method} ${path}`);
  return operations.sort();
}

const routesOf = (controller: string) => routes.filter((route) => route.name.startsWith(`${controller}.`));

describe("F-01/F-02: dekorator akses modul auth = x-kapdh-access kontrak", () => {
  for (const controller of ["AuthController", "PasswordController", "SessionsController"]) {
    it(`${controller}: setiap handler cocok dengan x-kapdh-access operasinya`, () => {
      const declared = routesOf(controller);
      expect(declared.length).toBeGreaterThan(0);
      expect(accessMismatches(declared)).toEqual([]);
      // Setiap handler punya operasi kontrak dengan x-kapdh-access (bukan rute di luar kontrak).
      for (const route of declared) {
        const operation = (spec.paths[route.path] as Record<string, Record<string, unknown>> | undefined)?.[
          route.method
        ];
        expect(operation?.["x-kapdh-access"], `${route.method} ${route.path}`).toBeDefined();
      }
    });
  }

  it("setiap operasi bertag Auth diimplementasikan tepat satu handler modul auth", () => {
    const implemented = ["AuthController", "PasswordController", "SessionsController"]
      .flatMap(routesOf)
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(implemented).toEqual(authOperations());
    expect(new Set(implemented).size).toBe(implemented.length);
  });

  it("negatif: pembanding mendeteksi dekorator yang menyimpang dari kontrak", () => {
    const [route] = routesOf("PasswordController").filter((r) => r.path === "/auth/password/change");
    expect(route).toBeDefined();
    const tampered = { ...route!, meta: { ...route!.meta, audience: "any" }, idempotent: true };
    expect(accessMismatches([tampered])).toHaveLength(2);
  });
});
