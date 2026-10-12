// Uji penggabung kontrak (ARCHITECTURE §6): sumber nyata lolos, dan setiap pelanggaran kepemilikan/duplikat gagal.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSources } from "../assemble.mjs";
import { assemble, normalizePathTemplate } from "../lib/assemble.mjs";
import { PATHS } from "../lib/fs.mjs";

const ARCH_DOMAINS = [
  "auth",
  "admin-auth",
  "account",
  "me",
  "public",
  "admin-members",
  "admin-masters",
  "payments",
  "admin-payments",
  "files",
  "admin-settings",
  "content",
  "admin-content",
  "events",
  "admin-events",
  "network",
  "chat",
  "moderation",
  "admin-moderation",
  "notifications",
  "admin-notifications",
  "admin-dashboard",
  "admin-admins",
  "admin-audit",
];

const root = () => ({
  openapi: "3.1.0",
  info: { title: "uji", version: "0.0.0" },
  security: [{ bearerAuth: [] }],
  paths: {},
  components: { schemas: { Error: { type: "object" } }, responses: {} },
});
const op = (operationId, tag, extra = {}) => ({
  tags: [tag],
  operationId,
  responses: {
    default: {
      description: "galat",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
  },
  ...extra,
});
const domain = (tag, paths = {}, components = undefined) => ({
  tags: [{ name: tag, description: `Uji (F-01).` }],
  paths,
  ...(components ? { components } : {}),
});

describe("assemble: sumber kontrak nyata", () => {
  const sources = loadSources(PATHS.openapiDir);
  const { doc, errors } = assemble(sources);

  it("lolos tanpa galat", () => assert.deepEqual(errors, []));

  it("memiliki tepat 24 berkas domain ARCHITECTURE §6, masing-masing dengan tag", () => {
    assert.deepEqual(
      sources.domains.map((d) => d.file.replace(/^domains\/|\.yaml$/g, "")).sort(),
      [...ARCH_DOMAINS].sort(),
    );
    assert.equal(doc.tags.length, 24);
  });

  it("katalog bersama root sesuai ARCHITECTURE §4.4/§4.5", () => {
    assert.equal(doc.components.schemas.ErrorCode.enum.length, 21);
    assert.equal(doc.components.schemas.Permission.enum.length, 15);
    for (const name of ["Money", "Password", "Gender", "EffectiveStatus", "AccountStatus"])
      assert.ok(doc.components.schemas[name], name);
    for (const name of [
      "Cursor",
      "Limit",
      "IfMatch",
      "IdempotencyKey",
      "ReauthToken",
      "AppVersion",
      "AppPlatform",
    ])
      assert.ok(doc.components.parameters[name], name);
    for (const name of [
      "ReauthRequired",
      "MembershipRequired",
      "AccountSuspended",
      "Maintenance",
      "UpgradeRequired",
      "NotFound",
    ])
      assert.ok(doc.components.responses[name], name);
    assert.equal(doc.components.securitySchemes.adminRefreshCookie.name, "kapdh_admin_rt");
  });

  it("/health ada di kontrak publik tanpa autentikasi", () => {
    assert.deepEqual(doc.paths["/health"].get.security, []);
  });

  it("keluaran deterministik", () => {
    assert.deepEqual(assemble(loadSources(PATHS.openapiDir)).doc, doc);
  });
});

describe("assemble: pelanggaran terdeteksi", () => {
  const errorsOf = (domains, r = root()) => assemble({ root: r, domains }).errors.join("\n");

  it("path ganda antar domain", () => {
    const e = errorsOf([
      { file: "domains/a.yaml", doc: domain("A", { "/x": { get: op("getX", "A") } }) },
      { file: "domains/b.yaml", doc: domain("B", { "/x": { post: op("postX", "B") } }) },
    ]);
    assert.match(e, /path \/x sudah didefinisikan di domains\/a\.yaml/);
  });

  it("path identik yang hanya beda nama parameter", () => {
    assert.equal(normalizePathTemplate("/posts/{slug}/like"), "/posts/{}/like");
    const e = errorsOf([
      { file: "domains/a.yaml", doc: domain("A", { "/p/{id}": { get: op("getP", "A") } }) },
      { file: "domains/b.yaml", doc: domain("B", { "/p/{slug}": { get: op("getQ", "B") } }) },
    ]);
    assert.match(e, /identik dengan \/p\/\{id\}/);
  });

  it("operationId ganda", () => {
    const e = errorsOf([
      { file: "domains/a.yaml", doc: domain("A", { "/x": { get: op("getX", "A") } }) },
      { file: "domains/b.yaml", doc: domain("B", { "/y": { get: op("getX", "B") } }) },
    ]);
    assert.match(e, /operationId getX juga dipakai/);
  });

  it("tag ganda dan tag milik domain lain", () => {
    const e = errorsOf([
      { file: "domains/a.yaml", doc: domain("A", { "/x": { get: op("getX", "B") } }) },
      { file: "domains/b.yaml", doc: domain("B") },
      { file: "domains/c.yaml", doc: domain("A") },
    ]);
    assert.match(e, /tag 'A' duplikat/);
    assert.match(e, /memakai tag 'B' yang bukan milik domains\/a\.yaml/);
  });

  it("komponen ganda, termasuk menimpa komponen root", () => {
    const e = errorsOf([
      {
        file: "domains/a.yaml",
        doc: domain("A", {}, { schemas: { Error: { type: "string" }, X: { type: "string" } } }),
      },
      { file: "domains/b.yaml", doc: domain("B", {}, { schemas: { X: { type: "string" } } }) },
    ]);
    assert.match(e, /components\.schemas\.Error duplikat \(sudah di root\.yaml\)/);
    assert.match(e, /components\.schemas\.X duplikat \(sudah di domains\/a\.yaml\)/);
  });

  it("$ref yang tidak ada, $ref eksternal, kunci tak dikenal, path di root, tag tanpa rujukan PRD", () => {
    const r = root();
    r.paths = { "/root": { get: op("getRoot", "A") } };
    const e = errorsOf(
      [
        {
          file: "domains/a.yaml",
          doc: {
            ...domain("A", {
              "/x": {
                get: op("getX", "A", {
                  responses: {
                    200: {
                      description: "ok",
                      content: { "application/json": { schema: { $ref: "#/components/schemas/Hilang" } } },
                    },
                    201: {
                      description: "ok",
                      content: { "application/json": { schema: { $ref: "./lain.yaml#/X" } } },
                    },
                  },
                }),
              },
            }),
            servers: [],
          },
        },
        { file: "domains/b.yaml", doc: { tags: [{ name: "B", description: "tanpa rujukan" }] } },
      ],
      r,
    );
    assert.match(e, /\$ref '#\/components\/schemas\/Hilang' tidak ditemukan/);
    assert.match(e, /harus rujukan internal/);
    assert.match(e, /kunci tingkat atas 'servers' tidak diizinkan/);
    assert.match(e, /path wajib berada di openapi\/domains/);
    assert.match(e, /tag 'B' wajib memiliki description yang merujuk F-xx/);
  });

  it("operasi tanpa tepat satu tag", () => {
    const e = errorsOf([
      { file: "domains/a.yaml", doc: domain("A", { "/x": { get: { ...op("getX", "A"), tags: [] } } }) },
    ]);
    assert.match(e, /wajib memiliki tepat satu tag/);
  });
});
