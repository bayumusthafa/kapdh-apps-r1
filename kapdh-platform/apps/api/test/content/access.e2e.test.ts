import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { accessMismatches, expectOperation, type HttpMethod } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminSession, memberSession } from "./support.js";

/**
 * Dekorator akses modul konten = `x-kapdh-access` kontrak (ARCHITECTURE §4.3) untuk setiap operasi content.yaml dan
 * admin-content.yaml, serta uji otorisasi negatif (AC F15-1: admin tanpa izin konten ditolak API walaupun menu
 * disembunyikan; PRD 2.2: anggota tidak aktif tidak membuka informasi anggota).
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const CONTROLLERS = [
  "ContentController",
  "PublicPagesController",
  "AdminPostsController",
  "AdminBannersController",
  "AdminPagesController",
  "AdminPostCategoriesController",
  "AdminManagedEventCategoriesController",
  "AdminContentMediaController",
] as const;

interface DomainOperation {
  method: string;
  path: string;
  access: Record<string, unknown> | undefined;
}

function domainOperations(file: string): DomainOperation[] {
  const require = createRequire(import.meta.url);
  const bundle = require.resolve("@kapdh/contracts/openapi.yaml");
  const source = join(dirname(bundle), "..", "openapi", "domains", file);
  const doc = parse(readFileSync(source, "utf8")) as { paths: Record<string, Record<string, unknown>> };
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => ["get", "put", "post", "patch", "delete"].includes(method))
      .map(([method, operation]) => ({
        method,
        path,
        access: (operation as Record<string, unknown>)["x-kapdh-access"] as
          Record<string, unknown> | undefined,
      })),
  );
}

const normalize = (path: string) => path.replace(/\{[^}]+\}/g, "{}");

describe("ARCHITECTURE §4.3: dekorator controller konten sama dengan x-kapdh-access kontrak", () => {
  it.each(CONTROLLERS)("AC F15-1: %s memakai dekorator sesuai kontrak untuk setiap operasinya", (name) => {
    const routes = routeAccessList(t.app).filter((route) => route.name.startsWith(`${name}.`));
    expect(routes.length, `${name} memiliki rute`).toBeGreaterThan(0);
    expect(accessMismatches(routes)).toEqual([]);
    for (const route of routes) expect(route.meta.problems, route.name).toEqual([]);
  });

  it("AC F15-1: setiap operasi content.yaml dan admin-content.yaml diimplementasikan controller konten (dan sebaliknya)", () => {
    const operations = [...domainOperations("content.yaml"), ...domainOperations("admin-content.yaml")];
    expect(operations.length).toBe(39);
    for (const operation of operations)
      expect(operation.access, `${operation.method} ${operation.path} x-kapdh-access`).toBeDefined();
    const routes = routeAccessList(t.app).filter((route) =>
      CONTROLLERS.some((name) => route.name.startsWith(`${name}.`)),
    );
    const implemented = new Set(routes.map((r) => `${r.method} ${normalize(r.path)}`));
    const declared = new Set(operations.map((o) => `${o.method} ${normalize(o.path)}`));
    expect([...declared].filter((key) => !implemented.has(key))).toEqual([]);
    expect([...implemented].filter((key) => !declared.has(key))).toEqual([]);
  });
});

const SOME_ID = "0192f1e2-3c4d-7a5b-8c9d-0e1f2a3b4c5d";

/** Semua operasi pengurus konten (izin content.manage) beserta template kontraknya. */
const CONTENT_ADMIN_OPS: [HttpMethod, string, string][] = [
  ["get", "/admin/content/posts", "/admin/content/posts"],
  ["post", "/admin/content/posts", "/admin/content/posts"],
  ["get", `/admin/content/posts/${SOME_ID}`, "/admin/content/posts/{postId}"],
  ["patch", `/admin/content/posts/${SOME_ID}`, "/admin/content/posts/{postId}"],
  ["delete", `/admin/content/posts/${SOME_ID}`, "/admin/content/posts/{postId}"],
  ["post", `/admin/content/posts/${SOME_ID}/publish`, "/admin/content/posts/{postId}/publish"],
  ["post", `/admin/content/posts/${SOME_ID}/unschedule`, "/admin/content/posts/{postId}/unschedule"],
  ["post", `/admin/content/posts/${SOME_ID}/archive`, "/admin/content/posts/{postId}/archive"],
  ["post", `/admin/content/posts/${SOME_ID}/restore`, "/admin/content/posts/{postId}/restore"],
  ["get", "/admin/content/banners", "/admin/content/banners"],
  ["post", "/admin/content/banners", "/admin/content/banners"],
  ["get", `/admin/content/banners/${SOME_ID}`, "/admin/content/banners/{bannerId}"],
  ["patch", `/admin/content/banners/${SOME_ID}`, "/admin/content/banners/{bannerId}"],
  ["delete", `/admin/content/banners/${SOME_ID}`, "/admin/content/banners/{bannerId}"],
  ["get", "/admin/content/pages", "/admin/content/pages"],
  ["post", "/admin/content/pages", "/admin/content/pages"],
  ["get", `/admin/content/pages/${SOME_ID}`, "/admin/content/pages/{pageId}"],
  ["patch", `/admin/content/pages/${SOME_ID}`, "/admin/content/pages/{pageId}"],
  ["delete", `/admin/content/pages/${SOME_ID}`, "/admin/content/pages/{pageId}"],
  ["post", `/admin/content/pages/${SOME_ID}/publish`, "/admin/content/pages/{pageId}/publish"],
  ["get", "/admin/content/post-categories", "/admin/content/post-categories"],
  ["post", "/admin/content/post-categories", "/admin/content/post-categories"],
  ["get", `/admin/content/post-categories/${SOME_ID}`, "/admin/content/post-categories/{categoryId}"],
  ["patch", `/admin/content/post-categories/${SOME_ID}`, "/admin/content/post-categories/{categoryId}"],
  ["delete", `/admin/content/post-categories/${SOME_ID}`, "/admin/content/post-categories/{categoryId}"],
  ["post", "/admin/content/media", "/admin/content/media"],
];

