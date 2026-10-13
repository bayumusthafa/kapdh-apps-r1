import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessMismatches, type ContractAccess, spec } from "../support/contract.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * ARCHITECTURE §4.3 / kontrak C3+C7: dekorator akses setiap operasi modul admin sama persis dengan `x-kapdh-access`
 * (audience, permissions, permissions_any, role, reauth, idempotent), dan setiap operasi domain admin-dashboard,
 * admin-admins, admin-audit dan admin-settings diimplementasikan controller modul ini.
 */
const CONTROLLERS = [
  "DashboardController",
  "AdminsController",
  "PermissionsController",
  "AuditController",
  "SettingsController",
];
const TAGS = ["Admin Dashboard", "Admin Admins", "Admin Audit", "Admin Settings"];

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

function adminRoutes() {
  return routeAccessList(t.app).filter((route) => CONTROLLERS.includes(route.name.split(".")[0]!));
}

function contractOperations() {
  const operations: { method: string; path: string; operationId: string; access: ContractAccess | undefined }[] =
    [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, operation] of Object.entries(item as Record<string, Record<string, unknown>>)) {
      const tags = (operation.tags as string[] | undefined) ?? [];
      if (tags.some((tag) => TAGS.includes(tag)))
        operations.push({
          method,
          path,
          operationId: String(operation.operationId),
          access: operation["x-kapdh-access"] as ContractAccess | undefined,
        });
    }
  return operations;
}

describe("Akses modul admin cocok dengan kontrak (ARCHITECTURE §4.3)", () => {
  it("AC F15-1, F16-1, F17-2: dekorator setiap rute modul admin sama dengan x-kapdh-access", () => {
    const routes = adminRoutes();
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) expect(route.meta.problems, route.name).toEqual([]);
    expect(accessMismatches(routes)).toEqual([]);
  });

  it("setiap operasi domain admin-dashboard/admins/audit/settings diimplementasikan dengan x-kapdh-access", () => {
    const normalize = (p: string) => p.replace(/\{[^}]+\}/g, "{}");
    const routes = new Set(adminRoutes().map((route) => `${route.method} ${normalize(route.path)}`));
    const operations = contractOperations();
    // 2 dasbor + 9 admin/izin + 6 audit + 8 pengaturan.
    expect(operations.length).toBe(25);
    for (const operation of operations) {
      expect(operation.access, `${operation.operationId} tanpa x-kapdh-access`).toBeDefined();
      expect(
        routes.has(`${operation.method} ${normalize(operation.path)}`),
        `${operation.operationId} (${operation.method.toUpperCase()} ${operation.path}) belum diimplementasikan`,
      ).toBe(true);
    }
  });

  it("perubahan admin, izin dan pengaturan wajib reautentikasi; pembacaan tidak (AC F15-3, F16-1)", () => {
    const routes = adminRoutes();
    for (const route of routes) {
      const mutating = route.method !== "get";
      const exportRequest = route.path === "/admin/audit/exports";
      if (mutating && !exportRequest) expect(route.meta.reauth, route.name).toBe(true);
      if (!mutating) expect(route.meta.reauth, route.name).toBe(false);
    }
  });
});
