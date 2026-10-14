import { RequestMethod } from "@nestjs/common";
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from "@nestjs/common/constants.js";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum.js";
import { MetadataScanner, ModulesContainer, Reflector } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Permission } from "@kapdh/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIENCE_KEY,
  MEMBER_ACCESS_KEY,
  PERMISSIONS_ANY_KEY,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
  REAUTH_KEY,
  ROLE_KEY,
  type RouteAuthMeta,
  routeAuthMeta,
} from "../../src/core/guards/decorators.js";
import { IDEMPOTENT_KEY } from "../../src/core/idempotency/idempotent.js";
import { type ContractAccess, registeredRoutes, spec } from "../support/contract.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Audit D1 (Phase D, lensa "kelengkapan kontrak dan paritas akses"; ARCHITECTURE §4.3, §6, PRD 5.2/N-13).
 *
 * Arah KONTRAK → SERVER (melengkapi test/core/contract.e2e.test.ts yang hanya memeriksa arah server → kontrak):
 *   1. setiap operasi dist/openapi.yaml mempunyai rute Fastify yang terdaftar (metode + pola path) dan handler Nest;
 *   2. metadata dekorator handler (kunci di src/core/guards: Public/Audience/MemberAccess/RequirePermission/
 *      RequireAnyPermission/RequireRole/RequireReauth, ditambah Idempotent) SAMA PERSIS dengan `x-kapdh-access`;
 *   3. header yang wajib dikirim klien (Idempotency-Key, X-Reauth-Token, If-Match) dan `security: []` dideklarasikan
 *      kontrak sesuai perilaku server, karena SDK Dart/TS dibangkitkan dari kontrak;
 *   4. status sukses bawaan handler dideklarasikan kontrak;
 *   5. saat berjalan (app.inject), setiap operasi non-publik menolak permintaan anonim (401) dan sesi audience lain
 *      (403), termasuk rute HEAD otomatis Fastify untuk setiap GET;
 *   6. saat berjalan, `member_access` setiap operasi mobile/any ditegakkan untuk kelima effective_status (PRD 2.2) dan
 *      `permissions`/`permissions_any`/`role` setiap operasi admin: tanpa izin ditolak, tepat izin lolos guard,
 *      kurang satu izin wajib ditolak, admin biasa dengan seluruh izin tetap ditolak operasi Super Admin.
 * Arah SERVER → KONTRAK: setiap handler mempunyai operasi kontrak (pengaman ganda dari contract.e2e).
 *
 * Ekspektasi yang SUDAH diketahui gagal ditandai `it.fails` dengan id temuan audit (KNOWN) agar suite tetap hijau;
 * begitu temuan diperbaiki, `it.fails` itu gagal dan entrinya wajib dihapus. Otorisasi tingkat objek (IDOR) diuji di
 * test/core/idor-probe.e2e.test.ts.
 */

type Check = "route" | "access" | "headers" | "status" | "runtime" | "member" | "permission";

/** Temuan audit D1 yang masih terbuka: `<operationId>` → id temuan, per jenis pemeriksaan. */
const KNOWN: Record<Check, Record<string, string>> = {
  route: {},
  access: {},
  headers: {},
  status: {},
  runtime: {},
  member: {},
  permission: {},
};

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface Operation {
  operationId: string;
  method: HttpMethod;
  /** Template kontrak tanpa prefix, mis. `/me/payments/{paymentId}`. */
  path: string;
  access: ContractAccess | undefined;
  /** Nama parameter `$ref` komponen (IfMatch, IdempotencyKey, ReauthToken, ...) dan header inline. */
  headerParams: Set<string>;
  /** security: [] atau berisi {} (boleh tanpa kredensial, mis. refresh admin lewat cookie atau body). */
  allowsAnonymous: boolean;
  successStatuses: number[];
}

