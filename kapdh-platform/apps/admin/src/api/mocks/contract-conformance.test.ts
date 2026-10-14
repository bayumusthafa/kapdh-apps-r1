import { PERMISSION_VALUES, type Permission } from "@kapdh/contracts";
import specText from "@kapdh/contracts/openapi.yaml?raw";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mockAudit } from "./audit";
import { MOCK_CREDENTIALS, mockAuth } from "./auth";
import { CONTENT_IDS } from "./content";
import { MOCK_EVENT_IDS, MOCK_TICKET_QR } from "./events";
import type { S } from "./http";
import { matchMockRoute, mockFetch, mockRouteTable } from "./index";
import { MOCK_INVITE_TOKEN, MOCK_EXPIRED_INVITE_TOKEN } from "./invitations";
import { MOCK_REPORT_IDS } from "./moderation";
import { MOCK_DELIVERY_IDS, MOCK_OUTBOX_IDS } from "./notifications";
import { MOCK_PROOF_FILE_ID } from "./payments";

/**
 * Kesesuaian server tiruan web admin dengan kontrak (audit D6, ARCHITECTURE §6, §7). Setiap rute tiruan dipanggil
 * dengan permintaan representatif (jalur berhasil dan beberapa jalur galat), lalu body setiap respons divalidasi
 * terhadap skema operasi kontrak untuk status itu (Ajv 2020-12 + format, bundle dist/openapi.yaml), dengan aturan yang
 * sama seperti `expectOperation` di apps/api/test/support/contract.ts: status 2xx wajib dideklarasikan, status lain
 * yang tidak dideklarasikan jatuh ke `default`, respons tanpa content di kontrak wajib tanpa body.
 *
 * Halaman admin diuji di atas tiruan ini, sehingga tiruan yang menyimpang dari kontrak membuat uji UI lulus untuk bentuk
 * data yang tidak pernah dikirim server (PRD 7.3: mock bukan bukti AC). Tiruan yang belum sesuai dicatat di
 * KNOWN_NONCONFORMING beserta id temuan audit; uji rute itu GAGAL bila tiruan sudah diperbaiki agar daftar dibersihkan.
 */

// ---------------------------------------------------------------------------------------------------------------
// Validator kontrak
// ---------------------------------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const spec = parse(specText) as JsonObject & { paths: Record<string, JsonObject> };
const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats CJS: fungsi bisa berada di `default` atau langsung sebagai modul (sama dengan apps/api).
type AddFormats = (a: Ajv2020) => void;
const addFormats = ((addFormatsModule as unknown as { default?: AddFormats }).default ??
  addFormatsModule) as unknown as AddFormats;
addFormats(ajv);
ajv.addSchema({ ...spec, $id: "kapdh" });

const pointerSegment = (s: string) => encodeURIComponent(s.replaceAll("~", "~0").replaceAll("/", "~1"));

function resolvePointer(pointer: string): JsonObject {
  return pointer
    .replace(/^#\//, "")
    .split("/")
    .map((s) => decodeURIComponent(s).replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((node, key) => (node as JsonObject)[key], spec) as JsonObject;
}

/** Pelanggaran kontrak satu respons (kosong = sesuai). */
function contractViolations(
  method: HttpMethod,
  template: string,
  status: number,
  contentType: string,
  text: string,
): string[] {
  const where = `${method} ${template} -> ${status}`;
  const operation = spec.paths[template]?.[method.toLowerCase()] as
    { responses: Record<string, JsonObject> } | undefined;
  if (!operation) return [`${where}: operasi tidak ada di kontrak`];
  const code = String(status);
  const range = `${code[0]}XX`;
  let key: string;
  if (code in operation.responses) key = code;
  else if (range in operation.responses) key = range;
  else if (status >= 200 && status < 300) return [`${where}: status 2xx tidak dideklarasikan di kontrak`];
  else if (operation.responses.default) key = "default";
  else return [`${where}: status tidak dideklarasikan dan tidak ada default`];

  let pointer = `#/paths/${pointerSegment(template)}/${method.toLowerCase()}/responses/${pointerSegment(key)}`;
  let response = operation.responses[key]!;
  while (typeof response.$ref === "string") {
    pointer = response.$ref;
    response = resolvePointer(pointer);
  }
  const content = response.content as JsonObject | undefined;
  if (!content)
    return text === "" ? [] : [`${where}: kontrak tidak mendeklarasikan body, tiruan mengirim body`];
  if (!content["application/json"]) {
    const type = contentType.split(";")[0]!.trim().toLowerCase();
    return Object.keys(content).includes(type) ? [] : [`${where}: content-type ${type} tidak dideklarasikan`];
  }
  if (!/^application\/json/.test(contentType)) return [`${where}: content-type ${contentType} bukan JSON`];
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return [`${where}: body bukan JSON`];
  }
  const validate = ajv.getSchema(`kapdh${pointer}/content/application~1json/schema`);
  if (!validate) return [`${where}: skema respons tidak dapat dikompilasi`];
  if (!validate(body))
    return (validate.errors ?? []).map(
      (e) => `${where}: ${e.instancePath || "(akar)"} ${e.message ?? ""}${paramsText(e.params)}`,
    );
  const schema = resolvePointer(`${pointer}/content/application~1json/schema`);
  return undeclaredFields([schema], body, "").map((p) => `${where}: ${p} tidak dideklarasikan di kontrak`);
}

/** Ikuti $ref (dalam dokumen) sampai skema konkret. */
function deref(schema: unknown): JsonObject {
  let s = (schema ?? {}) as JsonObject;
  for (let i = 0; i < 20 && typeof s.$ref === "string"; i += 1) s = resolvePointer(s.$ref);
  return s;
}

/** Semua cabang skema yang berlaku di satu posisi (allOf digabung; oneOf/anyOf/if-then-else semua cabang). */
function branches(schemas: unknown[]): JsonObject[] {
  const out: JsonObject[] = [];
  const visit = (raw: unknown) => {
    const s = deref(raw);
    out.push(s);
    for (const k of ["allOf", "oneOf", "anyOf"] as const)
      if (Array.isArray(s[k])) for (const sub of s[k] as unknown[]) visit(sub);
    for (const k of ["then", "else"] as const) if (s[k]) visit(s[k]);
  };
  for (const s of schemas) visit(s);
  return out;
}

/**
 * Field objek yang dikirim tiruan tetapi tidak dideklarasikan skema mana pun di posisinya. Sebagian besar skema
 * kontrak tidak menutup `additionalProperties`, sehingga Ajv menerima field karangan; halaman yang membaca field seperti
 * itu lulus uji di atas tiruan tetapi tidak pernah menerimanya dari server. Objek bebas (tanpa `properties`, atau
 * dengan `additionalProperties` yang terbuka eksplisit) tidak diperiksa.
 */
function undeclaredFields(schemas: unknown[], value: unknown, path: string): string[] {
  const all = branches(schemas);
  if (Array.isArray(value)) {
    const items = all.map((s) => s.items).filter((x) => x !== undefined);
    return items.length === 0 ? [] : value.flatMap((v, i) => undeclaredFields(items, v, `${path}/${i}`));
  }
  if (value === null || typeof value !== "object") return [];
  const declared = new Map<string, unknown[]>();
  let open = false;
  for (const s of all) {
    const props = s.properties as JsonObject | undefined;
    if (props) for (const [k, v] of Object.entries(props)) declared.set(k, [...(declared.get(k) ?? []), v]);
    const extra = s.additionalProperties;
    if (extra === true || (typeof extra === "object" && extra !== null) || s.patternProperties) open = true;
  }
  if (declared.size === 0) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as JsonObject)) {
    const sub = declared.get(k);
    if (!sub) {
      if (!open) out.push(`${path}/${k}`);
      continue;
    }
    out.push(...undeclaredFields(sub, v, `${path}/${k}`));
  }
  return out;
}

function paramsText(params: unknown): string {
  const p = params as Record<string, unknown> | undefined;
  if (!p) return "";
  if (typeof p.additionalProperty === "string") return ` (${p.additionalProperty})`;
  if (typeof p.missingProperty === "string") return ` (${p.missingProperty})`;
  if (Array.isArray(p.allowedValues)) return ` (${p.allowedValues.join("|")})`;
  return "";
}

// ---------------------------------------------------------------------------------------------------------------
// Tiruan yang diketahui belum sesuai kontrak (temuan audit D6). Kunci: "METHOD /template".
// ---------------------------------------------------------------------------------------------------------------

const KNOWN_NONCONFORMING: Record<string, string> = {};

/**
 * Operasi kontrak web admin (audience admin, atau path /admin/**) yang belum memiliki rute tiruan, beserta alasannya.
 * Halaman yang kelak memakai operasi ini wajib menambah tiruannya lebih dahulu (ARCHITECTURE §7).
 */
const KNOWN_WITHOUT_MOCK: Record<string, string> = {
  "POST /admin/payments":
    "D6-01: adminRecordPayment (rencana cadangan D13) belum memiliki layar maupun tiruan di web admin",
  "GET /admin/content/event-categories/{categoryId}":
    "adminGetEventCategory tidak dipakai UI (lembar kategori event membaca daftar)",
};

// ---------------------------------------------------------------------------------------------------------------
// Pemanggil
// ---------------------------------------------------------------------------------------------------------------

/** Pelanggaran per rute di uji yang sedang berjalan, dan seluruh rute yang pernah dipanggil di berkas ini. */
let current = new Map<string, string[]>();
const exercised = new Map<string, Set<number>>();
const allViolations = new Map<string, Set<string>>();

let accessToken: string | null = null;

interface CallOptions {
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** null = tanpa Authorization. Bawaan: token sesi uji. */
  token?: string | null;
  multipart?: { fields: Record<string, string>; file?: { name: string; type: string; bytes: Uint8Array } };
}

interface CallResult<T> {
  status: number;
  body: T;
  key: string;
}

