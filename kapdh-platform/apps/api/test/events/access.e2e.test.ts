import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessMismatches, spec } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminSession, createEventRow, memberSession } from "./support.js";

/**
 * Deklarasi akses modul events (ARCHITECTURE §4.3): setiap operasi kontrak domain `events` dan `admin-events` memiliki
 * rute server dengan dekorator yang persis sama dengan `x-kapdh-access` (audience, member_access, permissions,
 * idempotent), tanpa rute tanpa autentikasi, serta penolakan negatif audience/izin/status (PRD 2.2, AC F15-1).
 */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const EVENT_TAGS = new Set(["Events", "Admin Events"]);
const normalize = (path: string) => path.replace(/\{[^}]+\}/g, "{}");

function contractOperations(): [string, string][] {
  const operations: [string, string][] = [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, operation] of Object.entries(item as Record<string, { tags?: string[] }>))
      if (operation?.tags?.some((tag) => EVENT_TAGS.has(tag))) operations.push([method, path]);
  return operations;
}

describe("ARCHITECTURE §4.3: dekorator controller events = x-kapdh-access kontrak", () => {
  it("setiap operasi events.yaml dan admin-events.yaml diimplementasikan dengan dekorator yang sama persis", () => {
    const operations = contractOperations();
    expect(operations).toHaveLength(22);
    const routes = routeAccessList(t.app).filter((route) =>
      operations.some(([method, path]) => method === route.method && normalize(path) === normalize(route.path)),
    );
    for (const [method, path] of operations)
      expect(
        routes.some((route) => route.method === method && normalize(route.path) === normalize(path)),
        `${method.toUpperCase()} ${path} belum diimplementasikan`,
      ).toBe(true);
    expect(routes).toHaveLength(22);
    for (const route of routes) expect(route.meta.problems, route.name).toEqual([]);
    expect(accessMismatches(routes)).toEqual([]);
    for (const [method, path] of operations) {
      const access = (spec.paths[path] as Record<string, Record<string, unknown>>)[method]!["x-kapdh-access"] as {
        idempotent?: boolean;
      };
      expect(access, `${method} ${path} tanpa x-kapdh-access`).toBeDefined();
      const route = routes.find((r) => r.method === method && normalize(r.path) === normalize(path))!;
      expect(route.idempotent, `${method} ${path} idempotent`).toBe(access.idempotent === true);
    }
  });

  it("tanpa token setiap operasi event ditolak 401 UNAUTHENTICATED", async () => {
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

describe("Otorisasi negatif (PRD 2.2, 2.3; AC F15-1)", () => {
  it("PRD 2.2: unverified/expired ditolak daftar event dan reservasi (MEMBERSHIP_REQUIRED); suspended ACCOUNT_SUSPENDED", async () => {
    const event = await createEventRow(t);
    for (const status of ["unverified", "expired"] as const) {
      const member = await memberSession(t, status);
      for (const res of [
        await api().get("/events", { token: member.token }),
        await api().get("/event-categories", { token: member.token }),
        await api().get(`/events/${event.id}/participants`, { token: member.token }),
        await api().post(
          `/events/${event.id}/reservations`,
          { expected_price: "75000.00" },
          { token: member.token },
        ),
      ])
        expect(res.json().code, `${status} ${res.body}`).toBe("MEMBERSHIP_REQUIRED");
    }
    const suspended = await memberSession(t, "suspended");
    for (const res of [
      await api().get("/events", { token: suspended.token }),
      await api().get(`/events/${event.id}`, { token: suspended.token }),
      await api().get("/me/tickets", { token: suspended.token }),
    ])
      expect(res.json().code).toBe("ACCOUNT_SUSPENDED");
  });

  it("PRD 2.3: sesi anggota ditolak di API pengurus; pengurus tanpa izin events.manage/events.checkin 403", async () => {
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const forMember = await api().get("/admin/events", { token: member.token });
    expect(forMember.statusCode).toBe(403);
    const payments = await adminSession(t, ["payments.read", "payments.decide"]);
    for (const res of [
      await api().get("/admin/events", { token: payments.token }),
      await api().get(`/admin/events/${event.id}`, { token: payments.token }),
      await api().get("/admin/event-categories", { token: payments.token }),
      await api().get("/admin/checkin/events", { token: payments.token }),
      await api().post("/admin/checkin", { event_id: event.id, qr_code: "x" }, { token: payments.token }),
    ])
      expect(res.json().code, res.body).toBe("FORBIDDEN");
    // events.checkin saja tidak membuka pengelolaan event; events.manage saja tidak membuka check-in.
    const scanner = await adminSession(t, ["events.checkin"]);
    expect((await api().get("/admin/events", { token: scanner.token })).statusCode).toBe(403);
    const manager = await adminSession(t, ["events.manage"]);
    expect((await api().get("/admin/checkin/events", { token: manager.token })).statusCode).toBe(403);
    // Sesi admin ditolak di API anggota.
    expect((await api().get("/events", { token: manager.token })).statusCode).toBe(403);
  });
});
