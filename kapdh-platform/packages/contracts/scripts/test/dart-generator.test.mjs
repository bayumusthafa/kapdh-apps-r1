// Uji generator SDK Dart: penamaan, pemetaan tipe, penolakan konstruksi yang tidak didukung, dan katalog shared.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApis, renderApiFile } from "../lib/dart/api.mjs";
import { renderCatalogs } from "../lib/dart/catalog.mjs";
import { ModelRegistry, splitNullable } from "../lib/dart/model.mjs";
import { camelCase, dartString, enumMemberName, headerParamName, safeMemberName } from "../lib/names.mjs";
import { loadSharedCatalog } from "../lib/shared-catalog.mjs";

const spec = (schemas, paths = {}) => ({
  openapi: "3.1.0",
  security: [{ bearerAuth: [] }],
  tags: [{ name: "Uji", description: "Uji (F-01)." }],
  paths,
  components: { schemas },
});

describe("penamaan Dart", () => {
  it("snake_case, UPPER_SNAKE, titik dan angka menjadi identifier aman", () => {
    assert.equal(camelCase("pending_otp"), "pendingOtp");
    assert.equal(safeMemberName("VALIDATION_ERROR"), "validationError");
    assert.equal(safeMemberName("payments.read"), "paymentsRead");
    assert.equal(safeMemberName("room.member_changed"), "roomMemberChanged");
    assert.equal(safeMemberName("01"), "v01");
    assert.equal(safeMemberName("default"), "defaultValue");
    assert.equal(safeMemberName("hash_code"), "hashCodeValue");
    assert.equal(safeMemberName("type"), "type");
    // Field boleh bernama name/value; anggota enum tidak (bentrok dengan Enum.name dan field value).
    assert.equal(safeMemberName("name"), "name");
    assert.equal(enumMemberName("name"), "nameValue");
    assert.equal(enumMemberName("unknown"), "unknownValue");
    assert.equal(safeMemberName("other"), "otherValue");
    assert.equal(headerParamName("X-Reauth-Token"), "reauthToken");
    assert.equal(headerParamName("If-Match"), "ifMatch");
    assert.equal(headerParamName("Idempotency-Key"), "idempotencyKey");
    assert.equal(dartString("Rp$1 'x'"), "'Rp\\$1 \\'x\\''");
  });

  it("skema nullable OAS 3.1 dikenali", () => {
    assert.deepEqual(splitNullable({ type: ["string", "null"] }), {
      schema: { type: "string" },
      nullable: true,
    });
    assert.deepEqual(splitNullable({ oneOf: [{ $ref: "#/components/schemas/X" }, { type: "null" }] }), {
      schema: { $ref: "#/components/schemas/X" },
      nullable: true,
    });
  });
});

