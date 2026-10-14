// Uji manifest rilis (PRD 9.3 paket penerimaan; PRD 5.5 versi image <-> versi skema).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildManifest, parseDigests, renderNotes, repoFacts } from "../release-manifest.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const D = (c) => `sha256:${c.repeat(64)}`;

describe("manifest rilis", () => {
  it("digest dibaca dari TSV dan divalidasi", () => {
    const images = parseDigests(`api\tghcr.io/o/kapdh-api\t${D("a")}\nweb\tghcr.io/o/kapdh-web\t${D("b")}\n`);
    assert.equal(images.length, 2);
    assert.equal(images[0].ref, `ghcr.io/o/kapdh-api@${D("a")}`);
    assert.throws(() => parseDigests("api\tghcr.io/o/kapdh-api\tsha256:xyz"), /tidak valid/);
  });

  it("fakta repo nyata: versi kontrak, versi aplikasi minimum dan migrasi terakhir", () => {
    const facts = repoFacts();
    assert.match(facts.contracts.version, /^\d+\.\d+\.\d+$/);
    assert.match(facts.contracts.min_app_version ?? "", /^\d+\.\d+\.\d+$/);
    assert.match(facts.database.latest_migration ?? "", /^\d{4}_/);
    assert.ok(facts.database.migrations >= 1);
  });

  it("manifest menolak tag/sha tidak sah dan merangkum digest di catatan rilis", () => {
    const facts = repoFacts();
    const images = parseDigests(`api\tghcr.io/o/kapdh-api\t${D("c")}`);
    assert.throws(() => buildManifest({ tag: "1.0.0", sha: SHA, images, facts }), /tag rilis/);
    assert.throws(() => buildManifest({ tag: "v1.0.0", sha: "x", images, facts }), /sha/);
    const m = buildManifest({
      tag: "v1.0.0-rc.1",
      sha: SHA,
      images,
      facts,
      createdAt: "2027-03-01T00:00:00Z",
    });
    assert.equal(m.version, "1.0.0-rc.1");
    assert.equal(m.database.latest_migration, facts.database.latest_migration);
    assert.match(renderNotes(m), new RegExp(D("c")));
  });
});
