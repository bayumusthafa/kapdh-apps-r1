// Uji skema event realtime (ARCHITECTURE §4.9): amplop nyata, aturan katalog payload per jenis event, dan pemetaan
// $ref antarberkas ke komponen untuk generator TS/Dart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  analyzeEvents,
  createEventsAjv,
  eventComponentSchemas,
  payloadKinds,
  payloadTitle,
  readEventFiles,
} from "../lib/events.mjs";
import { fixtureEvents } from "../lib/dart/fixture.mjs";
import { PATHS } from "../lib/fs.mjs";

const envelope = JSON.parse(readFileSync(join(PATHS.eventsDir, "envelope.schema.json"), "utf8"));
const ajv = createEventsAjv();
const validate = ajv.compile(envelope);
const valid = envelope.examples[0];
const ID = "https://kapdh.or.id/contracts/events/";

/** Katalog uji: amplop dengan jenis a.b dan c.d, plus berkas tambahan. */
function catalog(extraFiles, { less = [], pending = [] } = {}) {
  const env = {
    ...structuredClone(envelope),
    properties: {
      ...structuredClone(envelope.properties),
      type: { title: "RealtimeEventType", type: "string", enum: ["a.b", "c.d"] },
    },
    "x-kapdh-payload-less": less,
    "x-kapdh-payload-pending": pending,
  };
  return [{ file: "envelope.schema.json", schema: env }, ...extraFiles];
}

const payloadFile = (type, schema = {}) => ({
  file: `${type}.schema.json`,
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${ID}${type}.schema.json`,
    title: payloadTitle(type),
    type: "object",
    additionalProperties: false,
    properties: { room_id: { type: "string" } },
    examples: [{ room_id: "x" }],
    ...schema,
  },
});

describe("events/envelope.schema.json", () => {
  it("memuat 10 jenis event ARCHITECTURE §4.9", () => {
    assert.deepEqual(envelope.properties.type.enum, [
      "message.created",
      "message.deleted",
      "reaction.updated",
      "read.updated",
      "room.updated",
      "room.member_changed",
      "typing",
      "presence",
      "notification.created",
      "session.revoked",
    ]);
  });

  it("contoh valid lolos", () => {
    for (const example of envelope.examples)
      assert.equal(validate(example), true, ajv.errorsText(validate.errors));
  });

  it("menolak versi lain, jenis tak dikenal, field hilang, field tambahan dan id bukan UUID", () => {
    assert.equal(validate({ ...valid, v: 2 }), false);
    assert.equal(validate({ ...valid, type: "message.edited" }), false);
    const withoutTs = { ...valid };
    delete withoutTs.ts;
    assert.equal(validate(withoutTs), false);
    assert.equal(validate({ ...valid, body: "isi chat" }), false);
    assert.equal(validate({ ...valid, event_id: "bukan-uuid" }), false);
    assert.equal(validate({ ...valid, ts: "kemarin" }), false);
  });

  it("katalog nyata valid: setiap jenis event punya payload atau terdaftar eksplisit", () => {
    const { files, errors } = readEventFiles(PATHS.eventsDir);
    assert.deepEqual(errors, []);
    const analysis = analyzeEvents(files);
    assert.deepEqual(analysis.errors, []);
    for (const { type, kind } of payloadKinds(analysis)) {
      assert.ok(["schema", "none", "pending"].includes(kind), type);
    }
  });
});

describe("katalog payload event (analyzeEvents)", () => {
  it("jenis tanpa payload dan tanpa deklarasi gagal dengan petunjuk", () => {
    const { errors } = analyzeEvents(catalog([payloadFile("a.b")]));
    assert.match(
      errors.join("\n"),
      /jenis event 'c\.d' belum memiliki payload: tambahkan events\/c\.d\.schema\.json/,
    );
  });

  it("payload-less dan pending diterima; pending menghasilkan peringatan", () => {
    const analysis = analyzeEvents(catalog([], { less: ["a.b"], pending: ["c.d"] }));
    assert.deepEqual(analysis.errors, []);
    assert.match(analysis.warnings.join("\n"), /belum ditulis .*c\.d/);
    assert.deepEqual(payloadKinds(analysis), [
      { type: "a.b", kind: "none" },
      { type: "c.d", kind: "pending" },
    ]);
  });

  it("menolak deklarasi ganda, jenis tak dikenal, title salah, payload longgar dan properti bukan snake_case", () => {
    const errors = analyzeEvents(
      catalog(
        [
          payloadFile("a.b", { title: "Salah" }),
          payloadFile("c.d", {
            additionalProperties: true,
            properties: { roomId: { type: "string" } },
          }),
        ],
        { less: ["a.b", "x.y"], pending: ["a.b"] },
      ),
    ).errors.join("\n");
    assert.match(errors, /x-kapdh-payload-less memuat jenis tak dikenal 'x\.y'/);
    assert.match(errors, /'a\.b' tidak boleh sekaligus/);
    assert.match(errors, /title payload jenis 'a\.b' wajib ABPayload/);
    assert.match(errors, /jenis 'a\.b' sudah memiliki skema payload/);
    assert.match(errors, /c\.d\.schema\.json: payload wajib additionalProperties: false/);
    assert.match(errors, /properties\/roomId: nama properti wajib snake_case/);
  });

  it("$ref antarberkas dipetakan ke komponen; rujukan fragmen dan yang tak dikenal ditolak", () => {
    const shared = {
      file: "chat-item.schema.json",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `${ID}chat-item.schema.json`,
        title: "ChatItem",
        type: "object",
        properties: { id: { type: "string" }, parent: { oneOf: [{ $ref: "#" }, { type: "null" }] } },
        examples: [{ id: "1" }],
      },
    };
    const good = analyzeEvents(
      catalog([payloadFile("a.b", { properties: { item: { $ref: "chat-item.schema.json" } } }), shared], {
        less: ["c.d"],
      }),
    );
    assert.deepEqual(good.errors, []);
    const components = eventComponentSchemas(good);
    assert.deepEqual(components.ABPayload.properties.item, { $ref: "#/components/schemas/ChatItem" });
    assert.deepEqual(components.ChatItem.properties.parent.oneOf[0], {
      $ref: "#/components/schemas/ChatItem",
    });
    assert.equal(components.RealtimeEnvelope["x-kapdh-payload-less"], undefined);
    assert.equal(components.ChatItem.$id, undefined);

    const bad = analyzeEvents(
      catalog(
        [
          payloadFile("a.b", {
            properties: {
              frag: { $ref: "chat-item.schema.json#/properties/id" },
              missing: { $ref: "tidak-ada.schema.json" },
            },
          }),
          shared,
        ],
        { less: ["c.d"] },
      ),
    ).errors.join("\n");
    assert.match(bad, /merujuk bagian skema/);
    assert.match(bad, /'tidak-ada\.schema\.json' tidak ditemukan/);
  });

  it("katalog fixture generator valid dan dikompilasi Ajv strict (termasuk $ref antarberkas)", () => {
    const analysis = fixtureEvents();
    assert.deepEqual(analysis.errors, []);
    const fixtureAjv = createEventsAjv();
    for (const s of [...analysis.payloads.values(), ...analysis.shared]) fixtureAjv.addSchema(s.schema);
    const payload = analysis.payloads.get("message.created");
    const check = fixtureAjv.getSchema(payload.schema.$id);
    for (const example of payload.schema.examples)
      assert.equal(check(example), true, fixtureAjv.errorsText(check.errors));
    assert.equal(check({ room_id: "0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e61" }), false);
  });
});