interface Handler {
  name: string;
  method: HttpMethod;
  /** Template path tanpa prefix /api/v1 dengan parameter `{nama}`. */
  path: string;
  /** Deklarasi efektif menurut fungsi yang dipakai AuthGuard (routeAuthMeta). */
  meta: RouteAuthMeta;
  /** Deklarasi efektif dibaca langsung dari kunci metadata src/core/guards (handler mengalahkan kelas). */
  raw: {
    isPublic: boolean;
    audience: string | null;
    memberAccess: string | null;
    permissions: string[];
    permissionsAny: string[];
    role: string | null;
    reauth: boolean;
  };
  idempotent: boolean;
  /** Handler membaca header If-Match (@Headers("if-match")). */
  readsIfMatch: boolean;
  /** Status bawaan Nest: @HttpCode atau 201 untuk POST, 200 selain itu. */
  defaultStatus: number;
}

const normalize = (p: string) => p.replace(/\{[^}]+\}/g, "{}");

function contractOperations(): Operation[] {
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    const pathParams = ((item as Record<string, unknown>).parameters as unknown[] | undefined) ?? [];
    for (const method of HTTP_METHODS) {
      const operation = (item as Record<string, Record<string, unknown> | undefined>)[method];
      if (!operation) continue;
      const headerParams = new Set<string>();
      for (const param of [...pathParams, ...((operation.parameters as unknown[] | undefined) ?? [])]) {
        const p = param as { $ref?: string; in?: string; name?: string };
        if (p.$ref) headerParams.add(p.$ref.split("/").pop()!);
        else if (p.in === "header" && p.name) headerParams.add(p.name.toLowerCase());
      }
      const security = operation.security as unknown[] | undefined;
      operations.push({
        operationId: String(operation.operationId),
        method,
        path,
        access: operation["x-kapdh-access"] as ContractAccess | undefined,
        headerParams,
        allowsAnonymous:
          Array.isArray(security) &&
          (security.length === 0 || security.some((s) => Object.keys(s as object).length === 0)),
        successStatuses: Object.keys((operation.responses as Record<string, unknown>) ?? {})
          .filter((status) => /^2\d\d$/.test(status))
          .map(Number),
      });
    }
  }
  return operations;
}

function joinPath(base: string, sub: string): string {
  const segments = [base, sub].flatMap((part) => part.split("/")).filter((segment) => segment.length > 0);
  return `/${segments.join("/")}`.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? (value as string[]) : [String(value ?? "")];

/** Inventaris handler Nest dengan metadata akses mentah dan efektif. */
function handlerInventory(app: NestFastifyApplication): Handler[] {
  const container = app.get(ModulesContainer);
  const reflector = app.get(Reflector);
  const scanner = new MetadataScanner();
  const handlers: Handler[] = [];
  for (const module of container.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as new () => unknown;
      const prototype = Object.getPrototypeOf(wrapper.instance) as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as () => unknown;
        const handlerPath: unknown = Reflect.getMetadata(PATH_METADATA, handler);
        if (handlerPath === undefined) continue;
        const method = RequestMethod[
          Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod
        ].toLowerCase() as HttpMethod;
        const pick = <T>(key: string): T | undefined =>
          (Reflect.getMetadata(key, handler) as T | undefined) ??
          (Reflect.getMetadata(key, controller) as T | undefined);
        const raw = {
          isPublic: pick<boolean>(PUBLIC_KEY) === true,
          audience: pick<string>(AUDIENCE_KEY) ?? null,
          memberAccess: pick<string>(MEMBER_ACCESS_KEY) ?? null,
          // @RequirePermission digabung dari kelas dan handler (semantik AuthGuard).
          permissions: [
            ...new Set([
              ...((Reflect.getMetadata(PERMISSIONS_KEY, handler) as string[] | undefined) ?? []),
              ...((Reflect.getMetadata(PERMISSIONS_KEY, controller) as string[] | undefined) ?? []),
            ]),
          ],
          permissionsAny: [...new Set(pick<string[]>(PERMISSIONS_ANY_KEY) ?? [])],
          role: pick<string>(ROLE_KEY) ?? null,
          reauth: pick<boolean>(REAUTH_KEY) === true,
        };
        const args =
          (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) as
            Record<string, { data?: unknown }> | undefined) ?? {};
        const readsIfMatch = Object.entries(args).some(
          ([key, arg]) =>
            Number(key.split(":")[0]) === RouteParamtypes.HEADERS &&
            String(arg.data ?? "").toLowerCase() === "if-match",
        );
        const httpCode = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
        for (const base of asList(Reflect.getMetadata(PATH_METADATA, controller)))
          for (const sub of asList(handlerPath))
            handlers.push({
              name: `${wrapper.name}.${name}`,
              method,
              path: joinPath(base, sub),
              meta: routeAuthMeta(reflector, [handler, controller]),
              raw,
              idempotent: pick<boolean>(IDEMPOTENT_KEY) === true,
              readsIfMatch,
              defaultStatus: httpCode ?? (method === "post" ? 201 : 200),
            });
      }
    }
  }
  return handlers;
}

