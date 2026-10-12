// Uji skema amplop realtime (ARCHITECTURE §4.9): contoh valid lolos, bentuk menyimpang ditolak.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { PATHS } from "../lib/fs.mjs";

const addFormats = addFormatsModule.default ?? addFormatsModule;
const envelope = JSON.parse(readFileSync(join(PATHS.eventsDir, "envelope.schema.json"), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(envelope);
const valid = envelope.examples[0];

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
});
