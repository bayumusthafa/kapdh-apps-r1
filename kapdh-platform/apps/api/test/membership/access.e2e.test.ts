import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessMismatches, type ContractAccess, spec } from "../support/contract.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Dekorator akses setiap controller modul membership cocok dengan `x-kapdh-access` kontrak untuk SETIAP operasi yang
 * diimplementasikan (ARCHITECTURE §4.3): audience public → @Public, member_access → @MemberAccess, permissions →
 * @RequirePermission, permissions_any → @RequireAnyPermission, role → @RequireRole, reauth → @RequireReauth,
 * idempotent → @Idempotent.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

/** Operasi kontrak yang menjadi tanggung jawab modul membership, dikelompokkan per controller. */
const OPERATIONS: Record<string, [method: string, path: string, operationId: string][]> = {
  MeController: [
    ["get", "/me", "getMe"],
    ["patch", "/me/profile", "updateMyProfile"],
    ["get", "/me/card", "getMyCard"],
    ["get", "/me/membership", "getMyMembership"],
  ],
  MastersController: [["get", "/masters/{kind}", "listMasters"]],
  KtaVerifyController: [["post", "/public/kta/verify", "verifyKta"]],
  AdminMembersController: [
    ["get", "/admin/members", "adminListMembers"],
    ["get", "/admin/members/{userId}", "adminGetMember"],
    ["patch", "/admin/members/{userId}", "adminUpdateMember"],
    ["post", "/admin/members/{userId}/suspend", "adminSuspendMember"],
    ["post", "/admin/members/{userId}/unsuspend", "adminUnsuspendMember"],
    ["post", "/admin/members/{userId}/password-reset", "adminInitiateMemberPasswordReset"],
    ["get", "/admin/members/{userId}/membership-events", "adminListMemberMembershipEvents"],
  ],
};

const normalize = (path: string) => path.replace(/\{[^}]+\}/g, "{}");

describe("ARCHITECTURE §4.3: dekorator controller membership = x-kapdh-access kontrak", () => {
  for (const [controller, operations] of Object.entries(OPERATIONS)) {
    it(`${controller}: setiap operasi kontrak terimplementasi dengan dekorator akses yang sama`, () => {
      const routes = routeAccessList(t.app).filter((route) => route.name.startsWith(`${controller}.`));
      expect(routes.length).toBe(operations.length);
      for (const [method, path, operationId] of operations) {
        const operation = (spec.paths[path] as Record<string, Record<string, unknown>> | undefined)?.[method];
        expect(operation?.operationId, `${method} ${path}`).toBe(operationId);
        const access = operation!["x-kapdh-access"] as ContractAccess | undefined;
        expect(access, `${operationId} wajib memiliki x-kapdh-access`).toBeDefined();
        const route = routes.find((r) => r.method === method && normalize(r.path) === normalize(path));
        expect(route, `${operationId} tidak memiliki rute server`).toBeDefined();
        // Pemetaan eksplisit selain pembanding umum, agar perbedaan langsung terbaca per field.
        expect(route!.meta.isPublic, operationId).toBe(access!.audience === "public");
        if (access!.audience !== "public") expect(route!.meta.audience, operationId).toBe(access!.audience);
        expect(route!.meta.memberAccess, operationId).toBe(access!.member_access ?? null);
        expect([...route!.meta.permissions].sort(), operationId).toEqual(
          [...(access!.permissions ?? [])].sort(),
        );
        expect([...route!.meta.permissionsAny].sort(), operationId).toEqual(
          [...(access!.permissions_any ?? [])].sort(),
        );
        expect(route!.meta.role, operationId).toBe(access!.role ?? null);
        expect(route!.meta.reauth, operationId).toBe(Boolean(access!.reauth));
        expect(route!.idempotent, operationId).toBe(Boolean(access!.idempotent));
        expect(route!.meta.problems, operationId).toEqual([]);
      }
      expect(accessMismatches(routes)).toEqual([]);
    });
  }
});
