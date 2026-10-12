/**
 * Validasi respons API terhadap kontrak packages/contracts (PRD 5.2, 7.2: kontrak lebih dulu; N-13; ARCHITECTURE §6,
 * §9.1). Dipakai setiap tes endpoint `apps/api/test/<modul>/*.e2e.test.ts`:
 *
 * ```ts
 * import { expectOperation } from "../support/contract.js";
 * const body = expectOperation("get", "/me/payments/{paymentId}", await app.inject(...));
 * ```
 *
 * Kontrak dibaca dari bundle dist/openapi.yaml (root.yaml + domains/*.yaml) yang dibangun
 * `pnpm --filter @kapdh/contracts bundle`; turbo menjalankan build dependensi sebelum test.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { expect } from "vitest";
import { parse } from "yaml";

export type HttpMethod = "get" | "put" | "post" | "delete" | "patch";
type JsonObject = Record<string, unknown>;

/** Bentuk minimum respons `app.inject` (light-my-request) yang dibutuhkan validasi kontrak. */
export interface InjectResponse {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json(): unknown;
}

function loadSpec(): JsonObject & { paths: Record<string, JsonObject> } {
  const require = createRequire(import.meta.url);
  let specPath: string;
  try {
    specPath = require.resolve("@kapdh/contracts/openapi.yaml");
  } catch (error) {
    throw new Error(
      "Bundle kontrak @kapdh/contracts/openapi.yaml (packages/contracts/dist/openapi.yaml) belum ada; jalankan " +
        "`pnpm --filter @kapdh/contracts bundle` atau `pnpm build`.",
      { cause: error },
    );
  }
  return parse(readFileSync(specPath, "utf8")) as JsonObject & { paths: Record<string, JsonObject> };
}

/** Dokumen kontrak tergabung (dist/openapi.yaml). */
export const spec = loadSpec();

/** Validator Ajv 2020-12 dengan seluruh kontrak terdaftar sebagai `kapdh`. */
export const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats CJS: di ESM fungsi bisa berada di `default` atau langsung sebagai modul.
type AddFormats = (a: Ajv2020) => void;
const addFormats = ((addFormatsModule as unknown as { default?: AddFormats }).default ??
  addFormatsModule) as unknown as AddFormats;
addFormats(ajv);
ajv.addSchema({ ...spec, $id: "kapdh" });

/** Segmen JSON pointer dalam fragmen URI (RFC 6901 §6). */
const pointerSegment = (s: string) => encodeURIComponent(s.replaceAll("~", "~0").replaceAll("/", "~1"));