/** Pola path rute (template `{x}` atau `:x`) → regex yang mencocokkan path konkret. */
function routeRegex(template: string): RegExp {
  const body = template
    .split("/")
    .map((segment) =>
      /^(\{[^}]+\}|:[A-Za-z0-9_]+)$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${body}$`);
}

/**
 * Handler untuk operasi: kecocokan template persis (nama parameter diabaikan) lebih dulu, lalu rute berparameter yang
 * melayani path literal kontrak (mis. `/admin/masters/{kind}` untuk `/admin/masters/professions`).
 */
function handlerFor(operation: Operation, handlers: Handler[]): Handler | undefined {
  const exact = handlers.find(
    (h) => h.method === operation.method && normalize(h.path) === normalize(operation.path),
  );
  if (exact) return exact;
  const concrete = operation.path.replace(/\{[^}]+\}/g, "contoh");
  return handlers.find((h) => h.method === operation.method && routeRegex(h.path).test(concrete));
}

/** Perbedaan akses efektif server terhadap `x-kapdh-access` satu operasi (kosong = sama). */
function accessDiff(access: ContractAccess, meta: Handler["raw"], idempotent: boolean): string[] {
  const sorted = (values: readonly string[] | undefined) => [...(values ?? [])].sort().join(",");
  const diff: string[] = [];
  const audience = meta.isPublic ? "public" : (meta.audience ?? "tidak ada");
  if (audience !== access.audience) diff.push(`audience kontrak ${access.audience}, server ${audience}`);
  if ((access.member_access ?? null) !== meta.memberAccess)
    diff.push(`member_access kontrak ${access.member_access ?? "-"}, server ${meta.memberAccess ?? "-"}`);
  if (sorted(access.permissions) !== sorted(meta.permissions))
    diff.push(`permissions kontrak [${sorted(access.permissions)}], server [${sorted(meta.permissions)}]`);
  if (sorted(access.permissions_any) !== sorted(meta.permissionsAny))
    diff.push(
      `permissions_any kontrak [${sorted(access.permissions_any)}], server [${sorted(meta.permissionsAny)}]`,
    );
  if ((access.role ?? null) !== meta.role)
    diff.push(`role kontrak ${access.role ?? "-"}, server ${meta.role ?? "-"}`);
  if (Boolean(access.reauth) !== meta.reauth)
    diff.push(`reauth kontrak ${Boolean(access.reauth)}, server ${meta.reauth}`);
  if (Boolean(access.idempotent) !== idempotent)
    diff.push(`idempotent kontrak ${Boolean(access.idempotent)}, server ${idempotent}`);
  return diff;
}

const operations = contractOperations();
let app: NestFastifyApplication;
let handlers: Handler[];
let fastifyRoutes: { method: string; url: string }[];
let testApp: TestApp;
let mobileToken: string;
let adminToken: string;

beforeAll(async () => {
  const t = await createTestApp();
  testApp = t;
  ({ app } = t);
  mobileToken = (await signInAlumni(t, await createAlumni(t, { status: "verified" }))).accessToken;
  adminToken = (await signInAdmin(t, await createAdmin(t, { role: "super_admin" }))).accessToken;
  handlers = handlerInventory(app);
  fastifyRoutes = registeredRoutes(
    app.getHttpAdapter().getInstance().printRoutes({ commonPrefix: false }),
  ).filter((route) => route.method !== "HEAD" && route.url.startsWith("/api/v1/"));
});
afterAll(async () => {
  await app.close();
});

/** `it` biasa, atau `it.fails` dengan id temuan bila ekspektasi ini tercatat sebagai temuan terbuka. */
function check(kind: Check, operation: Operation, fn: () => void | Promise<void>): void {
  const finding = KNOWN[kind][operation.operationId];
  const title = `${operation.operationId} (${operation.method.toUpperCase()} ${operation.path})`;
  if (finding) it.fails(`[${finding}] ${title}`, fn);
  else it(title, fn);
}

describe("D1 kelengkapan kontrak (dist/openapi.yaml)", () => {
  it("bundle kontrak berisi operasi dan setiap operasi menyatakan x-kapdh-access", () => {
    expect(operations.length).toBeGreaterThan(200);
    expect(operations.filter((op) => !op.access).map((op) => op.operationId)).toEqual([]);
  });

  it("operationId unik", () => {
    const ids = operations.map((op) => op.operationId);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it("pembaca metadata mentah (kunci src/core/guards) sama dengan routeAuthMeta yang dipakai AuthGuard", () => {
    for (const handler of handlers) {
      expect(handler.meta.problems, handler.name).toEqual([]);
      const effective = handler.meta;
      expect(
        {
          isPublic: effective.isPublic,
          audience: effective.audience,
          memberAccess: effective.memberAccess,
          permissions: [...effective.permissions].sort(),
          permissionsAny: [...effective.permissionsAny].sort(),
          role: effective.role,
          reauth: effective.reauth,
        },
        handler.name,
      ).toEqual({
        ...handler.raw,
        permissions: [...handler.raw.permissions].sort(),
        permissionsAny: [...handler.raw.permissionsAny].sort(),
      });
    }
  });

  it("setiap handler Nest terdaftar di Fastify dan sebaliknya (satu rute = satu handler)", () => {
    const fromNest = handlers.map((h) => `${h.method.toUpperCase()} /api/v1${normalize(h.path)}`).sort();
    const fromFastify = fastifyRoutes
      .map((r) => `${r.method} ${normalize(r.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}"))}`)
      .sort();
    expect(
      fromNest.filter((key, index) => fromNest.indexOf(key) !== index),
      "rute ganda",
    ).toEqual([]);
    expect(fromFastify).toEqual(fromNest);
  });

  it("setiap handler server mempunyai operasi kontrak (server → kontrak)", () => {
    const orphan = handlers.filter(
      (h) => !operations.some((op) => op.method === h.method && handlerFor(op, [h]) !== undefined),
    );
    expect(orphan.map((h) => `${h.method.toUpperCase()} ${h.path} (${h.name})`)).toEqual([]);
  });

  it("pengaman: pembanding mendeteksi setiap perbedaan dan operasi tanpa handler", () => {
    const raw: Handler["raw"] = {
      isPublic: false,
      audience: "mobile",
      memberAccess: "active",
      permissions: [],
      permissionsAny: [],
      role: null,
      reauth: false,
    };
    const contract: ContractAccess = {
      audience: "admin",
      permissions: ["payments.read"],
      permissions_any: ["members.read", "master.manage"],
      role: "super_admin",
      reauth: true,
      idempotent: true,
    };
    // audience, member_access, permissions, permissions_any, role, reauth, idempotent.
    expect(accessDiff(contract, raw, false)).toHaveLength(7);
    expect(accessDiff({ audience: "mobile", member_access: "active" }, raw, false)).toEqual([]);
    expect(
      accessDiff(
        { audience: "public" },
        { ...raw, isPublic: true, audience: null, memberAccess: null },
        false,
      ),
    ).toEqual([]);
    const missing: Operation = {
      operationId: "ujiTidakAda",
      method: "get",
      path: "/tidak-ada/{id}",
      access: { audience: "mobile" },
      headerParams: new Set(),
      allowsAnonymous: false,
      successStatuses: [200],
    };
    expect(handlerFor(missing, handlers)).toBeUndefined();
    // Path literal kontrak dilayani rute berparameter (mis. /admin/masters/{kind}).
    expect(handlerFor({ ...missing, path: "/admin/masters/professions" }, handlers)?.path).toBe(
      "/admin/masters/{kind}",
    );
  });
});