function routeKey(method: HttpMethod, path: string): { key: string; template: string | null } {
  const match = matchMockRoute(method, path);
  return match
    ? { key: `${method} ${match.route.path}`, template: match.route.path }
    : { key: `${method} ${path}`, template: null };
}

function encodeMultipart(opts: NonNullable<CallOptions["multipart"]>): {
  body: Uint8Array<ArrayBuffer>;
  type: string;
} {
  const boundary = "----kapdh-kontrak-7f3a9c2e";
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(opts.fields))
    parts.push(
      enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  if (opts.file) {
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.file.name}"\r\n` +
          `Content-Type: ${opts.file.type}\r\n\r\n`,
      ),
    );
    parts.push(opts.file.bytes);
    parts.push(enc.encode("\r\n"));
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

/** PNG kecil dengan header IHDR 1280x720 (tiruan membaca dimensi dari header). */
function pngBytes(): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  b.set([0, 0, 0x05, 0x00, 0, 0, 0x02, 0xd0], 16);
  return b;
}

async function call<T = unknown>(
  method: HttpMethod,
  path: string,
  opts: CallOptions = {},
): Promise<CallResult<T>> {
  const url = new URL(`http://localhost/api/v1${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers = new Headers(opts.headers);
  const token = opts.token === undefined ? accessToken : opts.token;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let body: BodyInit | undefined;
  if (opts.multipart) {
    const encoded = encodeMultipart(opts.multipart);
    body = encoded.body;
    headers.set("Content-Type", encoded.type);
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers.set("Content-Type", "application/json");
  }
  const res = await mockFetch(new Request(url, { method, headers, body }));
  const text = await res.text();
  const { key, template } = routeKey(method, path);
  const violations = template
    ? contractViolations(method, template, res.status, res.headers.get("content-type") ?? "", text)
    : [`${key}: tidak ada rute tiruan (${res.status})`];
  exercised.set(key, (exercised.get(key) ?? new Set()).add(res.status));
  current.set(key, [...(current.get(key) ?? []), ...violations]);
  if (violations.length > 0) {
    const set = allViolations.get(key) ?? new Set<string>();
    for (const v of violations) set.add(v);
    allViolations.set(key, set);
  }
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as T, key };
}

/** Masuk sebagai admin tiruan (Super Admin bawaan) lewat login + MFA tiruan. */
async function signIn(): Promise<void> {
  const login = await call<S["AdminLoginResponse"]>("POST", "/admin/auth/login", {
    token: null,
    body: { email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password },
  });
  const mfa = await call<S["AdminSession"]>("POST", "/admin/auth/mfa", {
    token: null,
    body: { mfa_token: login.body.mfa_token, totp_code: MOCK_CREDENTIALS.totp },
  });
  accessToken = mfa.body.access_token;
}

async function reauth(): Promise<Record<string, string>> {
  const res = await call<S["ReauthResponse"]>("POST", "/auth/reauth", {
    body: { password: MOCK_CREDENTIALS.password, totp_code: MOCK_CREDENTIALS.totp },
  });
  return { "X-Reauth-Token": res.body.reauth_token };
}

const ifMatch = (version: string | number) => ({ "If-Match": String(version) });
const idem = () => ({ "Idempotency-Key": crypto.randomUUID() });
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeEach(async () => {
  current = new Map();
  accessToken = null;
  await signIn();
  current = new Map();
});

/**
 * Satu uji per rute tiruan: skenario dijalankan pada server tiruan yang baru di-reset, lalu seluruh respons rute itu
 * harus sesuai kontrak (kecuali tercatat di KNOWN_NONCONFORMING).
 */
function route(key: string, scenario: () => Promise<void>): void {
  it(key, async () => {
    await scenario();
    expect(exercised.has(key), `${key} tidak pernah dipanggil skenario`).toBe(true);
    const violations = current.get(key) ?? [];
    const known = KNOWN_NONCONFORMING[key];
    if (known)
      expect(
        violations.length,
        `${key} tercatat tidak sesuai (${known}) tetapi kini sesuai kontrak: hapus dari KNOWN_NONCONFORMING`,
      ).toBeGreaterThan(0);
    else expect(violations).toEqual([]);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Skenario per area
// ---------------------------------------------------------------------------------------------------------------

describe("tiruan auth admin (admin-auth, auth)", () => {
  route("POST /admin/auth/login", async () => {
    const ok = await call("POST", "/admin/auth/login", {
      token: null,
      body: { email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password },
    });
    expect(ok.status).toBe(200);
    const bad = await call("POST", "/admin/auth/login", {
      token: null,
      body: { email: MOCK_CREDENTIALS.email, password: "Salah#2026" },
    });
    expect(bad.status).toBe(401);
  });

  route("POST /admin/auth/mfa", async () => {
    const login = await call<S["AdminLoginResponse"]>("POST", "/admin/auth/login", {
      token: null,
      body: { email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password },
    });
    const wrong = await call("POST", "/admin/auth/mfa", {
      token: null,
      body: { mfa_token: login.body.mfa_token, totp_code: "000000" },
    });
    expect(wrong.status).toBe(400);
    const ok = await call("POST", "/admin/auth/mfa", {
      token: null,
      body: { mfa_token: login.body.mfa_token, backup_code: MOCK_CREDENTIALS.backupCode },
    });
    expect(ok.status).toBe(200);
    const expired = await call("POST", "/admin/auth/mfa", {
      token: null,
      body: { mfa_token: "mock-mfa-tidak-ada", totp_code: MOCK_CREDENTIALS.totp },
    });
    expect(expired.status).toBe(401);
  });

  route("POST /auth/refresh", async () => {
    const ok = await call("POST", "/auth/refresh", { token: null, body: {} });
    expect(ok.status).toBe(200);
    mockAuth.revokeSession();
    const ended = await call("POST", "/auth/refresh", { token: null, body: {} });
    expect(ended.status).toBe(401);
  });

  route("GET /admin/me", async () => {
    expect((await call("GET", "/admin/me")).status).toBe(200);
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    expect((await call("GET", "/admin/me")).status).toBe(200);
    expect((await call("GET", "/admin/me", { token: null })).status).toBe(401);
  });

  route("POST /auth/reauth", async () => {
    const wrong = await call("POST", "/auth/reauth", {
      body: { password: "Salah#2026", totp_code: MOCK_CREDENTIALS.totp },
    });
    expect(wrong.status).toBe(400);
    const ok = await call("POST", "/auth/reauth", {
      body: { password: MOCK_CREDENTIALS.password, totp_code: MOCK_CREDENTIALS.totp },
    });
    expect(ok.status).toBe(200);
  });

  route("POST /auth/logout", async () => {
    expect((await call("POST", "/auth/logout", { body: {} })).status).toBe(204);
    expect((await call("POST", "/auth/logout", { body: {} })).status).toBe(401);
  });
});

describe("tiruan undangan dan pendaftaran TOTP (admin-auth)", () => {
  route("POST /admin/auth/invitations/preview", async () => {
    const ok = await call("POST", "/admin/auth/invitations/preview", {
      token: null,
      body: { invite_token: MOCK_INVITE_TOKEN },
    });
    expect(ok.status).toBe(200);
    const gone = await call("POST", "/admin/auth/invitations/preview", {
      token: null,
      body: { invite_token: MOCK_EXPIRED_INVITE_TOKEN },
    });
    expect(gone.status).toBe(410);
    const bad = await call("POST", "/admin/auth/invitations/preview", {
      token: null,
      body: { invite_token: "x" },
    });
    expect(bad.status).toBe(400);
  });

  async function accept(): Promise<string> {
    const res = await call<S["AdminLoginResponse"]>("POST", "/admin/auth/invitations/accept", {
      token: null,
      body: { invite_token: MOCK_INVITE_TOKEN, password: "Undangan#2026" },
    });
    expect(res.status).toBe(200);
    return res.body.mfa_token;
  }

  route("POST /admin/auth/invitations/accept", async () => {
    const weak = await call("POST", "/admin/auth/invitations/accept", {
      token: null,
      body: { invite_token: MOCK_INVITE_TOKEN, password: "lemah" },
    });
    expect(weak.status).toBe(400);
    await accept();
    const again = await call("POST", "/admin/auth/invitations/accept", {
      token: null,
      body: { invite_token: MOCK_INVITE_TOKEN, password: "Undangan#2026" },
    });
    expect(again.status).toBe(410);
  });

  route("POST /admin/auth/totp/enroll", async () => {
    const token = await accept();
    expect(
      (await call("POST", "/admin/auth/totp/enroll", { token: null, body: { mfa_token: token } })).status,
    ).toBe(200);
    const bad = await call("POST", "/admin/auth/totp/enroll", { token: null, body: { mfa_token: "salah" } });
    expect(bad.status).toBe(401);
  });

  route("POST /admin/auth/totp/confirm", async () => {
    const token = await accept();
    await call("POST", "/admin/auth/totp/enroll", { token: null, body: { mfa_token: token } });
    const wrong = await call("POST", "/admin/auth/totp/confirm", {
      token: null,
      body: { mfa_token: token, totp_code: "000000" },
    });
    expect(wrong.status).toBe(400);
    const ok = await call("POST", "/admin/auth/totp/confirm", {
      token: null,
      body: { mfa_token: token, totp_code: MOCK_CREDENTIALS.totp },
    });
    expect(ok.status).toBe(200);
    const done = await call("POST", "/admin/auth/totp/confirm", {
      token: null,
      body: { mfa_token: token, totp_code: MOCK_CREDENTIALS.totp },
    });
    expect(done.status).toBe(403);
  });
});

describe("tiruan akun admin sendiri (auth, admin-auth)", () => {
  route("GET /auth/sessions", async () => {
    expect((await call("GET", "/auth/sessions", { query: { limit: "100" } })).status).toBe(200);
  });

  route("DELETE /auth/sessions/{sessionId}", async () => {
    const list = await call<S["SessionPage"]>("GET", "/auth/sessions");
    const other = list.body.items.find((s) => !s.current)!;
    expect((await call("DELETE", `/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await call("DELETE", `/auth/sessions/${other.id}`)).status).toBe(404);
  });

  route("POST /auth/logout-all", async () => {
    expect((await call("POST", "/auth/logout-all", { body: {} })).status).toBe(204);
  });

  route("POST /admin/auth/password/change", async () => {
    const wrong = await call("POST", "/admin/auth/password/change", {
      body: { current_password: "Salah#2026", new_password: "SandiBaru#2026" },
    });
    expect(wrong.status).toBe(400);
    const ok = await call("POST", "/admin/auth/password/change", {
      body: { current_password: MOCK_CREDENTIALS.password, new_password: "SandiBaru#2026" },
    });
    expect(ok.status).toBe(204);
  });

  route("POST /admin/auth/backup-codes", async () => {
    expect((await call("POST", "/admin/auth/backup-codes", { body: {} })).status).toBe(403);
    const ok = await call("POST", "/admin/auth/backup-codes", { body: {}, headers: await reauth() });
    expect(ok.status).toBe(200);
  });
});