describe("ModelRegistry", () => {
  it("menolak nama yang bentrok dengan Flutter/dart:core dan polimorfisme oneOf", () => {
    const registry = new ModelRegistry(
      spec({
        Notification: { type: "object", properties: { id: { type: "string" } } },
        Shape: { oneOf: [{ type: "string" }, { type: "integer" }] },
      }),
    ).buildAll();
    const errors = registry.errors.join("\n");
    assert.match(errors, /skema Notification: nama bentrok/);
    assert.match(errors, /oneOf\/anyOf polimorfik/);
  });

  it("Error dipetakan ke ApiError; Money tetap String; field opsional+nullable body request menjadi Optional", () => {
    const registry = new ModelRegistry(
      spec(
        {
          Error: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
          Money: { type: "string", pattern: "^[0-9]+\\.[0-9]{2}$" },
          Patch: {
            type: "object",
            properties: {
              city: { type: ["string", "null"] },
              amount: { $ref: "#/components/schemas/Money" },
            },
          },
        },
        {
          "/x": {
            patch: {
              tags: ["Uji"],
              operationId: "patchX",
              requestBody: {
                required: true,
                content: { "application/json": { schema: { $ref: "#/components/schemas/Patch" } } },
              },
              responses: { 204: { description: "ok" } },
            },
          },
        },
      ),
    ).buildAll();
    assert.deepEqual(registry.errors, []);
    assert.equal(registry.types.get("ApiError").kind, "class");
    assert.equal(
      registry.renderAlias(registry.types.get("Money")).trim().split("\n").pop(),
      "typedef Money = String;",
    );
    const patch = registry.types.get("Patch");
    assert.equal(
      registry.fieldDartType(patch.fields.find((f) => f.jsonName === "city")),
      "Optional<String?>",
    );
    assert.equal(registry.fieldDartType(patch.fields.find((f) => f.jsonName === "amount")), "Money?");

    const [group] = buildApis(registry.bundle, registry);
    const file = renderApiFile(registry, group);
    assert.match(file, /Future<void> patchX\(\n {4}Patch body, \{/);
    assert.match(file, /decode: \(_\) \{\}/);
  });

  it("enum inline diberi nama dari konteks atau title, dengan cadangan unknown", () => {
    const registry = new ModelRegistry(
      spec({
        Item: {
          type: "object",
          required: ["state"],
          properties: {
            state: { type: "string", enum: ["open", "closed"] },
            kind: { title: "ItemKind", type: "string", enum: ["a", "b"] },
          },
        },
      }),
    ).buildAll();
    assert.deepEqual(registry.errors, []);
    assert.ok(registry.types.get("ItemState"));
    const kind = registry.renderEnum(registry.types.get("ItemKind"));
    assert.match(kind, /unknown\(''\);/);
    assert.match(kind, /static ItemKind fromJson\(String value\)/);
  });

  it("allOf mewarisi field induk (termasuk enum inline) dan implements induk", () => {
    const registry = new ModelRegistry(
      spec({
        Base: {
          type: "object",
          required: ["state"],
          properties: { state: { type: "string", enum: ["open", "closed"] }, note: { type: "string" } },
        },
        Child: {
          allOf: [
            { $ref: "#/components/schemas/Base" },
            { type: "object", required: ["note"], properties: { extra: { type: "integer" } } },
          ],
        },
        ItemState: { type: "string", enum: ["x"] },
        Item: { type: "object", properties: { state: { type: "string", enum: ["a"] } } },
      }),
    ).buildAll();
    const child = registry.types.get("Child");
    assert.deepEqual(
      child.fields.map((f) => [f.jsonName, registry.fieldDartType(f)]),
      [
        ["state", "BaseState"],
        ["note", "String"],
        ["extra", "int?"],
      ],
    );
    assert.equal(registry.types.has("ChildState"), false);
    assert.match(registry.renderClass(child), /class Child implements Base \{/);
    // Enum inline Item.state bernama ItemState bentrok dengan skema komponen ItemState.
    assert.match(registry.errors.join("\n"), /nama tipe inline ItemState bentrok dengan skema komponen/);
  });

  it("respons 2xx dengan skema berbeda ditolak dengan pesan jelas", () => {
    const registry = new ModelRegistry(
      spec(
        {
          A: { type: "object", properties: { a: { type: "string" } } },
          B: { type: "object", properties: { b: { type: "string" } } },
        },
        {
          "/x": {
            get: {
              tags: ["Uji"],
              operationId: "getX",
              responses: {
                200: {
                  description: "a",
                  content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } },
                },
                202: {
                  description: "b",
                  content: { "application/json": { schema: { $ref: "#/components/schemas/B" } } },
                },
              },
            },
          },
        },
      ),
    ).buildAll();
    buildApis(registry.bundle, registry);
    assert.match(registry.errors.join("\n"), /respons 2xx dengan skema berbeda/);
  });
});

describe("katalog @kapdh/shared", () => {
  it("dimuat dari sumber TypeScript dan cocok dengan enum kontrak", async () => {
    const shared = await loadSharedCatalog();
    assert.equal(shared.ERROR_UI.MEMBERSHIP_REQUIRED.action, "refresh_status");
    assert.equal(shared.routeForStatus("expired"), "renewal");

    const registry = new ModelRegistry(
      spec({
        ErrorCode: { type: "string", enum: Object.keys(shared.ERROR_UI) },
        EffectiveStatus: { type: "string", enum: Object.keys(shared.MEMBERSHIP_LABEL) },
      }),
    ).buildAll();
    const files = renderCatalogs(registry, shared);
    assert.deepEqual(registry.errors, []);
    assert.match(
      files["error_catalog.dart"],
      /ErrorCode\.membershipRequired => const ErrorUi\(action: ErrorUiAction\.refreshStatus/,
    );
    assert.match(files["status_routes.dart"], /EffectiveStatus\.unknown => null,/);
  });

  it("gagal bila ErrorCode kontrak tidak sama dengan ERROR_UI", async () => {
    const shared = await loadSharedCatalog();
    const registry = new ModelRegistry(
      spec({
        ErrorCode: { type: "string", enum: [...Object.keys(shared.ERROR_UI), "KODE_BARU"] },
        EffectiveStatus: { type: "string", enum: Object.keys(shared.MEMBERSHIP_LABEL) },
      }),
    ).buildAll();
    renderCatalogs(registry, shared);
    assert.match(
      registry.errors.join("\n"),
      /ERROR_UI \(@kapdh\/shared\) tidak sama dengan ErrorCode kontrak/,
    );
  });
});
