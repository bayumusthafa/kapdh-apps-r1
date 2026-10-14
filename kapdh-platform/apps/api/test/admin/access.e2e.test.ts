import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessMismatches, type ContractAccess, spec } from "../support/contract.js";
import { type RouteAccess, routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * ARCHITECTURE §4.3 / kontrak C3+C7: dekorator akses setiap operasi modul admin sama persis dengan `x-kapdh-access`
 * (audience, permissions, permissions_any, role, reauth, idempotent), satu uji per controller, dan setiap operasi domain
 * admin-dashboard, admin-admins, admin-audit dan admin-settings diimplementasikan controller modul ini.
 */
const CONTROLLERS: Record<string, { tag: string; operations: number }> = {
  DashboardController: { tag: "Admin Dashboard", operations: 2 },
  AdminsController: { tag: "Admin Admins", operations: 8 },
  PermissionsController: { tag: "Admin Admins", operations: 1 },
  AuditController: { tag: "Admin Audit", operations: 6 },
  SettingsController: { tag: "Admin Settings", operations: 8 },
};
const TAGS = [...new Set(Object.values(CONTROLLERS).map((c) => c.tag))];

let t: TestApp;
let routes: RouteAccess[];

beforeAll(async () => {
  t = await createTestApp();
  routes = routeAccessList(t.app);
});
afterAll(async () => {
  await t.app.close();
});

const normalize = (p: string) => p.replace(/\{[^}]+\}/g, "{}");

function contractOperations() {
  const operations: {
    method: string;
    path: string;
    operationId: string;
    tag: string;
    access?: ContractAccess;
  }[] = [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, operation] of Object.entries(item as Record<string, Record<string, unknown>>)) {
      const tag = ((operation.tags as string[] | undefined) ?? []).find((name) => TAGS.includes(name));
      if (tag)
        operations.push({
          method,
          path,
          tag,
          operationId: String(operation.operationId),
          access: operation["x-kapdh-access"] as ContractAccess | undefined,
        });
    }
  return operations;
}

describe("Akses modul admin cocok dengan kontrak (ARCHITECTURE §4.3)", () => {
  it.each(Object.entries(CONTROLLERS))(
    "AC F15-1, F16-1, F17-2: dekorator %s sama dengan x-kapdh-access setiap operasinya",
    (controller, { tag, operations }) => {
      const own = routes.filter((route) => route.name.split(".")[0] === controller);
      expect(own).toHaveLength(operations);
      for (const route of own) {
        expect(route.meta.problems, route.name).toEqual([]);
        const operation = contractOperations().find(
          (op) => op.method === route.method && normalize(op.path) === normalize(route.path),
        );
        expect(operation, `${route.name} tidak ada di kontrak`).toBeDefined();
        expect(operation!.tag, route.name).toBe(tag);
        expect(operation!.access, `${operation!.operationId} tanpa x-kapdh-access`).toBeDefined();
      }
      expect(accessMismatches(own)).toEqual([]);
    },
  );

  it("setiap operasi domain admin-dashboard/admins/audit/settings diimplementasikan modul admin", () => {
    const implemented = new Set(
      routes
        .filter((route) => route.name.split(".")[0]! in CONTROLLERS)
        .map((route) => `${route.method} ${normalize(route.path)}`),
    );
    const operations = contractOperations();
    // 2 dasbor + 9 admin/izin + 6 audit + 8 pengaturan.
    expect(operations).toHaveLength(25);
    for (const operation of operations)
      expect(
        implemented.has(`${operation.method} ${normalize(operation.path)}`),
        `${operation.operationId} (${operation.method.toUpperCase()} ${operation.path}) belum diimplementasikan`,
      ).toBe(true);
  });

  it("AC F15-3, F16-1: perubahan admin, izin dan pengaturan wajib reautentikasi; pembacaan dan permintaan ekspor tidak", () => {
    for (const route of routes.filter((r) => r.name.split(".")[0]! in CONTROLLERS)) {
      const mutating = route.method !== "get";
      const exportRequest = route.path === "/admin/audit/exports";
      expect(route.meta.reauth, route.name).toBe(mutating && !exportRequest);
    }
  });
});