/** Operasi kategori event (izin events.manage). */
const EVENT_CATEGORY_OPS: [HttpMethod, string, string][] = [
  ["get", "/admin/content/event-categories", "/admin/content/event-categories"],
  ["post", "/admin/content/event-categories", "/admin/content/event-categories"],
  ["get", `/admin/content/event-categories/${SOME_ID}`, "/admin/content/event-categories/{categoryId}"],
  ["patch", `/admin/content/event-categories/${SOME_ID}`, "/admin/content/event-categories/{categoryId}"],
  ["delete", `/admin/content/event-categories/${SOME_ID}`, "/admin/content/event-categories/{categoryId}"],
];

const MEMBER_OPS: [HttpMethod, string, string][] = [
  ["get", "/home", "/home"],
  ["get", "/posts", "/posts"],
  ["get", "/posts/berita-apa-saja", "/posts/{slug}"],
  ["put", "/posts/berita-apa-saja/like", "/posts/{slug}/like"],
  ["delete", "/posts/berita-apa-saja/like", "/posts/{slug}/like"],
];

async function call(token: string | undefined, method: HttpMethod, url: string) {
  const api = httpClient(t.app);
  const options = token ? { token, headers: { "if-match": "1" } } : { headers: { "if-match": "1" } };
  switch (method) {
    case "get":
      return api.get(url, options);
    case "delete":
      return api.delete(url, options);
    case "post":
      return api.post(url, {}, options);
    case "put":
      return api.put(url, {}, options);
    case "patch":
      return api.patch(url, { title: "x" }, options);
  }
}