describe("D1 setiap operasi kontrak diimplementasikan (kontrak → rute Fastify + handler)", () => {
  for (const operation of operations)
    check("route", operation, () => {
      const handler = handlerFor(operation, handlers);
      expect(handler, "tidak ada handler Nest").toBeDefined();
      const concrete = `/api/v1${operation.path.replace(/\{[^}]+\}/g, "contoh")}`;
      const served = fastifyRoutes.some(
        (route) => route.method === operation.method.toUpperCase() && routeRegex(route.url).test(concrete),
      );
      expect(served, "tidak ada rute Fastify yang melayani path ini").toBe(true);
    });
});

describe("D1 dekorator akses handler = x-kapdh-access operasi (ARCHITECTURE §4.3)", () => {
  for (const operation of operations)
    check("access", operation, () => {
      const handler = handlerFor(operation, handlers);
      expect(handler, "tidak ada handler").toBeDefined();
      expect(operation.access, "tanpa x-kapdh-access").toBeDefined();
      expect(accessDiff(operation.access!, handler!.raw, handler!.idempotent)).toEqual([]);
      expect(accessDiff(operation.access!, handler!.meta, handler!.idempotent)).toEqual([]);
    });
});

describe("D1 header wajib dan keamanan dideklarasikan kontrak sesuai server (SDK dibangkitkan dari kontrak)", () => {
  for (const operation of operations)
    check("headers", operation, () => {
      const handler = handlerFor(operation, handlers);
      expect(handler, "tidak ada handler").toBeDefined();
      const access = operation.access!;
      const problems: string[] = [];
      const has = (name: string, header: string) =>
        operation.headerParams.has(name) || operation.headerParams.has(header);
      if (handler!.idempotent !== has("IdempotencyKey", "idempotency-key"))
        problems.push(
          `Idempotency-Key: server @Idempotent ${handler!.idempotent}, parameter kontrak ${has("IdempotencyKey", "idempotency-key")}`,
        );
      if (handler!.meta.reauth !== has("ReauthToken", "x-reauth-token"))
        problems.push(
          `X-Reauth-Token: server @RequireReauth ${handler!.meta.reauth}, parameter kontrak ${has("ReauthToken", "x-reauth-token")}`,
        );
      if (handler!.readsIfMatch !== has("IfMatch", "if-match"))
        problems.push(
          `If-Match: server membaca header ${handler!.readsIfMatch}, parameter kontrak ${has("IfMatch", "if-match")}`,
        );
      if ((access.audience === "public") !== operation.allowsAnonymous)
        problems.push(
          `security: audience ${access.audience} tetapi boleh tanpa kredensial ${operation.allowsAnonymous}`,
        );
      expect(problems).toEqual([]);
    });
});

