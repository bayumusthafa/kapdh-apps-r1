import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminNotificationsController } from "../../src/modules/notifications/admin-notifications.controller.js";
import { DevicesController } from "../../src/modules/notifications/devices.controller.js";
import { NotificationsController } from "../../src/modules/notifications/notifications.controller.js";
import { accessMismatches, spec } from "../support/contract.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Dekorator akses controller notifications (ARCHITECTURE §4.3) persis sama dengan `x-kapdh-access` kontrak domain
 * notifications.yaml dan admin-notifications.yaml, dan setiap operasi kedua domain memiliki rute server.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const CONTROLLERS = new Set([
  NotificationsController.name,
  DevicesController.name,
  AdminNotificationsController.name,
]);

const OPERATIONS: Record<string, [method: string, path: string]> = {
  listNotifications: ["get", "/notifications"],
  getNotificationUnreadCount: ["get", "/notifications/unread-count"],
  getNotification: ["get", "/notifications/{notificationId}"],
  markNotificationsRead: ["post", "/notifications/read"],
  getNotificationPreferences: ["get", "/notifications/preferences"],
  updateNotificationPreferences: ["put", "/notifications/preferences"],
  registerDevice: ["put", "/devices"],
  unregisterDevice: ["post", "/devices/unregister"],
  adminListNotificationDeliveries: ["get", "/admin/notifications/deliveries"],
  adminRetryNotificationDeliveries: ["post", "/admin/notifications/deliveries/retry"],
  adminListOutboxEvents: ["get", "/admin/notifications/outbox"],
  adminRetryOutboxEvents: ["post", "/admin/notifications/outbox/retry"],
};

describe("Kontrak akses modul notifications (ARCHITECTURE §4.3, §6)", () => {
  it("setiap operasi tag Notifications/Admin Notifications ada di kontrak dan memiliki rute server", () => {
    const contractOps = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { operationId?: string; tags?: string[] }>)
        .filter(([, op]) => op.tags?.some((tag) => tag === "Notifications" || tag === "Admin Notifications"))
        .map(([method, op]) => [op.operationId!, method, path] as const),
    );
    expect(Object.fromEntries(contractOps.map(([id, method, path]) => [id, [method, path]]))).toEqual(OPERATIONS);
    const routes = routeAccessList(t.app).filter((route) => CONTROLLERS.has(route.name.split(".")[0]!));
    const served = new Set(routes.map((route) => `${route.method} ${route.path}`));
    for (const [method, path] of Object.values(OPERATIONS)) expect(served, `${method} ${path}`).toContain(`${method} ${path}`);
    expect(routes).toHaveLength(Object.keys(OPERATIONS).length);
  });

  it("dekorator @Audience/@MemberAccess/@RequirePermission/@Idempotent sama dengan x-kapdh-access setiap operasi", () => {
    const routes = routeAccessList(t.app).filter((route) => CONTROLLERS.has(route.name.split(".")[0]!));
    expect(accessMismatches(routes)).toEqual([]);
    for (const route of routes) expect(route.meta.problems, route.name).toEqual([]);
    const byPath = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
    for (const path of ["get /notifications", "put /devices", "post /notifications/read"])
      expect(byPath.get(path)!.meta).toMatchObject({ audience: "mobile", memberAccess: "any" });
    for (const path of ["post /admin/notifications/deliveries/retry", "post /admin/notifications/outbox/retry"]) {
      expect(byPath.get(path)!.meta).toMatchObject({ audience: "admin", permissions: ["notifications.manage"] });
      expect(byPath.get(path)!.idempotent).toBe(true);
    }
  });
});