describe("AC F15-1: endpoint konten menolak pengurus tanpa izin konten", () => {
  it("AC F15-1: admin pembayaran (payments.read, payments.decide) ditolak 403 di semua operasi konten dan kategori event", async () => {
    const finance = await adminSession(t, ["payments.read", "payments.decide"]);
    for (const [method, url, template] of [...CONTENT_ADMIN_OPS, ...EVENT_CATEGORY_OPS]) {
      const res = await call(finance.token, method, url);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().code).toBe("FORBIDDEN");
      expectOperation(method, template, res);
    }
  });

  it("AC F15-1: content.manage tidak membuka kategori event; events.manage tidak membuka konten", async () => {
    const content = await adminSession(t, ["content.manage"]);
    for (const [method, url, template] of EVENT_CATEGORY_OPS) {
      const res = await call(content.token, method, url);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expectOperation(method, template, res);
    }
    const eventsAdmin = await adminSession(t, ["events.manage"]);
    for (const [method, url, template] of CONTENT_ADMIN_OPS) {
      const res = await call(eventsAdmin.token, method, url);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expectOperation(method, template, res);
    }
    const ok = await httpClient(t.app).get("/admin/content/event-categories", { token: eventsAdmin.token });
    expect(ok.statusCode).toBe(200);
    expectOperation("get", "/admin/content/event-categories", ok);
  });

  it("AC F15-1: sesi anggota ditolak di endpoint pengurus; tanpa sesi 401", async () => {
    const member = await memberSession(t, "verified");
    for (const [method, url] of CONTENT_ADMIN_OPS.slice(0, 3)) {
      const res = await call(member.token, method, url);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const anonymous = await call(undefined, "get", "/admin/content/posts");
    expect(anonymous.statusCode).toBe(401);
    expectOperation("get", "/admin/content/posts", anonymous);
  });

  it("AC F15-1: Super Admin memiliki semua izin konten", async () => {
    const superAdmin = await adminSession(t, [], { role: "super_admin" });
    const res = await httpClient(t.app).get("/admin/content/posts", { token: superAdmin.token });
    expect(res.statusCode).toBe(200);
    expectOperation("get", "/admin/content/posts", res);
  });
});

describe("PRD 2.2: beranda, berita dan like hanya untuk anggota aktif", () => {
  it.each([
    ["unverified", "MEMBERSHIP_REQUIRED"],
    ["expired", "MEMBERSHIP_REQUIRED"],
    ["suspended", "ACCOUNT_SUSPENDED"],
  ] as const)("PRD 2.2: anggota %s ditolak 403 %s", async (status, code) => {
    const member = await memberSession(t, status);
    for (const [method, url, template] of MEMBER_OPS) {
      const res = await call(member.token, method, url);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().code).toBe(code);
      expectOperation(method, template, res);
    }
  });

  it("PRD 2.2: sesi admin ditolak di endpoint anggota; tanpa sesi 401", async () => {
    const admin = await adminSession(t, ["content.manage"]);
    for (const [method, url] of MEMBER_OPS) {
      const res = await call(admin.token, method, url);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const anonymous = await call(undefined, "get", "/home");
    expect(anonymous.statusCode).toBe(401);
    expectOperation("get", "/home", anonymous);
  });

  it("PRD 2.2: anggota expiring tetap aktif membuka beranda", async () => {
    const member = await memberSession(t, "expiring");
    const res = await httpClient(t.app).get("/home", { token: member.token });
    expect(res.statusCode).toBe(200);
    expectOperation("get", "/home", res);
  });

  it("F-08: GET /categories terbuka untuk sesi apa pun (anggota, pengurus) tetapi tidak tanpa sesi", async () => {
    const unverified = await memberSession(t, "unverified");
    const admin = await adminSession(t, ["payments.read"]);
    for (const token of [unverified.token, admin.token]) {
      const res = await httpClient(t.app).get("/categories", { token });
      expect(res.statusCode).toBe(200);
      expectOperation("get", "/categories", res);
    }
    expect((await httpClient(t.app).get("/categories")).statusCode).toBe(401);
  });

  it("PRD 3.8: halaman publik dibaca tanpa login", async () => {
    const res = await httpClient(t.app).get("/public/pages");
    expect(res.statusCode).toBe(200);
    expectOperation("get", "/public/pages", res);
  });
});