describe("D1 status sukses bawaan handler dideklarasikan kontrak", () => {
  for (const operation of operations)
    check("status", operation, () => {
      const handler = handlerFor(operation, handlers);
      expect(handler, "tidak ada handler").toBeDefined();
      expect(operation.successStatuses, `${handler!.name} @HttpCode ${handler!.defaultStatus}`).toContain(
        handler!.defaultStatus,
      );
    });
});

// ------------------------------------------------------------------------------------- pemeriksaan saat berjalan

const SAMPLE_ID = "01a00000-0000-7000-8000-000000000000";
type InjectMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** URL konkret operasi: parameter path diisi UUID contoh (atau `professions` untuk {kind}). */
const urlOf = (operation: Operation) =>
  `/api/v1${operation.path.replace(/\{[^}]+\}/g, (name) => (name === "{kind}" ? "professions" : SAMPLE_ID))}`;

/** Permintaan dengan body kosong: guard dievaluasi sebelum pipe/validasi body, jadi tidak ada efek samping. */
const call = (method: InjectMethod, operation: Operation, token?: string) =>
  app.inject({
    method,
    url: urlOf(operation),
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(method === "GET" || method === "HEAD" || method === "DELETE" ? {} : { payload: {} }),
  });

const code = (body: string) => {
  try {
    return (JSON.parse(body) as { code?: string }).code ?? "";
  } catch {
    return "";
  }
};

