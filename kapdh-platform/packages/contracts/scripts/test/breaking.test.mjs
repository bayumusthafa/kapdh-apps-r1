// Uji gerbang kompatibilitas kontrak (N-13, temuan audit D2-12): kebijakan murni scripts/lib/breaking.mjs dan
// pemilihan tag rilis pembanding scripts/check-breaking.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { latestContractsTag } from "../check-breaking.mjs";
import {
  compareSemver,
  contractMeta,
  evaluateCompatibility,
  isMajorBump,
  levelOf,
  MIN_APP_VERSION_KEY,
  normalizeChanges,
  renderReport,
  versionConsistency,
} from "../lib/breaking.mjs";
import { PACKAGE_ROOT, PATHS } from "../lib/fs.mjs";

// Bentuk keluaran `oasdiff breaking --format json` (formatters.Change: level 3 = ERR, 2 = WARN).
const removedOp = {
  id: "api-path-removed-without-deprecation",
  text: "api path removed without deprecation",
  level: 3,
  operation: "GET",
  path: "/me/card",
  section: "paths",
};
const enumAdded = {
  id: "response-property-enum-value-added",
  text: "added the new enum value 'x' to the response property 'status'",
  level: 2,
  operation: "GET",
  path: "/me",
  section: "paths",
};
const meta = (version, minAppVersion = "1.0.0") => ({ version, minAppVersion });

describe("N-13: kebijakan kompatibilitas kontrak", () => {
  it("level oasdiff dibaca dari angka maupun teks", () => {
    assert.equal(levelOf({ level: 3 }), 3);
    assert.equal(levelOf({ level: "error" }), 3);
    assert.equal(levelOf({ level: "ERR" }), 3);
    assert.equal(levelOf({ level: "warning" }), 2);
    assert.equal(levelOf({ level: "info" }), 1);
    assert.equal(levelOf({}), 0);
  });

  it("keluaran oasdiff: array polos dan objek {changes} diterima, selain itu galat", () => {
    assert.deepEqual(normalizeChanges([removedOp]), [removedOp]);
    assert.deepEqual(normalizeChanges({ changes: [removedOp], diff_empty: false }), [removedOp]);
    assert.throws(() => normalizeChanges({ foo: 1 }), /bukan daftar perubahan/);
  });

  it("semver: kenaikan mayor; di bawah 1.0.0 minor berperan sebagai mayor", () => {
    assert.equal(isMajorBump("1.4.2", "2.0.0"), true);
    assert.equal(isMajorBump("1.4.2", "1.5.0"), false);
    assert.equal(isMajorBump("0.2.0", "0.3.0"), true);
    assert.equal(isMajorBump("0.2.0", "0.2.1"), false);
    assert.equal(isMajorBump("0.2.0", "1.0.0"), true);
    assert.equal(isMajorBump("2.0.0", "1.9.0"), false);
    assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareSemver("v1.2.3", "1.2.3"), 0);
  });

  it("perubahan aditif (tanpa ERR) lulus walau versi tidak naik; WARN hanya peringatan", () => {
    const r = evaluateCompatibility({ changes: [enumAdded], base: meta("0.2.0"), head: meta("0.2.0") });
    assert.equal(r.ok, true);
    assert.equal(r.verdict, "compatible");
    assert.equal(r.warnings.length, 1);
    assert.equal(r.breaking.length, 0);
  });

  it("D2-12: perubahan memutus tanpa kenaikan versi mayor GAGAL", () => {
    const r = evaluateCompatibility({
      changes: [removedOp],
      base: meta("0.2.0"),
      head: meta("0.2.1", "1.1.0"),
    });
    assert.equal(r.ok, false);
    assert.equal(r.verdict, "breaking-blocked");
    assert.match(r.problems.join("\n"), /versi mayor/);
  });

  it("D2-12: versi mayor naik tetapi versi aplikasi minimum tetap -> GAGAL", () => {
    const r = evaluateCompatibility({
      changes: [removedOp],
      base: meta("1.0.0"),
      head: meta("2.0.0", "1.0.0"),
    });
    assert.equal(r.ok, false);
    assert.match(r.problems.join("\n"), new RegExp(MIN_APP_VERSION_KEY));
  });

  it("D2-12: versi mayor dan versi aplikasi minimum naik bersama -> perubahan memutus diterima", () => {
    const r = evaluateCompatibility({
      changes: [removedOp],
      base: meta("1.0.0"),
      head: meta("2.0.0", "1.2.0"),
    });
    assert.equal(r.ok, true);
    assert.equal(r.verdict, "breaking-approved");
    const md = renderReport({
      baseRef: "contracts-v1.0.0",
      base: meta("1.0.0"),
      head: meta("2.0.0", "1.2.0"),
      result: r,
    });
    assert.match(md, /DITERIMA/);
    assert.match(md, /app_settings\.min_app_version/);
    assert.match(md, /\/me\/card/);
  });

  it("perubahan memutus tanpa x-kapdh-min-app-version di kepala -> GAGAL", () => {
    const r = evaluateCompatibility({
      changes: [removedOp],
      base: meta("1.0.0", null),
      head: meta("2.0.0", null),
    });
    assert.equal(r.ok, false);
    assert.match(r.problems.join("\n"), /memerlukan info\.x-kapdh-min-app-version/);
  });

  it("versi kontrak turun selalu GAGAL", () => {
    const r = evaluateCompatibility({ changes: [], base: meta("1.2.0"), head: meta("1.1.0") });
    assert.equal(r.ok, false);
    assert.match(r.problems.join("\n"), /turun/);
  });

  it("versi info, package.json dan pubspec wajib sama", () => {
    assert.deepEqual(
      versionConsistency({ infoVersion: "0.2.0", packageVersion: "0.2.0", pubspecVersion: "0.2.0" }),
      [],
    );
    const problems = versionConsistency({
      infoVersion: "0.3.0",
      packageVersion: "0.2.0",
      pubspecVersion: "0.2.0",
    });
    assert.equal(problems.length, 2);
  });

  it("tag pembanding = contracts-v* dengan semver tertinggi; tag lain diabaikan", () => {
    assert.equal(latestContractsTag([]), null);
    assert.equal(latestContractsTag(["v1.0.0", "contracts-vx", ""]), null);
    assert.equal(
      latestContractsTag(["contracts-v0.9.0", "contracts-v0.10.0", "contracts-v0.10.0-rc.1", "v9.9.9"]),
      "contracts-v0.10.0",
    );
  });
});

