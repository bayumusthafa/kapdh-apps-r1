// Uji perbandingan skema event realtime (N-13 untuk Socket.IO; review E2 untuk D2-12) dan aturan versi aplikasi
// minimum yang tidak boleh turun.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { evaluateCompatibility, MIN_APP_VERSION_KEY } from "../lib/breaking.mjs";
import { diffEventSchemas, LEVEL } from "../lib/events-compat.mjs";
import { PATHS } from "../lib/fs.mjs";

const clone = (v) => structuredClone(v);
const typing = {
  title: "TypingPayload",
  type: "object",
  required: ["room_id", "user_id", "ttl_seconds"],
  properties: {
    room_id: { type: "string", format: "uuid" },
    user_id: { type: "string", format: "uuid" },
    ttl_seconds: { type: "integer", minimum: 1 },
    hint: { type: "string", enum: ["a", "b"] },
  },
};
const envelope = {
  type: "object",
  required: ["v", "type"],
  properties: {
    v: { type: "integer", const: 1 },
    type: { type: "string", enum: ["message.created", "typing"] },
  },
};
const base = { "typing.schema.json": typing, "envelope.schema.json": envelope };
const ids = (changes, level) =>
  changes
    .filter((c) => c.level === level)
    .map((c) => c.id)
    .sort();

describe("N-13: kompatibilitas skema event realtime (pembaca = aplikasi)", () => {
  it("skema kontrak nyata dibandingkan dengan dirinya sendiri: tanpa perubahan", () => {
    const files = Object.fromEntries(
      readdirSync(PATHS.eventsDir)
        .filter((f) => f.endsWith(".schema.json"))
        .map((f) => [f, JSON.parse(readFileSync(join(PATHS.eventsDir, f), "utf8"))]),
    );
    assert.ok(Object.keys(files).length > 5);
    assert.deepEqual(diffEventSchemas(files, clone(files)), []);
  });

  it("properti wajib dihapus atau menjadi opsional, tipe diperlebar, format/const berubah -> ERR", () => {
    const head = clone(base);
    delete head["typing.schema.json"].properties.user_id;
    head["typing.schema.json"].required = ["room_id"];
    head["typing.schema.json"].properties.ttl_seconds.type = ["integer", "null"];
    head["typing.schema.json"].properties.room_id.format = "date-time";
    head["envelope.schema.json"].properties.v.const = 2;
    const changes = diffEventSchemas(base, head);
    assert.deepEqual(ids(changes, LEVEL.ERR), [
      "event-const-changed",
      "event-format-changed",
      "event-property-became-optional",
      "event-required-property-removed",
      "event-type-widened",
    ]);
    assert.ok(changes.every((c) => c.section === "events" && c.path.startsWith("events/")));
    assert.ok(changes.some((c) => c.path === "events/typing.schema.json#/properties/user_id"));
  });

  it("berkas skema atau jenis event dihapus -> ERR; enum payload bertambah -> WARN; berkurang -> INFO", () => {
    const head = clone(base);
    delete head["typing.schema.json"];
    head["envelope.schema.json"].properties.type.enum = ["message.created"];
    assert.deepEqual(ids(diffEventSchemas(base, head), LEVEL.ERR), [
      "event-schema-removed",
      "event-type-removed",
    ]);

    const enums = clone(base);
    enums["typing.schema.json"].properties.hint.enum = ["a", "c"];
    const changes = diffEventSchemas(base, enums);
    assert.deepEqual(ids(changes, LEVEL.ERR), []);
    assert.deepEqual(ids(changes, LEVEL.WARN), ["event-enum-value-added"]);
    assert.deepEqual(ids(changes, LEVEL.INFO), ["event-enum-value-removed"]);
  });

  it("perubahan aditif (properti/event baru, penyempitan tipe) tidak memutus", () => {
    const head = clone(base);
    head["typing.schema.json"].properties.extra = { type: "string" };
    head["typing.schema.json"].required.push("extra");
    head["envelope.schema.json"].properties.type.enum.push("presence");
    head["presence.schema.json"] = { type: "object" };
    head["typing.schema.json"].properties.hint.type = "string";
    const changes = diffEventSchemas(base, head);
    assert.deepEqual(ids(changes, LEVEL.ERR), []);
    assert.deepEqual(ids(changes, LEVEL.INFO), ["event-schema-added"]);
  });

  it("cabang oneOf baru (mis. null pada objek wajib) -> ERR; properti opsional dihapus -> WARN", () => {
    const b = {
      "m.schema.json": { type: "object", properties: { s: { oneOf: [{ $ref: "u.schema.json" }] } } },
    };
    const h = clone(b);
    h["m.schema.json"].properties.s.oneOf.push({ type: "null" });
    assert.deepEqual(ids(diffEventSchemas(b, h), LEVEL.ERR), ["event-oneof-branch-added"]);
    const removed = clone(b);
    delete removed["m.schema.json"].properties.s;
    assert.deepEqual(ids(diffEventSchemas(b, removed), LEVEL.WARN), ["event-optional-property-removed"]);
  });

  it("perubahan event ERR tunduk pada kebijakan versi mayor + versi aplikasi minimum", () => {
    const head = clone(base);
    delete head["typing.schema.json"].properties.user_id;
    const changes = diffEventSchemas(base, head);
    const blocked = evaluateCompatibility({
      changes,
      base: { version: "1.0.0", minAppVersion: "1.0.0" },
      head: { version: "1.1.0", minAppVersion: "1.0.0" },
    });
    assert.equal(blocked.ok, false);
    const approved = evaluateCompatibility({
      changes,
      base: { version: "1.0.0", minAppVersion: "1.0.0" },
      head: { version: "2.0.0", minAppVersion: "1.3.0" },
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.verdict, "breaking-approved");
  });
});

describe(`N-13: ${MIN_APP_VERSION_KEY} tidak boleh turun atau dihapus`, () => {
  it("turun tanpa perubahan memutus -> GAGAL; dihapus -> GAGAL; naik -> lulus", () => {
    const down = evaluateCompatibility({
      changes: [],
      base: { version: "1.2.0", minAppVersion: "1.2.0" },
      head: { version: "1.3.0", minAppVersion: "1.1.0" },
    });
    assert.equal(down.ok, false);
    assert.match(down.problems.join("\n"), /turun dari 1\.2\.0 ke 1\.1\.0/);
    const gone = evaluateCompatibility({
      changes: [],
      base: { version: "1.2.0", minAppVersion: "1.2.0" },
      head: { version: "1.3.0", minAppVersion: null },
    });
    assert.equal(gone.ok, false);
    assert.match(gone.problems.join("\n"), /dihapus/);
    const up = evaluateCompatibility({
      changes: [],
      base: { version: "1.2.0", minAppVersion: "1.2.0" },
      head: { version: "1.3.0", minAppVersion: "1.2.1" },
    });
    assert.equal(up.ok, true);
  });
});