describe("tiruan manajemen admin (admin-admins)", () => {
  async function admins(): Promise<S["AdminAccountPage"]["items"]> {
    const res = await call<S["AdminAccountPage"]>("GET", "/admin/admins", { query: { limit: "100" } });
    return res.body.items;
  }
  async function detail(id: string): Promise<S["AdminAccountDetail"]> {
    return (await call<S["AdminAccountDetail"]>("GET", `/admin/admins/${id}`)).body;
  }

  route("GET /admin/permissions", async () => {
    expect((await call("GET", "/admin/permissions")).status).toBe(200);
  });

  route("GET /admin/admins", async () => {
    expect((await call("GET", "/admin/admins", { query: { limit: "100" } })).status).toBe(200);
    expect((await call("GET", "/admin/admins", { query: { status: "invited" } })).status).toBe(200);
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    expect((await call("GET", "/admin/admins")).status).toBe(403);
  });

  route("GET /admin/admins/candidates", async () => {
    expect((await call("GET", "/admin/admins/candidates", { query: { limit: "100" } })).status).toBe(200);
  });

  route("GET /admin/admins/{adminId}", async () => {
    for (const a of await admins()) expect((await call("GET", `/admin/admins/${a.id}`)).status).toBe(200);
    expect((await call("GET", "/admin/admins/0199e000-0000-7000-8000-00000000ffff")).status).toBe(404);
  });

  route("POST /admin/admins", async () => {
    const headers = { ...(await reauth()), ...idem() };
    const ok = await call("POST", "/admin/admins", {
      headers,
      body: {
        role: "admin",
        permissions: ["members.read"],
        email: "uji.kontrak@kapdh.test",
        display_name: "Uji",
      },
    });
    expect(ok.status).toBe(201);
    const candidates = await call<S["AdminCandidatePage"]>("GET", "/admin/admins/candidates");
    const eligible = candidates.body.items.find((c) => c.eligible);
    if (eligible) {
      const linked = await call("POST", "/admin/admins", {
        headers: { ...(await reauth()), ...idem() },
        body: { role: "super_admin", permissions: [], alumni_user_id: eligible.user_id },
      });
      expect(linked.status).toBe(201);
    }
    const dup = await call("POST", "/admin/admins", {
      headers: { ...(await reauth()), ...idem() },
      body: {
        role: "admin",
        permissions: ["members.read"],
        email: "uji.kontrak@kapdh.test",
        display_name: "Uji",
      },
    });
    expect(dup.status).toBe(409);
  });

  route("PATCH /admin/admins/{adminId}", async () => {
    const list = await admins();
    const target = list.find((a) => a.status === "active" && a.role === "admin")!;
    const d = await detail(target.id);
    const ok = await call("PATCH", `/admin/admins/${d.id}`, {
      headers: { ...(await reauth()), ...ifMatch(d.version) },
      body: { display_name: "Nama Baru" },
    });
    expect(ok.status).toBe(200);
    const stale = await call("PATCH", `/admin/admins/${d.id}`, {
      headers: { ...(await reauth()), ...ifMatch(d.version) },
      body: { display_name: "Nama Lagi" },
    });
    expect(stale.status).toBe(409);
    const fresh = await detail(d.id);
    const disabled = await call("PATCH", `/admin/admins/${d.id}`, {
      headers: { ...(await reauth()), ...ifMatch(fresh.version) },
      body: { status: "disabled", reason: "Uji kontrak" },
    });
    expect(disabled.status).toBe(200);
  });

  route("DELETE /admin/admins/{adminId}", async () => {
    const invited = (await admins()).find((a) => a.status === "invited")!;
    const d = await detail(invited.id);
    const ok = await call("DELETE", `/admin/admins/${d.id}`, {
      headers: { ...(await reauth()), ...ifMatch(d.version) },
    });
    expect(ok.status).toBe(204);
    const activeOnce = (await admins()).find((a) => a.status === "active" && a.role === "admin")!;
    const active = await detail(activeOnce.id);
    const refused = await call("DELETE", `/admin/admins/${active.id}`, {
      headers: { ...(await reauth()), ...ifMatch(active.version) },
    });
    expect(refused.status).toBe(409);
  });

  route("POST /admin/admins/{adminId}/invitation", async () => {
    const invited = (await admins()).find((a) => a.status === "invited")!;
    const d = await detail(invited.id);
    const ok = await call("POST", `/admin/admins/${d.id}/invitation`, {
      headers: { ...(await reauth()), ...ifMatch(d.version), ...idem() },
      body: {},
    });
    expect(ok.status).toBe(200);
  });

  route("POST /admin/admins/{adminId}/recovery", async () => {
    const list = await admins();
    const candidates = await Promise.all(list.map((a) => detail(a.id)));
    const target = candidates.find(
      (d) => d.activated_at !== null && d.id !== "0199e000-0000-7000-8000-0000000000ad",
    )!;
    const ok = await call("POST", `/admin/admins/${target.id}/recovery`, {
      headers: { ...(await reauth()), ...ifMatch(target.version), ...idem() },
      body: { reason: "Perangkat TOTP hilang" },
    });
    expect(ok.status).toBe(200);
  });
});

describe("tiruan audit (admin-audit)", () => {
  route("GET /admin/audit/entries", async () => {
    expect((await call("GET", "/admin/audit/entries", { query: { limit: "100" } })).status).toBe(200);
    expect((await call("GET", "/admin/audit/entries", { query: { from: "bukan-waktu" } })).status).toBe(400);
  });

  route("GET /admin/audit/entries/{entryId}", async () => {
    const list = await call<S["AuditEntryPage"]>("GET", "/admin/audit/entries", { query: { limit: "100" } });
    for (const e of list.body.items)
      expect((await call("GET", `/admin/audit/entries/${e.id}`)).status).toBe(200);
    expect((await call("GET", "/admin/audit/entries/bukan-uuid")).status).toBe(400);
  });

  async function createExport(): Promise<S["AuditExport"]> {
    const list = await call<S["AuditEntryPage"]>("GET", "/admin/audit/entries", { query: { limit: "1" } });
    const res = await call<S["AuditExport"]>("POST", "/admin/audit/exports", {
      headers: idem(),
      body: { request_id: list.body.items[0]!.request_id },
    });
    expect(res.status).toBe(202);
    return res.body;
  }

  route("POST /admin/audit/exports", async () => {
    await createExport();
    const bad = await call("POST", "/admin/audit/exports", { headers: idem(), body: { from: "x" } });
    expect(bad.status).toBe(400);
  });

  route("GET /admin/audit/exports", async () => {
    await createExport();
    expect((await call("GET", "/admin/audit/exports")).status).toBe(200);
    mockAudit.finishExports();
    expect((await call("GET", "/admin/audit/exports")).status).toBe(200);
  });

  route("GET /admin/audit/exports/{exportId}", async () => {
    const x = await createExport();
    expect((await call("GET", `/admin/audit/exports/${x.id}`)).status).toBe(200);
    mockAudit.finishExports();
    expect((await call("GET", `/admin/audit/exports/${x.id}`)).status).toBe(200);
    mockAudit.expireExports();
    expect((await call("GET", `/admin/audit/exports/${x.id}`)).status).toBe(200);
    mockAudit.failNextExport("row_limit_exceeded");
    const failed = await createExport();
    mockAudit.finishExports();
    expect((await call("GET", `/admin/audit/exports/${failed.id}`)).status).toBe(200);
  });

  route("GET /admin/audit/exports/{exportId}/access", async () => {
    const x = await createExport();
    expect((await call("GET", `/admin/audit/exports/${x.id}/access`)).status).toBe(409);
    mockAudit.finishExports();
    expect((await call("GET", `/admin/audit/exports/${x.id}/access`)).status).toBe(200);
  });
});

