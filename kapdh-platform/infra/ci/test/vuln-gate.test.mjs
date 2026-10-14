// Gerbang kerentanan (N-16, PRD 9.3): pnpm audit, OSV pubspec.lock dan grype memakai satu ambang dan satu allowlist
// yang ditinjau (pemilik, alasan, kedaluwarsa <= 90 hari).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_ALLOWLIST,
  evaluate,
  findings,
  InputError,
  levelFromCvss,
  main,
  validateAllowlist,
} from "../vuln-gate.mjs";
import { readFileSync } from "node:fs";

const TODAY = "2026-10-14";

const PNPM = {
  advisories: {
    1: {
      id: 1,
      github_advisory_id: "GHSA-p68q-wchp-6fh7",
      module_name: "fastify",
      severity: "high",
      title: "authentication bypass via malformed URLs",
      patched_versions: ">=5.12.2",
      cves: [],
      findings: [{ version: "5.11.3", paths: ["apps__api>fastify"] }],
    },
    2: {
      id: 2,
      github_advisory_id: "GHSA-3m5p-2c4r-xxw2",
      module_name: "fastify",
      severity: "moderate",
      title: "X-Forwarded-* spoofing",
      patched_versions: ">=5.12.1",
      cves: ["CVE-2026-0001"],
      findings: [{ version: "5.11.3", paths: ["apps__api>fastify"] }],
    },
  },
  metadata: { vulnerabilities: { high: 1, moderate: 1 } },
};

const GRYPE = {
  matches: [
    {
      vulnerability: { id: "CVE-2026-1111", severity: "Critical", fix: { versions: ["3.5.1-r0"] } },
      relatedVulnerabilities: [{ id: "CVE-2026-1111" }],
      artifact: { name: "libssl3", version: "3.5.0-r0", type: "apk" },
    },
    {
      vulnerability: { id: "GHSA-xxxx-yyyy-zzzz", severity: "High", fix: { versions: [] } },
      relatedVulnerabilities: [],
      artifact: { name: "cross-spawn", version: "7.0.3", type: "npm" },
    },
    {
      vulnerability: { id: "CVE-2026-2222", severity: "Unknown" },
      artifact: { name: "busybox", version: "1.37.0-r1", type: "apk" },
    },
  ],
};

const OSV = {
  results: [
    {
      source: { path: "kapdh-mobile/pubspec.lock" },
      packages: [
        {
          package: { name: "dio", version: "5.0.0", ecosystem: "Pub" },
          groups: [{ ids: ["GHSA-aaaa"], aliases: ["CVE-1"], max_severity: "9.8" }],
        },
        {
          package: { name: "http", version: "0.13.0", ecosystem: "Pub" },
          groups: [{ ids: ["GHSA-bbbb"], aliases: [], max_severity: "7.5" }],
        },
        {
          package: { name: "yaml", version: "3.0.0", ecosystem: "Pub" },
          vulnerabilities: [{ id: "GHSA-cccc", aliases: [] }],
        },
      ],
    },
  ],
};

const entry = (over = {}) => ({
  id: "GHSA-p68q-wchp-6fh7",
  source: "pnpm-audit",
  package: "fastify",
  owner: "pengelola infra",
  reason: "Rute not-found terenkapsulasi tidak dipakai; upgrade dijadwalkan sprint ini.",
  expires: "2026-11-01",
  ...over,
});

