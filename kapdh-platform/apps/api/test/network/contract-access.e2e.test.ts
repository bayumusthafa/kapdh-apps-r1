import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessMismatches, spec } from "../support/contract.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Dekorator akses server = `x-kapdh-access` kontrak untuk setiap operasi domain network.yaml dan admin-masters.yaml
 * (ARCHITECTURE §4.3, §6): audience, member_access, permissions, permissions_any, role, reauth, idempotent.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const CONTROLLERS = ["DirectoryController", "AdminMastersController"] as const;
const normalize = (path: string) => path.replace(/\{[^}]+\}/g, "{}");

/** Operasi kontrak milik slice network: path /directory* (network.yaml) dan /admin/masters* (admin-masters.yaml). */
function contractOperations(): { method: string; path: string; operationId: string; access: unknown }[] {
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths))
    if (path.startsWith("/directory") || path.startsWith("/admin/masters"))
      for (const [method, operation] of Object.entries(item as Record<string, Record<string, unknown>>))
        operations.push({
          method,
          path,
          operationId: String(operation.operationId),
          access: operation["x-kapdh-access"],
        });
  return operations;
}

describe("Kontrak akses jejaring dan master", () => {
  it("setiap operasi network.yaml dan admin-masters.yaml diimplementasikan tepat satu rute", () => {
    const operations = contractOperations();
    expect(operations.map((op) => op.operationId).sort()).toEqual(
      [
        "searchDirectory",
        "getMemberProfile",
        "adminListMasters",
        "adminCreateMaster",
        "adminGetMaster",
        "adminUpdateMaster",
        "adminDeleteMaster",
      ].sort(),
    );
    const routes = routeAccessList(t.app);
    for (const op of operations) {
      const matching = routes.filter(
        (route) => route.method === op.method && normalize(route.path) === normalize(op.path),
      );
      expect(
        matching.map((route) => route.name.split(".")[0]),
        op.operationId,
      ).toHaveLength(1);
      expect(CONTROLLERS).toContain(matching[0]!.name.split(".")[0]);
      expect(op.access, `${op.operationId} tanpa x-kapdh-access`).toBeDefined();
    }
  });

  it("dekorator DirectoryController dan AdminMastersController sama dengan x-kapdh-access kontrak", () => {
    const routes = routeAccessList(t.app).filter((route) =>
      CONTROLLERS.some((controller) => route.name.startsWith(`${controller}.`)),
    );
    expect(routes).toHaveLength(7);
    for (const route of routes) expect(route.meta.problems, route.name).toEqual([]);
    expect(accessMismatches(routes)).toEqual([]);
  });

  it("AC F10-5: DirectoryController hanya-baca (semua rute GET, tidak ada rute ubah profil orang lain)", () => {
    const routes = routeAccessList(t.app).filter((route) => route.name.startsWith("DirectoryController."));
    expect(routes.map((route) => route.method)).toEqual(["get", "get"]);
    // Tidak ada modul lain yang mendaftarkan rute di bawah /directory.
    const others = routeAccessList(t.app).filter(
      (route) => route.path.startsWith("/directory") && !route.name.startsWith("DirectoryController."),
    );
    expect(others).toEqual([]);
  });
});