describe("tiruan konten (admin-content)", () => {
  async function upload(purpose: "post_cover" | "banner_image"): Promise<S["ContentMedia"]> {
    const res = await call<S["ContentMedia"]>("POST", "/admin/content/media", {
      multipart: { fields: { purpose }, file: { name: "gambar.png", type: "image/png", bytes: pngBytes() } },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function newPost(): Promise<S["AdminPost"]> {
    const res = await call<S["AdminPost"]>("POST", "/admin/content/posts", {
      headers: idem(),
      body: { title: "Kabar Uji Kontrak", body_html: "<p>Isi berita.</p>" },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  route("POST /admin/content/media", async () => {
    await upload("post_cover");
    await upload("banner_image");
    const bad = await call("POST", "/admin/content/media", {
      multipart: {
        fields: { purpose: "post_cover" },
        file: { name: "a.gif", type: "image/gif", bytes: pngBytes() },
      },
    });
    expect(bad.status).toBe(415);
  });

  route("GET /admin/content/posts", async () => {
    expect((await call("GET", "/admin/content/posts", { query: { limit: "100" } })).status).toBe(200);
    expect((await call("GET", "/admin/content/posts", { query: { state: "scheduled" } })).status).toBe(200);
  });

  route("POST /admin/content/posts", async () => {
    const cover = await upload("post_cover");
    const ok = await call("POST", "/admin/content/posts", {
      headers: idem(),
      body: {
        title: "Kabar dengan Cover",
        body_html: "<p>Isi.</p>",
        excerpt: "Ringkas",
        cover_file_id: cover.file_id,
        category_id: CONTENT_IDS.categoryPengumuman,
      },
    });
    expect(ok.status).toBe(201);
    await newPost();
    const bad = await call("POST", "/admin/content/posts", { headers: idem(), body: { title: "" } });
    expect(bad.status).toBe(400);
  });

  route("GET /admin/content/posts/{postId}", async () => {
    const list = await call<S["AdminPostPage"]>("GET", "/admin/content/posts", { query: { limit: "100" } });
    for (const p of list.body.items)
      expect((await call("GET", `/admin/content/posts/${p.id}`)).status).toBe(200);
    expect((await call("GET", "/admin/content/posts/0199e100-0000-7000-8000-00000000ffff")).status).toBe(404);
  });

  route("PATCH /admin/content/posts/{postId}", async () => {
    const p = await newPost();
    const ok = await call("PATCH", `/admin/content/posts/${p.id}`, {
      headers: ifMatch(p.version),
      body: { title: "Judul Baru" },
    });
    expect(ok.status).toBe(200);
    const stale = await call("PATCH", `/admin/content/posts/${p.id}`, {
      headers: ifMatch(p.version),
      body: { title: "Judul Lain" },
    });
    expect(stale.status).toBe(409);
  });

  route("DELETE /admin/content/posts/{postId}", async () => {
    const p = await newPost();
    expect(
      (await call("DELETE", `/admin/content/posts/${p.id}`, { headers: ifMatch(p.version) })).status,
    ).toBe(204);
  });

  route("POST /admin/content/posts/{postId}/publish", async () => {
    const p = await newPost();
    const now = await call<S["AdminPost"]>("POST", `/admin/content/posts/${p.id}/publish`, {
      headers: { ...ifMatch(p.version), ...idem() },
      body: {},
    });
    expect(now.status).toBe(200);
    const q = await newPost();
    const later = await call("POST", `/admin/content/posts/${q.id}/publish`, {
      headers: { ...ifMatch(q.version), ...idem() },
      body: { published_at: future(2) },
    });
    expect(later.status).toBe(200);
    const again = await call("POST", `/admin/content/posts/${p.id}/publish`, {
      headers: { ...ifMatch(now.body.version), ...idem() },
      body: {},
    });
    expect(again.status).toBe(409);
  });

  route("POST /admin/content/posts/{postId}/unschedule", async () => {
    const p = await newPost();
    const scheduled = await call<S["AdminPost"]>("POST", `/admin/content/posts/${p.id}/publish`, {
      headers: { ...ifMatch(p.version), ...idem() },
      body: { published_at: future(2) },
    });
    const ok = await call("POST", `/admin/content/posts/${p.id}/unschedule`, {
      headers: { ...ifMatch(scheduled.body.version), ...idem() },
      body: {},
    });
    expect(ok.status).toBe(200);
  });

  route("POST /admin/content/posts/{postId}/archive", async () => {
    const p = await newPost();
    const published = await call<S["AdminPost"]>("POST", `/admin/content/posts/${p.id}/publish`, {
      headers: { ...ifMatch(p.version), ...idem() },
      body: {},
    });
    const ok = await call("POST", `/admin/content/posts/${p.id}/archive`, {
      headers: { ...ifMatch(published.body.version), ...idem() },
      body: {},
    });
    expect(ok.status).toBe(200);
  });

  route("POST /admin/content/posts/{postId}/restore", async () => {
    const p = await newPost();
    const archived = await call<S["AdminPost"]>("POST", `/admin/content/posts/${p.id}/archive`, {
      headers: { ...ifMatch(p.version), ...idem() },
      body: {},
    });
    const ok = await call("POST", `/admin/content/posts/${p.id}/restore`, {
      headers: { ...ifMatch(archived.body.version), ...idem() },
      body: {},
    });
    expect(ok.status).toBe(200);
  });

  async function newBanner(): Promise<S["AdminBanner"]> {
    const image = await upload("banner_image");
    const res = await call<S["AdminBanner"]>("POST", "/admin/content/banners", {
      headers: idem(),
      body: {
        title: "Banner Uji",
        image_file_id: image.file_id,
        target_type: "url",
        target_value: "https://kapdh.or.id/info",
        starts_at: new Date().toISOString(),
        ends_at: future(10),
      },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  route("GET /admin/content/banners", async () => {
    expect((await call("GET", "/admin/content/banners", { query: { limit: "100" } })).status).toBe(200);
  });

  route("POST /admin/content/banners", async () => {
    await newBanner();
    const image = await upload("banner_image");
    for (const target of [
      { target_type: "none", target_value: null },
      { target_type: "post", target_value: CONTENT_IDS.postDonasi },
      { target_type: "event", target_value: MOCK_EVENT_IDS.reuni },
      { target_type: "page", target_value: "kebijakan-privasi" },
    ]) {
      const res = await call("POST", "/admin/content/banners", {
        headers: idem(),
        body: {
          title: "Banner",
          image_file_id: image.file_id,
          starts_at: new Date().toISOString(),
          ...target,
        },
      });
      expect([201, 400]).toContain(res.status);
    }
  });

  route("GET /admin/content/banners/{bannerId}", async () => {
    const list = await call<S["AdminBannerPage"]>("GET", "/admin/content/banners", {
      query: { limit: "100" },
    });
    for (const b of list.body.items)
      expect((await call("GET", `/admin/content/banners/${b.id}`)).status).toBe(200);
  });

  route("PATCH /admin/content/banners/{bannerId}", async () => {
    const b = await newBanner();
    const ok = await call("PATCH", `/admin/content/banners/${b.id}`, {
      headers: ifMatch(b.version),
      body: { title: "Banner Baru", active: false },
    });
    expect(ok.status).toBe(200);
  });

  route("DELETE /admin/content/banners/{bannerId}", async () => {
    const b = await newBanner();
    expect(
      (await call("DELETE", `/admin/content/banners/${b.id}`, { headers: ifMatch(b.version) })).status,
    ).toBe(204);
  });

  async function newPage(): Promise<S["AdminInfoPage"]> {
    const res = await call<S["AdminInfoPage"]>("POST", "/admin/content/pages", {
      headers: idem(),
      body: { slug: "halaman-uji-kontrak", title: "Halaman Uji", body_html: "<p>Isi halaman.</p>" },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  route("GET /admin/content/pages", async () => {
    expect((await call("GET", "/admin/content/pages", { query: { limit: "100" } })).status).toBe(200);
  });

  route("POST /admin/content/pages", async () => {
    await newPage();
  });

  route("GET /admin/content/pages/{pageId}", async () => {
    const list = await call<S["AdminInfoPageList"]>("GET", "/admin/content/pages", {
      query: { limit: "100" },
    });
    for (const p of list.body.items)
      expect((await call("GET", `/admin/content/pages/${p.id}`)).status).toBe(200);
  });

  route("PATCH /admin/content/pages/{pageId}", async () => {
    const p = await newPage();
    const ok = await call("PATCH", `/admin/content/pages/${p.id}`, {
      headers: ifMatch(p.version),
      body: { title: "Halaman Baru" },
    });
    expect(ok.status).toBe(200);
  });

  route("DELETE /admin/content/pages/{pageId}", async () => {
    const p = await newPage();
    expect(
      (await call("DELETE", `/admin/content/pages/${p.id}`, { headers: ifMatch(p.version) })).status,
    ).toBe(204);
    const system = await call<S["AdminInfoPage"]>("GET", `/admin/content/pages/${CONTENT_IDS.pagePrivasi}`);
    const refused = await call("DELETE", `/admin/content/pages/${CONTENT_IDS.pagePrivasi}`, {
      headers: ifMatch(system.body.version),
    });
    expect(refused.status).toBe(409);
  });

  route("POST /admin/content/pages/{pageId}/publish", async () => {
    const p = await newPage();
    const ok = await call("POST", `/admin/content/pages/${p.id}/publish`, {
      headers: { ...ifMatch(p.version), ...idem() },
      body: { change_note: "Terbit pertama" },
    });
    expect(ok.status).toBe(200);
  });

  async function newCategory(): Promise<S["AdminContentCategory"]> {
    const res = await call<S["AdminContentCategory"]>("POST", "/admin/content/post-categories", {
      headers: idem(),
      body: { label: "Kategori Uji Kontrak" },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  route("GET /admin/content/post-categories", async () => {
    expect((await call("GET", "/admin/content/post-categories", { query: { limit: "100" } })).status).toBe(
      200,
    );
  });

  route("POST /admin/content/post-categories", async () => {
    await newCategory();
  });

  route("GET /admin/content/post-categories/{categoryId}", async () => {
    const list = await call<S["AdminContentCategoryPage"]>("GET", "/admin/content/post-categories", {
      query: { limit: "100" },
    });
    for (const c of list.body.items)
      expect((await call("GET", `/admin/content/post-categories/${c.id}`)).status).toBe(200);
  });

  route("PATCH /admin/content/post-categories/{categoryId}", async () => {
    const c = await newCategory();
    const ok = await call("PATCH", `/admin/content/post-categories/${c.id}`, {
      headers: ifMatch(c.version),
      body: { label: "Kategori Baru", active: false },
    });
    expect(ok.status).toBe(200);
  });

  route("DELETE /admin/content/post-categories/{categoryId}", async () => {
    const c = await newCategory();
    const ok = await call("DELETE", `/admin/content/post-categories/${c.id}`, {
      headers: ifMatch(c.version),
    });
    expect(ok.status).toBe(204);
  });
});

describe("tiruan event dan check-in (admin-events, admin-content kategori event)", () => {
  async function newEventCategory(): Promise<S["AdminContentCategory"]> {
    const res = await call<S["AdminContentCategory"]>("POST", "/admin/content/event-categories", {
      headers: idem(),
      body: { label: "Kategori Event Uji" },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function newEvent(extra: JsonObject = {}): Promise<S["AdminEventDetail"]> {
    const res = await call<S["AdminEventDetail"]>("POST", "/admin/events", {
      headers: idem(),
      body: {
        title: "Event Uji Kontrak",
        starts_at: future(20),
        ends_at: future(20.2),
        registration_opens_at: new Date().toISOString(),
        registration_closes_at: future(19),
        price: "25000.00",
        seats_total: 50,
        location_name: "Aula",
        ...extra,
      },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  route("GET /admin/event-categories", async () => {
    expect((await call("GET", "/admin/event-categories")).status).toBe(200);
  });

  route("GET /admin/content/event-categories", async () => {
    expect((await call("GET", "/admin/content/event-categories", { query: { limit: "100" } })).status).toBe(
      200,
    );
  });

  route("POST /admin/content/event-categories", async () => {
    await newEventCategory();
  });

  route("PATCH /admin/content/event-categories/{categoryId}", async () => {
    const c = await newEventCategory();
    const ok = await call("PATCH", `/admin/content/event-categories/${c.id}`, {
      headers: ifMatch(c.version),
      body: { label: "Kategori Event Baru" },
    });
    expect(ok.status).toBe(200);
  });

  route("DELETE /admin/content/event-categories/{categoryId}", async () => {
    const c = await newEventCategory();
    const ok = await call("DELETE", `/admin/content/event-categories/${c.id}`, {
      headers: ifMatch(c.version),
    });
    expect(ok.status).toBe(204);
  });

  route("POST /admin/event-covers", async () => {
    const ok = await call("POST", "/admin/event-covers", {
      multipart: { fields: {}, file: { name: "cover.png", type: "image/png", bytes: pngBytes() } },
    });
    expect(ok.status).toBe(201);
  });

  route("GET /admin/events", async () => {
    expect((await call("GET", "/admin/events", { query: { limit: "100" } })).status).toBe(200);
  });

  route("POST /admin/events", async () => {
    const cover = await call<S["AdminEventCoverMedia"]>("POST", "/admin/event-covers", {
      multipart: { fields: {}, file: { name: "cover.png", type: "image/png", bytes: pngBytes() } },
    });
    await newEvent({ cover_file_id: cover.body.file_id, category_id: (await newEventCategory()).id });
    await newEvent({ price: "0.00", checkin_opens_at: future(19.9), checkin_closes_at: future(20.2) });
  });

  route("GET /admin/events/{eventId}", async () => {
    const list = await call<S["AdminEventPage"]>("GET", "/admin/events", { query: { limit: "100" } });
    for (const e of list.body.items) expect((await call("GET", `/admin/events/${e.id}`)).status).toBe(200);
  });

  route("PATCH /admin/events/{eventId}", async () => {
    const e = await newEvent();
    const ok = await call("PATCH", `/admin/events/${e.id}`, {
      headers: ifMatch(e.version),
      body: { title: "Event Uji Berganti Nama" },
    });
    expect(ok.status).toBe(200);
  });

  route("DELETE /admin/events/{eventId}", async () => {
    const e = await newEvent();
    expect((await call("DELETE", `/admin/events/${e.id}`, { headers: ifMatch(e.version) })).status).toBe(204);
  });

  route("POST /admin/events/{eventId}/status", async () => {
    const e = await newEvent();
    const opened = await call<S["AdminEventDetail"]>("POST", `/admin/events/${e.id}/status`, {
      headers: { ...ifMatch(e.version), ...idem() },
      body: { status: "open" },
    });
    expect(opened.status).toBe(200);
    const closed = await call("POST", `/admin/events/${e.id}/status`, {
      headers: { ...ifMatch(opened.body.version), ...idem() },
      body: { status: "closed" },
    });
    expect(closed.status).toBe(200);
  });

  route("POST /admin/events/{eventId}/cancel", async () => {
    const reuni = await call<S["AdminEventDetail"]>("GET", `/admin/events/${MOCK_EVENT_IDS.reuni}`);
    const ok = await call("POST", `/admin/events/${MOCK_EVENT_IDS.reuni}/cancel`, {
      headers: { ...ifMatch(reuni.body.version), ...idem() },
      body: { reason: "Uji pembatalan event" },
    });
    expect(ok.status).toBe(200);
  });

  route("GET /admin/events/{eventId}/stats", async () => {
    for (const id of Object.values(MOCK_EVENT_IDS))
      expect((await call("GET", `/admin/events/${id}/stats`)).status).toBe(200);
  });

  route("GET /admin/events/{eventId}/tickets", async () => {
    for (const id of Object.values(MOCK_EVENT_IDS))
      expect((await call("GET", `/admin/events/${id}/tickets`, { query: { limit: "100" } })).status).toBe(
        200,
      );
  });

  route("POST /admin/events/{eventId}/tickets/{ticketId}/cancel", async () => {
    const list = await call<S["AdminEventTicketPage"]>(
      "GET",
      `/admin/events/${MOCK_EVENT_IDS.reuni}/tickets`,
      {
        query: { limit: "100" },
      },
    );
    const awaiting = list.body.items.find((t) => t.status === "awaiting_payment")!;
    const ok = await call("POST", `/admin/events/${MOCK_EVENT_IDS.reuni}/tickets/${awaiting.id}/cancel`, {
      headers: { ...ifMatch(awaiting.version), ...idem() },
      body: { reason: "Uji batal tiket", refund: false },
    });
    expect(ok.status).toBe(200);
    const paid = list.body.items.find(
      (t) => t.status === "paid" && t.checked_in_at === null && t.holder.full_name,
    );
    if (paid) {
      const refund = await call("POST", `/admin/events/${MOCK_EVENT_IDS.reuni}/tickets/${paid.id}/cancel`, {
        headers: { ...ifMatch(paid.version), ...idem() },
        body: { reason: "Uji batal tiket dengan refund", refund: true },
      });
      expect([200, 403]).toContain(refund.status);
    }
  });

  route("GET /admin/checkin/events", async () => {
    expect((await call("GET", "/admin/checkin/events")).status).toBe(200);
  });

  route("POST /admin/checkin", async () => {
    const ok = await call("POST", "/admin/checkin", {
      headers: idem(),
      body: { event_id: MOCK_EVENT_IDS.reuni, qr_code: MOCK_TICKET_QR.paid },
    });
    expect(ok.status).toBe(200);
    const again = await call("POST", "/admin/checkin", {
      headers: idem(),
      body: { event_id: MOCK_EVENT_IDS.reuni, qr_code: MOCK_TICKET_QR.paid },
    });
    expect(again.status).toBe(409);
    const unknown = await call("POST", "/admin/checkin", {
      headers: idem(),
      body: { event_id: MOCK_EVENT_IDS.reuni, qr_code: "bukan-tiket" },
    });
    expect(unknown.status).toBe(404);
  });
});

describe("tiruan berkas (files)", () => {
  route("POST /files", async () => {
    const ok = await call("POST", "/files", {
      multipart: {
        fields: { purpose: "adjustment_evidence" },
        file: { name: "bukti.png", type: "image/png", bytes: pngBytes() },
      },
    });
    expect(ok.status).toBe(201);
  });

  route("GET /files/{fileId}/access", async () => {
    expect((await call("GET", `/files/${MOCK_PROOF_FILE_ID}/access`)).status).toBe(200);
    expect((await call("GET", "/files/0199e000-0000-7000-8000-00000000ffff/access")).status).toBe(404);
  });
});

describe("tiruan anggota dan master (admin-members, admin-masters)", () => {
  async function members(): Promise<S["AdminMemberSummary"][]> {
    return (await call<S["AdminMemberPage"]>("GET", "/admin/members", { query: { limit: "100" } })).body
      .items;
  }
  async function member(id: string): Promise<S["AdminMemberDetail"]> {
    return (await call<S["AdminMemberDetail"]>("GET", `/admin/members/${id}`)).body;
  }
  async function editable(): Promise<S["AdminMemberDetail"]> {
    for (const m of await members()) {
      const d = await member(m.user_id);
      if (d.account_status === "active" && !d.linked_admin && !d.suspension) return d;
    }
    throw new Error("tidak ada anggota yang dapat diubah");
  }

  route("GET /admin/members", async () => {
    expect((await call("GET", "/admin/members", { query: { limit: "100" } })).status).toBe(200);
    expect((await call("GET", "/admin/members", { query: { cohort: "0" } })).status).toBe(400);
  });

  route("GET /admin/members/{userId}", async () => {
    for (const m of await members())
      expect((await call("GET", `/admin/members/${m.user_id}`)).status).toBe(200);
    expect((await call("GET", "/admin/members/0199e000-0000-7000-8000-00000000ffff")).status).toBe(404);
  });

  route("PATCH /admin/members/{userId}", async () => {
    const d = await editable();
    const ok = await call("PATCH", `/admin/members/${d.user_id}`, {
      headers: ifMatch(d.version),
      body: { reason: "Koreksi data", city: "Bandung" },
    });
    expect(ok.status).toBe(200);
    const stale = await call("PATCH", `/admin/members/${d.user_id}`, {
      headers: ifMatch(d.version),
      body: { reason: "Koreksi data", city: "Bogor" },
    });
    expect(stale.status).toBe(409);
  });

  route("POST /admin/members/{userId}/suspend", async () => {
    const d = await editable();
    const ok = await call("POST", `/admin/members/${d.user_id}/suspend`, {
      headers: { ...ifMatch(d.version), ...idem() },
      body: { reason: "Pelanggaran berat", member_message: "Akun dibatasi.", confirm: true },
    });
    expect(ok.status).toBe(200);
  });

  route("POST /admin/members/{userId}/unsuspend", async () => {
    const d = await editable();
    const suspended = await call<S["AdminMemberDetail"]>("POST", `/admin/members/${d.user_id}/suspend`, {
      headers: { ...ifMatch(d.version), ...idem() },
      body: { reason: "Pelanggaran berat", member_message: "Akun dibatasi.", confirm: true },
    });
    const ok = await call("POST", `/admin/members/${d.user_id}/unsuspend`, {
      headers: { ...ifMatch(suspended.body.version), ...idem() },
      body: { reason: "Banding diterima", confirm: true },
    });
    expect(ok.status).toBe(200);
    const again = await call("POST", `/admin/members/${d.user_id}/unsuspend`, {
      headers: { ...ifMatch(suspended.body.version + 1), ...idem() },
      body: { reason: "Banding diterima", confirm: true },
    });
    expect([400, 409]).toContain(again.status);
  });

  route("POST /admin/members/{userId}/password-reset", async () => {
    const d = await editable();
    const ok = await call("POST", `/admin/members/${d.user_id}/password-reset`, {
      headers: { ...(await reauth()), ...idem() },
      body: { reason: "Permintaan anggota", confirm: true },
    });
    expect(ok.status).toBe(202);
  });

  route("GET /admin/members/{userId}/membership-events", async () => {
    for (const m of await members())
      expect(
        (await call("GET", `/admin/members/${m.user_id}/membership-events`, { query: { limit: "100" } }))
          .status,
      ).toBe(200);
  });

  async function newMaster(): Promise<S["AdminMasterItem"]> {
    const res = await call<S["AdminMasterItem"]>("POST", "/admin/masters/skills", {
      body: { label: "Keahlian Uji Kontrak" },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  route("GET /admin/masters/{kind}", async () => {
    for (const kind of ["professions", "skills"])
      expect((await call("GET", `/admin/masters/${kind}`, { query: { limit: "100" } })).status).toBe(200);
  });

  route("POST /admin/masters/{kind}", async () => {
    await newMaster();
    const dup = await call("POST", "/admin/masters/skills", { body: { label: "Keahlian Uji Kontrak" } });
    expect(dup.status).toBe(409);
  });

  route("GET /admin/masters/{kind}/{masterId}", async () => {
    for (const kind of ["professions", "skills"]) {
      const list = await call<S["AdminMasterPage"]>("GET", `/admin/masters/${kind}`, {
        query: { limit: "100" },
      });
      for (const m of list.body.items)
        expect((await call("GET", `/admin/masters/${kind}/${m.id}`)).status).toBe(200);
    }
  });

  route("PATCH /admin/masters/{kind}/{masterId}", async () => {
    const m = await newMaster();
    const ok = await call("PATCH", `/admin/masters/skills/${m.id}`, {
      headers: ifMatch(m.version),
      body: { label: "Keahlian Baru", active: false },
    });
    expect(ok.status).toBe(200);
  });

  route("DELETE /admin/masters/{kind}/{masterId}", async () => {
    const m = await newMaster();
    expect(
      (await call("DELETE", `/admin/masters/skills/${m.id}`, { headers: ifMatch(m.version) })).status,
    ).toBe(204);
  });
});

describe("tiruan moderasi (admin-moderation)", () => {
  async function report(id: string): Promise<S["AdminModerationReportDetail"]> {
    return (await call<S["AdminModerationReportDetail"]>("GET", `/admin/reports/${id}`)).body;
  }

  route("GET /admin/reports", async () => {
    for (const status of ["active", "all"])
      expect((await call("GET", "/admin/reports", { query: { status, limit: "100" } })).status).toBe(200);
  });

  route("GET /admin/reports/{reportId}", async () => {
    const list = await call<S["AdminModerationReportPage"]>("GET", "/admin/reports", {
      query: { status: "all", limit: "100" },
    });
    for (const r of list.body.items) expect((await call("GET", `/admin/reports/${r.id}`)).status).toBe(200);
    expect((await call("GET", `/admin/reports/${MOCK_REPORT_IDS.againstSelf}`)).status).toBe(404);
  });

  route("POST /admin/reports/{reportId}/claim", async () => {
    const r = await report(MOCK_REPORT_IDS.threat);
    const ok = await call("POST", `/admin/reports/${r.id}/claim`, {
      headers: { ...ifMatch(r.version), ...idem() },
      body: {},
    });
    expect(ok.status).toBe(200);
    const stale = await call("POST", `/admin/reports/${r.id}/claim`, {
      headers: { ...ifMatch(r.version), ...idem() },
      body: {},
    });
    expect(stale.status).toBe(409);
  });

  route("POST /admin/reports/{reportId}/resolve", async () => {
    const r = await report(MOCK_REPORT_IDS.harassment);
    const ok = await call("POST", `/admin/reports/${r.id}/resolve`, {
      headers: { ...ifMatch(r.version), ...idem() },
      body: { action: "warn", note: "Peringatan pertama", member_message: "Jaga sikap di grup." },
    });
    expect(ok.status).toBe(200);
    const t = await report(MOCK_REPORT_IDS.threat);
    const suspend = await call("POST", `/admin/reports/${t.id}/resolve`, {
      headers: { ...ifMatch(t.version), ...idem() },
      body: { action: "suspend", note: "Ancaman", member_message: "Akun dibatasi.", confirm: true },
    });
    expect(suspend.status).toBe(200);
    // Banding: hanya abaikan atau cabut suspend; pesan untuk anggota wajib.
    for (const id of [MOCK_REPORT_IDS.appeal, MOCK_REPORT_IDS.staleAppeal]) {
      const a = await report(id);
      const res = await call("POST", `/admin/reports/${id}/resolve`, {
        headers: { ...ifMatch(a.version), ...idem() },
        body: {
          action: "unsuspend",
          note: "Banding dikabulkan",
          member_message: "Akses dipulihkan.",
          confirm: true,
        },
      });
      expect(res.status).toBe(200);
    }
    // Laporan grup: subjek dipilih dari calon subjek.
    const g = await report(MOCK_REPORT_IDS.groupSpam);
    const candidates = await call<S["AdminModerationSubjectCandidatePage"]>(
      "GET",
      `/admin/reports/${g.id}/subject-candidates`,
    );
    const subject = candidates.body.items[0]!;
    const group = await call("POST", `/admin/reports/${g.id}/resolve`, {
      headers: { ...ifMatch(g.version), ...idem() },
      body: {
        action: "warn",
        note: "Spam di grup",
        member_message: "Jangan mengirim spam.",
        subject_user_id: subject.user_id,
      },
    });
    expect(group.status).toBe(200);
  });

  route("GET /admin/reports/{reportId}/subject-candidates", async () => {
    const ok = await call("GET", `/admin/reports/${MOCK_REPORT_IDS.groupSpam}/subject-candidates`);
    expect(ok.status).toBe(200);
    const bad = await call("GET", `/admin/reports/${MOCK_REPORT_IDS.threat}/subject-candidates`);
    expect(bad.status).toBe(400);
  });
});

describe("tiruan pengiriman notifikasi (admin-notifications)", () => {
  route("GET /admin/notifications/deliveries", async () => {
    expect((await call("GET", "/admin/notifications/deliveries", { query: { limit: "100" } })).status).toBe(
      200,
    );
  });

  route("POST /admin/notifications/deliveries/retry", async () => {
    const ok = await call("POST", "/admin/notifications/deliveries/retry", {
      headers: idem(),
      body: { delivery_ids: Object.values(MOCK_DELIVERY_IDS) },
    });
    expect(ok.status).toBe(200);
  });

  route("GET /admin/notifications/outbox", async () => {
    expect((await call("GET", "/admin/notifications/outbox", { query: { limit: "100" } })).status).toBe(200);
    for (const status of ["pending", "dispatched", "failed", "dead"])
      expect((await call("GET", "/admin/notifications/outbox", { query: { status } })).status).toBe(200);
  });

  route("POST /admin/notifications/outbox/retry", async () => {
    const ok = await call("POST", "/admin/notifications/outbox/retry", {
      headers: idem(),
      body: { event_ids: Object.values(MOCK_OUTBOX_IDS) },
    });
    expect(ok.status).toBe(200);
  });
});

describe("tiruan pembayaran (admin-payments, admin-settings biaya)", () => {
  async function payments(query: Record<string, string> = {}): Promise<S["AdminPaymentPage"]["items"]> {
    const res = await call<S["AdminPaymentPage"]>("GET", "/admin/payments", {
      query: { limit: "100", ...query },
    });
    return res.body.items;
  }
  async function payment(id: string): Promise<S["AdminPaymentDetail"]> {
    return (await call<S["AdminPaymentDetail"]>("GET", `/admin/payments/${id}`)).body;
  }

  route("GET /admin/payments", async () => {
    expect((await call("GET", "/admin/payments", { query: { limit: "100" } })).status).toBe(200);
    for (const status of ["pending", "paid", "rejected", "cancelled"])
      expect((await call("GET", "/admin/payments", { query: { status } })).status).toBe(200);
    expect((await call("GET", "/admin/payments", { query: { sort: "acak" } })).status).toBe(400);
  });

  route("GET /admin/payments/summary", async () => {
    expect((await call("GET", "/admin/payments/summary")).status).toBe(200);
  });

  route("GET /admin/payments/{paymentId}", async () => {
    for (const p of await payments()) expect((await call("GET", `/admin/payments/${p.id}`)).status).toBe(200);
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    for (const p of await payments()) expect((await call("GET", `/admin/payments/${p.id}`)).status).toBe(200);
  });

  route("POST /admin/payments/{paymentId}/decision", async () => {
    const review = await payments({ stage: "awaiting_review" });
    for (const [i, s] of review.entries()) {
      const p = await payment(s.id);
      if (p.conflict_of_interest) continue;
      const approve = i % 2 === 0;
      const res = await call("POST", `/admin/payments/${p.id}/decision`, {
        headers: idem(),
        body: approve
          ? {
              decision: "approve",
              expected_proof_version: p.proof_version,
              expected_version: p.version,
              funds_verified: true,
            }
          : {
              decision: "reject",
              expected_proof_version: p.proof_version,
              expected_version: p.version,
              reason: "Nominal tidak sesuai",
            },
      });
      expect(res.status).toBe(200);
      const again = await call("POST", `/admin/payments/${p.id}/decision`, {
        headers: idem(),
        body: {
          decision: "approve",
          expected_proof_version: p.proof_version,
          expected_version: p.version,
          funds_verified: true,
        },
      });
      expect(again.status).toBe(409);
    }
  });

  route("POST /admin/payments/{paymentId}/cancel", async () => {
    const waiting = await payments({ stage: "awaiting_transfer" });
    expect(waiting.length).toBeGreaterThan(0);
    for (const s of waiting) {
      const p = await payment(s.id);
      const res = await call("POST", `/admin/payments/${p.id}/cancel`, {
        headers: { ...ifMatch(p.version), ...idem() },
        body: { reason: "Instruksi ganda" },
      });
      expect([200, 403]).toContain(res.status);
    }
  });

  async function newAdjustment(kind: "refund" | "correction"): Promise<S["AdminPaymentAdjustment"]> {
    for (const s of await payments({ status: "paid" })) {
      const p = await payment(s.id);
      if (p.conflict_of_interest) continue;
      const res = await call<S["AdminPaymentAdjustment"]>("POST", `/admin/payments/${p.id}/adjustments`, {
        headers: idem(),
        body:
          kind === "refund"
            ? {
                kind,
                amount: "1000.00",
                reason: "Refund sebagian",
                refund_destination: {
                  provider: "Bank Uji",
                  account_number: "1234567890",
                  account_holder: "Pemilik",
                },
              }
            : { kind, amount: "0.00", reason: "Koreksi pencatatan" },
      });
      if (res.status === 201) return res.body;
    }
    throw new Error("tidak ada payment paid untuk penyesuaian");
  }

  route("POST /admin/payments/{paymentId}/adjustments", async () => {
    await newAdjustment("refund");
    await newAdjustment("correction");
  });

  route("GET /admin/payment-adjustments", async () => {
    await newAdjustment("refund");
    expect((await call("GET", "/admin/payment-adjustments", { query: { limit: "100" } })).status).toBe(200);
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    expect((await call("GET", "/admin/payment-adjustments", { query: { limit: "100" } })).status).toBe(200);
  });

  route("GET /admin/payment-adjustments/{adjustmentId}", async () => {
    await newAdjustment("refund");
    const list = await call<S["AdminPaymentAdjustmentPage"]>("GET", "/admin/payment-adjustments", {
      query: { limit: "100" },
    });
    for (const a of list.body.items)
      expect((await call("GET", `/admin/payment-adjustments/${a.id}`)).status).toBe(200);
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    for (const a of list.body.items)
      expect((await call("GET", `/admin/payment-adjustments/${a.id}`)).status).toBe(200);
  });

  route("PATCH /admin/payment-adjustments/{adjustmentId}", async () => {
    const a = await newAdjustment("refund");
    const ok = await call("PATCH", `/admin/payment-adjustments/${a.id}`, {
      headers: ifMatch(a.version),
      body: { reason: "Refund sebagian (diperbarui)", evidence_file_id: MOCK_PROOF_FILE_ID },
    });
    expect(ok.status).toBe(200);
  });

  route("POST /admin/payment-adjustments/{adjustmentId}/complete", async () => {
    const a = await newAdjustment("correction");
    const ok = await call("POST", `/admin/payment-adjustments/${a.id}/complete`, {
      headers: { ...ifMatch(a.version), ...idem() },
      body: {},
    });
    expect(ok.status).toBe(200);
    const again = await call("POST", `/admin/payment-adjustments/${a.id}/complete`, {
      headers: { ...ifMatch(a.version), ...idem() },
      body: {},
    });
    expect(again.status).toBe(409);
  });

  route("POST /admin/payment-adjustments/{adjustmentId}/cancel", async () => {
    const a = await newAdjustment("refund");
    const ok = await call("POST", `/admin/payment-adjustments/${a.id}/cancel`, {
      headers: { ...ifMatch(a.version), ...idem() },
      body: { reason: "Dicatat ganda" },
    });
    expect(ok.status).toBe(200);
  });

  async function newMethod(): Promise<S["AdminPaymentMethod"]> {
    const res = await call<S["AdminPaymentMethod"]>("POST", "/admin/payment-methods", {
      headers: { ...(await reauth()), ...idem() },
      body: {
        kind: "bank",
        provider: "Bank Uji",
        account_number: "9876543210",
        account_holder: "KAPDH",
        instructions: null,
        active: true,
        sort_order: 9,
      },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  route("GET /admin/payment-methods", async () => {
    expect((await call("GET", "/admin/payment-methods", { query: { limit: "100" } })).status).toBe(200);
  });

  route("POST /admin/payment-methods", async () => {
    await newMethod();
  });

  route("GET /admin/payment-methods/{methodId}", async () => {
    const list = await call<S["AdminPaymentMethodPage"]>("GET", "/admin/payment-methods", {
      query: { limit: "100" },
    });
    for (const m of list.body.items)
      expect((await call("GET", `/admin/payment-methods/${m.id}`)).status).toBe(200);
  });

  route("PUT /admin/payment-methods/{methodId}", async () => {
    const m = await newMethod();
    const ok = await call("PUT", `/admin/payment-methods/${m.id}`, {
      headers: { ...(await reauth()), ...ifMatch(m.version) },
      body: {
        kind: "ewallet",
        provider: "Dompet Uji",
        account_number: "081234567890",
        account_holder: "KAPDH",
        instructions: "Transfer sesuai nominal.",
        active: false,
        sort_order: 3,
      },
    });
    expect(ok.status).toBe(200);
  });

  route("DELETE /admin/payment-methods/{methodId}", async () => {
    const m = await newMethod();
    const ok = await call("DELETE", `/admin/payment-methods/${m.id}`, {
      headers: { ...(await reauth()), ...ifMatch(m.version) },
    });
    expect(ok.status).toBe(204);
  });

  route("GET /admin/settings/fees", async () => {
    expect((await call("GET", "/admin/settings/fees")).status).toBe(200);
  });

  route("PUT /admin/settings/fees", async () => {
    const fees = await call<S["FeeSettings"]>("GET", "/admin/settings/fees");
    const ok = await call("PUT", "/admin/settings/fees", {
      headers: { ...(await reauth()), ...ifMatch(fees.body.version) },
      body: { registration_fee: "55000.00", card_fee: "10000.00", renewal_fee: "15000.00", reason: "Rapat" },
    });
    expect(ok.status).toBe(200);
  });
});

describe("tiruan pengaturan aplikasi (admin-settings)", () => {
  async function settings(): Promise<S["AdminAppSettings"]> {
    return (await call<S["AdminAppSettings"]>("GET", "/admin/settings")).body;
  }

  route("GET /admin/settings", async () => {
    expect((await call("GET", "/admin/settings")).status).toBe(200);
  });

  route("PUT /admin/settings/min-app-version", async () => {
    const s = await settings();
    const ok = await call("PUT", "/admin/settings/min-app-version", {
      headers: { ...(await reauth()), ...ifMatch(s.min_app_version.version) },
      body: { android: s.min_app_version.android, ios: s.min_app_version.ios },
    });
    expect(ok.status).toBe(200);
  });

  route("PUT /admin/settings/maintenance", async () => {
    const s = await settings();
    const ok = await call("PUT", "/admin/settings/maintenance", {
      headers: { ...(await reauth()), ...ifMatch(s.maintenance.version) },
      body: { active: true, message: "Pemeliharaan terjadwal.", until: future(1) },
    });
    expect(ok.status).toBe(200);
  });

  route("PUT /admin/settings/store-links", async () => {
    const s = await settings();
    const ok = await call("PUT", "/admin/settings/store-links", {
      headers: { ...(await reauth()), ...ifMatch(s.store_links.version) },
      body: { android: "https://play.google.com/store/apps/details?id=id.or.kapdh", ios: null },
    });
    expect(ok.status).toBe(200);
  });

  route("PUT /admin/settings/support", async () => {
    const s = await settings();
    const ok = await call("PUT", "/admin/settings/support", {
      headers: { ...(await reauth()), ...ifMatch(s.support.version) },
      body: { email: "bantuan@kapdh.or.id", whatsapp: "+6281234567890" },
    });
    expect(ok.status).toBe(200);
  });

  route("PUT /admin/settings/payment-instructions", async () => {
    const s = await settings();
    const ok = await call("PUT", "/admin/settings/payment-instructions", {
      headers: { ...(await reauth()), ...ifMatch(s.payment_instructions.version) },
      body: { dues_hidden_platforms: ["ios"] },
    });
    expect(ok.status).toBe(200);
  });
});

describe("tiruan dasbor (admin-dashboard)", () => {
  route("GET /admin/dashboard", async () => {
    expect((await call("GET", "/admin/dashboard")).status).toBe(200);
    mockAuth.setAdmin({ role: "admin", permissions: ["events.checkin"] });
    expect((await call("GET", "/admin/dashboard")).status).toBe(200);
  });

  route("GET /admin/dashboard/badges", async () => {
    expect((await call("GET", "/admin/dashboard/badges")).status).toBe(200);
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    expect((await call("GET", "/admin/dashboard/badges")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Sapuan galat dan cakupan
// ---------------------------------------------------------------------------------------------------------------

describe("validator kontrak uji ini", () => {
  it("menolak body yang tidak sesuai, status 2xx yang tidak dideklarasikan, dan body pada respons tanpa content", () => {
    const json = "application/json";
    expect(contractViolations("GET", "/admin/me", 200, json, "{}").length).toBeGreaterThan(0);
    expect(
      contractViolations(
        "GET",
        "/admin/payments/summary",
        200,
        json,
        JSON.stringify({ awaiting_review_count: "1" }),
      ).length,
    ).toBeGreaterThan(0);
    expect(contractViolations("GET", "/admin/me", 201, json, "{}")).toEqual([
      "GET /admin/me -> 201: status 2xx tidak dideklarasikan di kontrak",
    ]);
    expect(contractViolations("POST", "/auth/logout", 204, json, "{}").length).toBeGreaterThan(0);
    expect(
      contractViolations(
        "GET",
        "/admin/me",
        401,
        json,
        JSON.stringify({ code: "BUKAN_KODE", message: "x", request_id: "r" }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      contractViolations(
        "GET",
        "/admin/me",
        401,
        json,
        JSON.stringify({ code: "UNAUTHENTICATED", message: "x", request_id: "r" }),
      ),
    ).toEqual([]);
    // Field karangan pada objek berstruktur dilaporkan walau skemanya tidak menutup additionalProperties.
    expect(
      contractViolations(
        "GET",
        "/admin/me",
        401,
        json,
        JSON.stringify({ code: "UNAUTHENTICATED", message: "x", request_id: "r", karangan: 1 }),
      ),
    ).toEqual(["GET /admin/me -> 401: /karangan tidak dideklarasikan di kontrak"]);
    // `current` adalah objek bebas (bentuk mengikuti operasi) sehingga isinya tidak diperiksa.
    expect(
      contractViolations(
        "GET",
        "/admin/me",
        409,
        json,
        JSON.stringify({ code: "VERSION_CONFLICT", message: "x", request_id: "r", current: { apa: "saja" } }),
      ),
    ).toEqual([]);
  });

  it("memeriksa field karangan di objek bersarang respons tiruan sungguhan", async () => {
    const list = await call<S["AdminPaymentPage"]>("GET", "/admin/payments", { query: { limit: "1" } });
    const detail = await call<JsonObject>("GET", `/admin/payments/${list.body.items[0]!.id}`);
    const json = "application/json";
    const template = "/admin/payments/{paymentId}";
    expect(contractViolations("GET", template, 200, json, JSON.stringify(detail.body))).toEqual([]);
    const tampered = {
      ...detail.body,
      lines: (detail.body.lines as JsonObject[]).map((l) => ({ ...l, pajak: "0.00" })),
    };
    expect(contractViolations("GET", template, 200, json, JSON.stringify(tampered))).toContain(
      `GET ${template} -> 200: /lines/0/pajak tidak dideklarasikan di kontrak`,
    );
  });
});

describe("tiruan admin: galat dan cakupan", () => {
  /** Path contoh untuk template: parameter diganti UUID yang tidak ada (galat 401/404/400 harus tetap `Error`). */
  const sample = (template: string) =>
    template.replace(/\{kind\}/g, "skills").replace(/\{\w+\}/g, "0199e000-0000-7000-8000-00000000fffe");

  it("setiap rute tiruan menjawab tanpa token dengan body galat sesuai kontrak", async () => {
    const problems: string[] = [];
    for (const { route: r } of mockRouteTable) {
      await call(r.method, sample(r.path), { token: null, body: r.method === "GET" ? undefined : {} });
      const key = `${r.method} ${r.path}`;
      problems.push(...(current.get(key) ?? []));
      current.delete(key);
    }
    expect(problems).toEqual([]);
  });

  it("setiap rute tiruan menjawab id yang tidak ada dengan body galat sesuai kontrak", async () => {
    const problems: string[] = [];
    for (const { route: r } of mockRouteTable) {
      if (!r.path.includes("{")) continue;
      await call(r.method, sample(r.path), {
        body: r.method === "GET" || r.method === "DELETE" ? undefined : {},
        headers: { ...ifMatch(1), ...idem() },
      });
      const key = `${r.method} ${r.path}`;
      problems.push(...(current.get(key) ?? []));
      current.delete(key);
    }
    expect(problems).toEqual([]);
  });

  interface Access {
    audience?: string;
    permissions?: Permission[];
    permissions_any?: Permission[];
    role?: string;
    reauth?: boolean;
  }
  const accessOf = (method: string, template: string): Access =>
    ((spec.paths[template]?.[method.toLowerCase()] as JsonObject | undefined)?.["x-kapdh-access"] ??
      {}) as Access;

  it("tiruan menegakkan izin dan peran x-kapdh-access kontrak (PRD 2.3, AC F15-1)", async () => {
    const problems: string[] = [];
    for (const { route: r } of mockRouteTable) {
      const access = accessOf(r.method, r.path);
      if (access.audience !== "admin") continue;
      const gated = Boolean(access.permissions?.length || access.permissions_any?.length || access.role);
      const body = r.method === "GET" || r.method === "DELETE" ? undefined : {};
      const headers = { ...ifMatch(1), ...idem(), ...(access.reauth ? await reauth() : {}) };
      // Admin tanpa izin apa pun: operasi berizin wajib 403 FORBIDDEN.
      mockAuth.setAdmin({ role: "admin", permissions: [] });
      const none = await call<S["Error"]>(r.method, sample(r.path), { body, headers });
      if (gated && !(none.status === 403 && none.body.code === "FORBIDDEN"))
        problems.push(`${r.method} ${r.path}: tanpa izin dijawab ${none.status} ${none.body?.code ?? ""}`);
      if (!gated && none.status === 403 && none.body.code === "FORBIDDEN")
        problems.push(`${r.method} ${r.path}: kontrak tanpa izin khusus, tiruan menolak 403 FORBIDDEN`);
      // Admin dengan tepat izin kontrak (permissions_any: satu saja): tidak boleh 403 FORBIDDEN.
      if (gated && !access.role) {
        const exact = access.permissions?.length ? access.permissions : access.permissions_any!.slice(0, 1);
        mockAuth.setAdmin({ role: "admin", permissions: [...exact] });
        const ok = await call<S["Error"]>(r.method, sample(r.path), { body, headers });
        if (ok.status === 403 && ok.body.code === "FORBIDDEN")
          problems.push(
            `${r.method} ${r.path}: dengan izin kontrak [${exact.join(",")}] tetap 403 FORBIDDEN`,
          );
      }
      if (access.role === "super_admin") {
        mockAuth.setAdmin({ role: "admin", permissions: [...PERMISSION_VALUES] });
        const admin = await call<S["Error"]>(r.method, sample(r.path), { body, headers });
        if (!(admin.status === 403 && admin.body.code === "FORBIDDEN"))
          problems.push(
            `${r.method} ${r.path}: admin berizin lengkap (bukan Super Admin) dijawab ${admin.status}`,
          );
      }
      mockAuth.setAdmin({ role: "super_admin", permissions: [] });
      current.delete(`${r.method} ${r.path}`);
    }
    expect(problems).toEqual([]);
  });

  it("tiruan meminta X-Reauth-Token tepat pada operasi kontrak ber-reauth (AC F15-3, F16-1)", async () => {
    const problems: string[] = [];
    for (const { route: r } of mockRouteTable) {
      const access = accessOf(r.method, r.path);
      if (access.audience !== "admin") continue;
      const body = r.method === "GET" || r.method === "DELETE" ? undefined : {};
      const res = await call<S["Error"]>(r.method, sample(r.path), {
        body,
        headers: { ...ifMatch(1), ...idem() },
      });
      const askedReauth = res.status === 403 && res.body?.code === "REAUTH_REQUIRED";
      if (access.reauth && !askedReauth)
        problems.push(`${r.method} ${r.path}: kontrak reauth, tiruan tanpa token menjawab ${res.status}`);
      if (!access.reauth && askedReauth)
        problems.push(`${r.method} ${r.path}: kontrak tanpa reauth, tiruan meminta reautentikasi`);
      current.delete(`${r.method} ${r.path}`);
    }
    expect(problems).toEqual([]);
  });

  afterAll(() => {
    // Ringkasan untuk laporan audit: semua pelanggaran yang teramati di berkas ini.
    const lines = [...allViolations.entries()].flatMap(([k, v]) => [...v].map((x) => `${k} :: ${x}`));
    if (lines.length > 0) console.info(`Pelanggaran kontrak tiruan admin:\n${lines.join("\n")}`);
  });

  it("setiap operasi kontrak web admin memiliki rute tiruan, kecuali yang tercatat di KNOWN_WITHOUT_MOCK", () => {
    const mocked = new Set(mockRouteTable.map(({ route: r }) => `${r.method} ${r.path}`));
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths))
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const op = item[method] as JsonObject | undefined;
        if (!op) continue;
        const access = (op["x-kapdh-access"] ?? {}) as { audience?: string };
        if (access.audience !== "admin" && !path.startsWith("/admin/")) continue;
        const key = `${method.toUpperCase()} ${path}`;
        if (!mocked.has(key)) missing.push(key);
      }
    expect(missing.sort()).toEqual(Object.keys(KNOWN_WITHOUT_MOCK).sort());
  });

  it("setiap rute tiruan dipanggil skenario representatif dan pelanggaran hanya pada rute yang tercatat", () => {
    const missing = mockRouteTable
      .map(({ route: r }) => `${r.method} ${r.path}`)
      .filter((key) => !exercised.has(key));
    expect(missing).toEqual([]);
    const unexpected = [...allViolations.keys()].filter((key) => !KNOWN_NONCONFORMING[key]);
    expect(unexpected).toEqual([]);
  });
});