describe("gerbang kerentanan (vuln-gate)", () => {
  it("normalisasi tingkat: CVSS dan teks pemindai", () => {
    assert.deepEqual(["9.8", "7.0", "5", "0.1", "", "x"].map(levelFromCvss), [
      "critical",
      "high",
      "moderate",
      "low",
      "unknown",
      "unknown",
    ]);
    const g = findings("grype", GRYPE);
    assert.deepEqual(
      g.map((f) => f.level),
      ["critical", "high", "unknown"],
    );
    assert.deepEqual(
      findings("osv", OSV).map((f) => f.level),
      ["critical", "high", "unknown"],
    );
  });

  it("pnpm audit: tinggi memblokir bila --fail-on high; sedang hanya peringatan", () => {
    const list = findings("pnpm-audit", PNPM);
    assert.deepEqual(list[1].ids, ["GHSA-3m5p-2c4r-xxw2", "CVE-2026-0001", "npm:2"]);
    const v = evaluate(list, { failOn: "high" });
    assert.equal(v.ok, false);
    assert.deepEqual(
      v.blocking.map((f) => f.ids[0]),
      ["GHSA-p68q-wchp-6fh7"],
    );
    assert.deepEqual(
      v.warnings.map((f) => f.ids[0]),
      ["GHSA-3m5p-2c4r-xxw2"],
    );
    assert.equal(evaluate(list, { failOn: "critical" }).ok, true);
  });

  it("allowlist yang berlaku menerima temuan; entri kedaluwarsa tidak berlaku", () => {
    const list = findings("pnpm-audit", PNPM);
    const ok = evaluate(list, {
      failOn: "high",
      allow: validateAllowlist({ entries: [entry()] }, { today: TODAY }),
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.accepted[0].entry.owner, "pengelola infra");

    const old = validateAllowlist({ entries: [entry({ expires: "2026-10-01" })] }, { today: TODAY });
    assert.equal(old.expired.length, 1);
    const blocked = evaluate(list, { failOn: "high", allow: old });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blocking[0].expiredEntry.expires, "2026-10-01");

    const otherPkg = validateAllowlist({ entries: [entry({ package: "lain" })] }, { today: TODAY });
    assert.equal(evaluate(list, { failOn: "high", allow: otherPkg }).ok, false);
  });

  it("allowlist tidak valid ditolak: tanpa pemilik/alasan, kedaluwarsa > 90 hari, sumber asing", () => {
    const r = validateAllowlist(
      {
        entries: [
          entry({ owner: "" }),
          entry({ reason: "singkat" }),
          entry({ expires: "2027-06-01" }),
          entry({ source: "npm" }),
          entry({ expires: "besok" }),
        ],
      },
      { today: TODAY },
    );
    assert.equal(r.problems.length, 5);
    assert.equal(r.entries.length, 0);
    assert.match(validateAllowlist({}, { today: TODAY }).problems[0], /entries/);
  });

  it("laporan rusak atau galat jaringan pnpm audit gagal tertutup", () => {
    assert.throws(() => findings("pnpm-audit", { error: { code: "ENOTFOUND" } }), InputError);
    assert.throws(() => findings("grype", {}), InputError);
    assert.throws(() => findings("lain", {}), InputError);
  });

  it("CLI: kode keluar 0/1, allowlist bawaan valid dan kosong", () => {
    const allowDoc = JSON.parse(readFileSync(DEFAULT_ALLOWLIST, "utf8"));
    const def = validateAllowlist(allowDoc, { today: TODAY });
    assert.deepEqual(def.problems, []);

    const dir = mkdtempSync(join(tmpdir(), "kapdh-vuln-gate-"));
    const quiet = console.log;
    console.log = () => {};
    try {
      const report = join(dir, "grype.json");
      writeFileSync(report, JSON.stringify(GRYPE));
      const allow = join(dir, "allow.json");
      writeFileSync(allow, JSON.stringify({ entries: [] }));
      assert.equal(
        main(
          ["--source", "grype", report, "--fail-on", "critical", "--allowlist", allow],
          {},
          { today: TODAY },
        ),
        1,
      );
      writeFileSync(
        allow,
        JSON.stringify({ entries: [entry({ id: "CVE-2026-1111", source: "grype", package: "libssl3" })] }),
      );
      assert.equal(
        main(
          ["--source", "grype", report, "--fail-on", "critical", "--allowlist", allow],
          {},
          { today: TODAY },
        ),
        0,
      );
      assert.equal(
        main(["--source", "grype", report, "--fail-on", "high", "--allowlist", allow], {}, { today: TODAY }),
        1,
      );
      const empty = join(dir, "audit.json");
      writeFileSync(empty, JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }));
      assert.equal(main(["--source", "pnpm-audit", empty, "--allowlist", allow], {}, { today: TODAY }), 0);
      writeFileSync(allow, JSON.stringify({ entries: [entry({ owner: "" })] }));
      assert.throws(
        () => main(["--source", "pnpm-audit", empty, "--allowlist", allow], {}, { today: TODAY }),
        InputError,
      );
    } finally {
      console.log = quiet;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
