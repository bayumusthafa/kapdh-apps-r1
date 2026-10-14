import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessMismatches, spec } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminSession, createEventRow, eventRow, insertTicket, memberSession, ticketRow } from "./support.js";

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
  it("ARCHITECTURE §4.3, AC F15-1: setiap operasi events.yaml dan admin-events.yaml diimplementasikan dengan dekorator yang sama persis", () => {
    const operations = contractOperations();
    expect(operations).toHaveLength(22);
    const routes = routeAccessList(t.app).filter((route) =>
      operations.some(
        ([method, path]) => method === route.method && normalize(path) === normalize(route.path),
      ),
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
      const access = (spec.paths[path] as Record<string, Record<string, unknown>>)[method]![
        "x-kapdh-access"
      ] as {
        idempotent?: boolean;
      };
      expect(access, `${method} ${path} tanpa x-kapdh-access`).toBeDefined();
      const route = routes.find((r) => r.method === method && normalize(r.path) === normalize(path))!;
      expect(route.idempotent, `${method} ${path} idempotent`).toBe(access.idempotent === true);
    }
  });

  /** Jumlah operasi kontrak per controller modul events (events.yaml 8 operasi, admin-events.yaml 14 operasi). */
  const CONTROLLER_OPERATIONS: [string, number][] = [
    ["EventsController", 5],
    ["MyTicketsController", 3],
    ["AdminEventCategoriesController", 1],
    ["AdminEventsController", 10],
    ["AdminEventCoversController", 1],
    ["AdminCheckinController", 2],
  ];

  it.each(CONTROLLER_OPERATIONS)(
    "ARCHITECTURE §4.3: %s — setiap rute adalah operasi kontrak dengan dekorator = x-kapdh-access (%i operasi)",
    (controller, expected) => {
      const operations = contractOperations();
      const routes = routeAccessList(t.app).filter((route) => route.name.startsWith(`${controller}.`));
      expect(routes, controller).toHaveLength(expected);
      for (const route of routes) {
        expect(
          operations.some(
            ([method, path]) => method === route.method && normalize(path) === normalize(route.path),
          ),
          `${route.name} (${route.method.toUpperCase()} ${route.path}) tidak ada di kontrak`,
        ).toBe(true);
        expect(route.meta.problems, route.name).toEqual([]);
      }
      expect(accessMismatches(routes)).toEqual([]);
    },
  );

  it("AC F15-1, PRD 2.3: tanpa token setiap operasi event ditolak 401 UNAUTHENTICATED", async () => {
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

  it("AC F15-1, PRD 2.3: sesi anggota ditolak di API pengurus; pengurus tanpa izin events.manage/events.checkin 403", async () => {
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

  /** Request mentah ke operasi kontrak dengan path terisi, Idempotency-Key, If-Match dan body kosong. */
  function callOperation(method: string, path: string, token: string, ids: Record<string, string>) {
    const url = `/api/v1${path.replace(/\{([^}]+)\}/g, (_, name: string) => ids[name] ?? uuidv7())}`;
    return t.app.inject({
      method: method.toUpperCase() as "GET",
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": uuidv7(), "if-match": "1" },
      ...(method === "get" || method === "delete" ? {} : { payload: {} }),
    });
  }

  function operationAccess(method: string, path: string) {
    return (spec.paths[path] as Record<string, Record<string, unknown>>)[method]!["x-kapdh-access"] as {
      audience: string;
      permissions?: string[];
    };
  }

  it("AC F15-1: setiap operasi pengurus event (baca dan ubah) ditolak 403 untuk pengurus tanpa izin yang disyaratkan kontrak dan untuk sesi anggota; tidak ada perubahan", async () => {
    const event = await createEventRow(t);
    const holder = await memberSession(t);
    const ticket = await insertTicket(t, { eventId: event.id, userId: holder.userId, status: "paid" });
    const sessions: { name: string; token: string; permissions: string[] }[] = [
      { name: "anggota", token: (await memberSession(t)).token, permissions: [] },
      {
        name: "pengurus payments",
        token: (await adminSession(t, ["payments.read", "payments.decide"])).token,
        permissions: ["payments.read", "payments.decide"],
      },
      {
        name: "pengurus events.checkin",
        token: (await adminSession(t, ["events.checkin"])).token,
        permissions: ["events.checkin"],
      },
      {
        name: "pengurus events.manage",
        token: (await adminSession(t, ["events.manage"])).token,
        permissions: ["events.manage"],
      },
    ];
    const denied: string[] = [];
    for (const [method, path] of contractOperations()) {
      const access = operationAccess(method, path);
      if (access.audience !== "admin") continue;
      const required = access.permissions ?? [];
      for (const session of sessions) {
        const allowed =
          session.permissions.length > 0 && required.every((p) => session.permissions.includes(p));
        if (allowed) continue;
        const res = await callOperation(method, path, session.token, {
          eventId: event.id,
          ticketId: ticket.id,
        });
        const label = `${session.name}: ${method.toUpperCase()} ${path}`;
        expect(res.statusCode, `${label} ${res.body}`).toBe(403);
        expect(res.json().code, label).toBe("FORBIDDEN");
        denied.push(label);
      }
    }
    // 14 operasi pengurus: anggota 14, pengurus payments 14, events.checkin 12 (operasi events.manage),
    // events.manage 2 (operasi check-in).
    expect(denied).toHaveLength(42);
    expect(await eventRow(t, event.id)).toMatchObject({ status: "open", version: 1, paidQuantity: 1 });
    expect(await ticketRow(t, ticket.id)).toMatchObject({ status: "paid", checkedInAt: null });
  });

  it("PRD 2.2: anggota suspended ditolak ACCOUNT_SUSPENDED di setiap operasi anggota event, termasuk tiket miliknya sendiri (getMyTicket, cancelMyTicket); sesi pengurus ditolak 403", async () => {
    const event = await createEventRow(t, { price: "0.00" });
    const suspended = await memberSession(t, "suspended");
    const ticket = await insertTicket(t, { eventId: event.id, userId: suspended.userId, status: "paid" });
    const manager = await adminSession(t, ["events.manage", "events.checkin"]);
    const ids = { eventId: event.id, ticketId: ticket.id };
    let checked = 0;
    for (const [method, path] of contractOperations()) {
      if (operationAccess(method, path).audience === "admin") continue;
      const label = `${method.toUpperCase()} ${path}`;
      const res = await callOperation(method, path, suspended.token, ids);
      expect(res.statusCode, `${label} ${res.body}`).toBe(403);
      expect(res.json().code, label).toBe("ACCOUNT_SUSPENDED");
      const admin = await callOperation(method, path, manager.token, ids);
      expect(admin.statusCode, `pengurus ${label}`).toBe(403);
      checked += 1;
    }
    expect(checked).toBe(8);
    expect(await ticketRow(t, ticket.id)).toMatchObject({ status: "paid", cancelledAt: null });
    expect(await eventRow(t, event.id)).toMatchObject({ paidQuantity: 1, heldQuantity: 0 });
  });
});