const methodOf = (operation: Operation) => operation.method.toUpperCase() as InjectMethod;

describe("D1 saat berjalan: audience setiap operasi ditegakkan AuthGuard (tolak-bawaan, ARCHITECTURE §4.3)", () => {
  for (const operation of operations)
    check("runtime", operation, async () => {
      const audience = operation.access!.audience;
      const methods =
        operation.method === "get"
          ? (["GET", "HEAD"] as const)
          : ([operation.method.toUpperCase() as "POST" | "PUT" | "PATCH" | "DELETE"] as const);
      for (const method of methods) {
        const anonymous = await call(method, operation);
        if (audience === "public") {
          // Deklarasi rute yang salah (tanpa @Public) selalu berakhir 403 "Akses ditolak" dari guard.
          expect(anonymous.statusCode, `${method} anonim`).not.toBe(403);
          continue;
        }
        expect(anonymous.statusCode, `${method} anonim: ${anonymous.body}`).toBe(401);
        if (method !== "HEAD") expect(code(anonymous.body), `${method} anonim`).toBe("UNAUTHENTICATED");
        if (audience === "admin") {
          const mobile = await call(method, operation, mobileToken);
          expect(mobile.statusCode, `${method} sesi mobile: ${mobile.body}`).toBe(403);
        }
        if (audience === "mobile") {
          const admin = await call(method, operation, adminToken);
          expect(admin.statusCode, `${method} sesi admin: ${admin.body}`).toBe(403);
        }
      }
    });
});

describe("D1 saat berjalan: member_access setiap operasi = matriks PRD 2.2 (ARCHITECTURE §3.1)", () => {
  type Status = "unverified" | "verified" | "expiring" | "expired" | "suspended";
  const STATUSES: readonly Status[] = ["unverified", "verified", "expiring", "expired", "suspended"];
  const LEVEL: Record<"any" | "nonsuspended" | "active", readonly Status[]> = {
    any: STATUSES,
    nonsuspended: ["unverified", "verified", "expiring", "expired"],
    active: ["verified", "expiring"],
  };
  /** Mencabut sesi pemanggil: hanya arah "ditolak" yang diperiksa. */
  const REVOKES_SESSION = new Set(["logout", "logoutAll"]);
  /**
   * Penolakan keanggotaan di tingkat layanan yang memang ditetapkan kontrak (bukan guard), dengan status yang lolos
   * guard tetapi ditolak untuk objek contoh: getEvent hanya membuka event yang tiketnya dipegang anggota non-aktif.
   */
  const SERVICE_LEVEL: Record<string, readonly Status[]> = { getEvent: ["unverified", "expired"] };
  const tokens = new Map<Status, string>();

  beforeAll(async () => {
    for (const status of STATUSES)
      tokens.set(status, (await signInAlumni(testApp, await createAlumni(testApp, { status }))).accessToken);
  });

  for (const operation of operations.filter((op) => ["mobile", "any"].includes(op.access!.audience)))
    check("member", operation, async () => {
      const level = operation.access!.member_access;
      const allowed = level ? LEVEL[level] : STATUSES;
      for (const status of STATUSES) {
        const permitted = allowed.includes(status);
        if (permitted && REVOKES_SESSION.has(operation.operationId)) continue;
        const res = await call(methodOf(operation), operation, tokens.get(status));
        const membershipRejection =
          res.statusCode === 403 && ["MEMBERSHIP_REQUIRED", "ACCOUNT_SUSPENDED"].includes(code(res.body));
        if (!permitted) {
          expect(res.statusCode, `${status}: ${res.body}`).toBe(403);
          expect(code(res.body), status).toBe(
            status === "suspended" ? "ACCOUNT_SUSPENDED" : "MEMBERSHIP_REQUIRED",
          );
        } else if (!SERVICE_LEVEL[operation.operationId]?.includes(status)) {
          expect(membershipRejection, `${status} seharusnya lolos guard: ${res.body}`).toBe(false);
        }
      }
    });
});