function resolvePointer(pointer: string): JsonObject {
  return pointer
    .replace(/^#\//, "")
    .split("/")
    .map((s) => decodeURIComponent(s).replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((node, key) => (node as JsonObject)[key], spec) as JsonObject;
}

/** Memvalidasi `body` terhadap `#/components/schemas/<name>`. */
export function expectSchema(name: string, body: unknown): void {
  const validate = ajv.getSchema(`kapdh#/components/schemas/${name}`);
  expect(validate, `skema ${name} tidak ada di kontrak`).toBeDefined();
  expect(validate!(body), `${name}: ${ajv.errorsText(validate!.errors)}`).toBe(true);
}

/**
 * Memvalidasi respons terhadap operasi kontrak (ARCHITECTURE §6): status harus dideklarasikan (status 2xx yang tidak
 * dideklarasikan selalu gagal; status lain jatuh ke `default`), lalu body divalidasi terhadap skema status itu.
 * `path` adalah template kontrak, mis. "/me/payments/{paymentId}".
 * Mengembalikan body JSON (atau undefined untuk respons tanpa body, mis. 204).
 */
export function expectOperation(method: HttpMethod, path: string, res: InjectResponse): unknown {
  const where = `${method.toUpperCase()} ${path} -> ${res.statusCode}`;
  const item = spec.paths[path];
  expect(item, `path ${path} tidak ada di kontrak`).toBeDefined();
  const operation = item![method] as { responses: Record<string, JsonObject> } | undefined;
  expect(operation, `${method.toUpperCase()} ${path} tidak ada di kontrak`).toBeDefined();

  const status = String(res.statusCode);
  const range = `${status[0]}XX`;
  let key: string;
  if (status in operation!.responses) key = status;
  else if (range in operation!.responses) key = range;
  else {
    expect(
      res.statusCode >= 200 && res.statusCode < 300,
      `${where}: status 2xx tidak dideklarasikan di kontrak`,
    ).toBe(false);
    expect(
      operation!.responses.default,
      `${where}: status tidak dideklarasikan dan tidak ada default`,
    ).toBeDefined();
    key = "default";
  }

  let pointer = `#/paths/${pointerSegment(path)}/${method}/responses/${pointerSegment(key)}`;
  let response = operation!.responses[key]!;
  while (typeof response.$ref === "string") {
    pointer = response.$ref;
    response = resolvePointer(pointer);
  }
  const content = response.content as Record<string, unknown> | undefined;
  if (!content?.["application/json"]) {
    expect(res.body, `${where}: kontrak tidak mendeklarasikan body`).toBe("");
    return undefined;
  }
  expect(String(res.headers["content-type"] ?? ""), `${where}: content-type`).toMatch(/^application\/json/);
  const body = res.json();
  const validate = ajv.getSchema(`kapdh${pointer}/content/application~1json/schema`);
  expect(validate, `${where}: skema respons tidak dapat dikompilasi`).toBeDefined();
  expect(validate!(body), `${where}: ${ajv.errorsText(validate!.errors)}`).toBe(true);
  return body;
}

/** Daftar rute Fastify dari pohon printRoutes({ commonPrefix: false }) (setiap tingkat diindentasi 4 karakter). */
export function registeredRoutes(tree: string): { method: string; url: string }[] {
  const routes: { method: string; url: string }[] = [];
  const stack: string[] = [];
  for (const line of tree.split("\n")) {
    const node = /^(.*?)(?:├── |└── )(.*)$/.exec(line);
    if (!node) continue;
    const depth = node[1]!.length / 4;
    const parts = /^(.*?)(?: \(([A-Z, ]+)\))?(?: \{.*\})?$/.exec(node[2]!)!;
    stack.length = depth;
    stack.push(parts[1]!);
    for (const method of parts[2]?.split(", ") ?? []) routes.push({ method, url: stack.join("") });
  }
  return routes;
}

/**
 * Rute terdaftar di bawah /api/v1 yang tidak memiliki operasi kontrak (HEAD otomatis dan OPTIONS * preflight CORS
 * dikecualikan). Kosong berarti setiap rute Fastify ada di kontrak (ARCHITECTURE §6).
 */
export function routesMissingFromContract(routes: { method: string; url: string }[]): string[] {
  const normalize = (p: string) => p.replace(/\{[^}]+\}/g, "{}");
  const contract = new Map(Object.entries(spec.paths).map(([p, item]) => [normalize(p), item]));
  const missing: string[] = [];
  for (const { method, url } of routes) {
    if (method === "HEAD" || (method === "OPTIONS" && url === "*")) continue;
    if (!url.startsWith("/api/v1/")) {
      missing.push(`${method} ${url} (di luar /api/v1)`);
      continue;
    }
    const path = normalize(url.slice("/api/v1".length).replace(/:([A-Za-z0-9_]+)/g, "{$1}"));
    if (!contract.get(path)?.[method.toLowerCase()]) missing.push(`${method} ${url}`);
  }
  return missing;
}

/** Deklarasi akses operasi kontrak (vendor extension `x-kapdh-access`, mencerminkan dekorator server). */
export interface ContractAccess {
  audience: "public" | "mobile" | "admin" | "any";
  member_access?: "any" | "nonsuspended" | "active";
  permissions?: string[];
  reauth?: boolean;
  idempotent?: boolean;
}

/** Bentuk minimum rute server yang dibandingkan (lihat test/support/routes.ts). */
export interface DeclaredRouteAccess {
  name: string;
  method: string;
  path: string;
  meta: {
    isPublic: boolean;
    audience: string | null;
    memberAccess: string | null;
    permissions: string[];
    reauth: boolean;
  };
  idempotent: boolean;
}

/**
 * Perbedaan antara dekorator akses server dan `x-kapdh-access` operasi kontrak (ARCHITECTURE §4.3, §6). Operasi tanpa
 * `x-kapdh-access` dilewati; rute tanpa operasi kontrak ditangani routesMissingFromContract.
 */
export function accessMismatches(
  routes: DeclaredRouteAccess[],
  paths: Record<string, JsonObject> = spec.paths,
): string[] {
  const normalize = (p: string) => p.replace(/\{[^}]+\}/g, "{}");
  const byPath = new Map(Object.entries(paths).map(([p, item]) => [normalize(p), item]));
  const sorted = (values: readonly string[] | undefined) => [...(values ?? [])].sort().join(",");
  const problems: string[] = [];
  for (const route of routes) {
    const operation = byPath.get(normalize(route.path))?.[route.method] as JsonObject | undefined;
    const access = operation?.["x-kapdh-access"] as ContractAccess | undefined;
    if (!access) continue;
    const where = `${route.method.toUpperCase()} ${route.path} (${route.name})`;
    const audience = route.meta.isPublic ? "public" : (route.meta.audience ?? "tidak ada");
    if (audience !== access.audience)
      problems.push(`${where}: audience kontrak ${access.audience}, server ${audience}`);
    if ((access.member_access ?? null) !== route.meta.memberAccess)
      problems.push(
        `${where}: member_access kontrak ${access.member_access ?? "-"}, server ${route.meta.memberAccess ?? "-"}`,
      );
    if (sorted(access.permissions) !== sorted(route.meta.permissions))
      problems.push(
        `${where}: permissions kontrak [${sorted(access.permissions)}], server [${sorted(route.meta.permissions)}]`,
      );
    if (Boolean(access.reauth) !== route.meta.reauth)
      problems.push(`${where}: reauth kontrak ${Boolean(access.reauth)}, server ${route.meta.reauth}`);
    if (Boolean(access.idempotent) !== route.idempotent)
      problems.push(`${where}: idempotent kontrak ${Boolean(access.idempotent)}, server ${route.idempotent}`);
  }
  return problems;
}