describe("N-13: metadata kontrak nyata", () => {
  const root = parse(readFileSync(join(PATHS.openapiDir, "root.yaml"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const pubspec = /^version:\s*(\S+)\s*$/m.exec(
    readFileSync(join(PATHS.dartPackage, "pubspec.yaml"), "utf8"),
  )?.[1];

  it("root.yaml menyatakan versi aplikasi minimum semver dan versi yang sama dengan paket", () => {
    const m = contractMeta(root);
    assert.match(m.minAppVersion ?? "", /^\d+\.\d+\.\d+$/);
    assert.deepEqual(
      versionConsistency({ infoVersion: m.version, packageVersion: pkg.version, pubspecVersion: pubspec }),
      [],
    );
  });

  it("CLI dengan keluaran oasdiff tersimpan: pembanding HEAD dirakit dari git dan perubahan ERR digagalkan", () => {
    const dir = mkdtempSync(join(tmpdir(), "kapdh-breaking-test-"));
    try {
      const changes = join(dir, "changes.json");
      writeFileSync(changes, JSON.stringify([removedOp, enumAdded]));
      const report = join(dir, "r.md");
      const blocked = spawnSync(
        process.execPath,
        ["scripts/check-breaking.mjs", "--base-ref", "HEAD", "--changes-json", changes, "--report", report],
        { cwd: PACKAGE_ROOT, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
      );
      assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
      assert.match(blocked.stdout, /Pembanding HEAD: dirakit dari openapi\/ pada ref/);
      assert.match(
        blocked.stdout,
        /::error title=Kontrak memutus: api-path-removed-without-deprecation::GET \/me\/card/,
      );
      const md = readFileSync(report, "utf8");
      assert.match(md, /GAGAL: perubahan memutus/);
      assert.match(md, /Peringatan \(tidak memblokir\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