describe("D1 saat berjalan: izin/peran admin setiap operasi = x-kapdh-access (AC F15-1, F16-3)", () => {
  const admins = new Map<string, string>();
  /** Token admin dengan tepat himpunan izin ini (super_admin bila `role`). */
  async function adminWith(permissions: readonly string[], role: "admin" | "super_admin" = "admin") {
    const key = `${role}:${[...permissions].sort().join(",")}`;
    let token = admins.get(key);
    if (!token) {
      const admin = await createAdmin(testApp, {
        role,
        permissions: [...permissions] as Permission[],
      });
      token = (await signInAdmin(testApp, admin)).accessToken;
      admins.set(key, token);
    }
    return token;
  }
  const guardForbidden = (res: { statusCode: number; body: string }) =>
    res.statusCode === 403 && code(res.body) === "FORBIDDEN";

  for (const operation of operations.filter((op) => op.access!.audience === "admin"))
    check("permission", operation, async () => {
      const access = operation.access!;
      const method = methodOf(operation);
      const required = access.permissions ?? [];
      const anyOf = access.permissions_any ?? [];
      const gated = required.length > 0 || anyOf.length > 0 || access.role !== undefined;

      // Admin tanpa izin apa pun: ditolak tepat bila operasi menyatakan izin/peran.
      const none = await call(method, operation, await adminWith([]));
      if (gated) expect(guardForbidden(none), `tanpa izin: ${none.body}`).toBe(true);
      else expect(guardForbidden(none), `tanpa izin seharusnya lolos: ${none.body}`).toBe(false);

      // Tepat izin yang dinyatakan (setiap anggota permissions_any sendiri-sendiri): lolos guard izin.
      const grants: { permissions: string[]; role: "admin" | "super_admin" }[] = access.role
        ? [{ permissions: [], role: access.role }]
        : anyOf.length > 0
          ? anyOf.map((p) => ({ permissions: [...required, p], role: "admin" as const }))
          : [{ permissions: required, role: "admin" as const }];
      for (const grant of grants) {
        const res = await call(method, operation, await adminWith(grant.permissions, grant.role));
        if (access.reauth)
          expect(code(res.body), `${grant.permissions.join(",")}: ${res.body}`).toBe("REAUTH_REQUIRED");
        else
          expect(guardForbidden(res), `${grant.role} [${grant.permissions.join(",")}]: ${res.body}`).toBe(
            false,
          );
      }

      // Semua izin wajib (AND): kurang satu izin → ditolak.
      if (required.length > 1)
        for (const missing of required) {
          const rest = required.filter((p) => p !== missing);
          const res = await call(
            method,
            operation,
            await adminWith(anyOf.length ? [...rest, anyOf[0]!] : rest),
          );
          expect(guardForbidden(res), `tanpa ${missing}: ${res.body}`).toBe(true);
        }

      // Peran wajib: admin biasa dengan seluruh izin tetap ditolak.
      if (access.role) {
        const res = await call(method, operation, await adminWith([...PERMISSIONS_FOR_ROLE_CHECK]));
        expect(guardForbidden(res), `admin biasa: ${res.body}`).toBe(true);
      }
    });
});

/** Seluruh izin yang dapat ditugaskan ke admin biasa (pemeriksaan @RequireRole). */
const PERMISSIONS_FOR_ROLE_CHECK = [
  "payments.read",
  "payments.decide",
  "members.read",
  "members.manage",
  "content.manage",
  "master.manage",
  "events.manage",
  "events.checkin",
  "moderation.read",
  "moderation.resolve",
  "audit.read",
  "audit.export",
  "settings.manage",
  "notifications.manage",
] as const;
