// Uji asap HTTP sesudah deploy (PRD 5.5, 8.3) dan gerbang OSV dependensi Flutter (N-16).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate, findings } from "../osv-gate.mjs";
import { judge, parseTargets, runSmoke } from "../smoke.mjs";

const headers = (h) => new Headers(h);
const SECURE = { "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff" };

describe("uji asap", () => {
  it("target wajib nama=url https", () => {
    assert.deepEqual(parseTargets(["api=https://staging-api.kapdh.or.id/api/v1/health/ready"]), [
      { name: "api", url: "https://staging-api.kapdh.or.id/api/v1/health/ready" },
    ]);
    assert.throws(() => parseTargets(["web=http://staging.kapdh.or.id/"]), /https/);
    assert.throws(() => parseTargets(["tanpa-url"]), /nama=url/);
    assert.throws(() => parseTargets([]), /tidak ada target/);
  });

  it("api lulus hanya bila readiness status ok", () => {
    assert.equal(judge("api", 200, headers({}), JSON.stringify({ status: "ok", checks: {} })), null);
    assert.match(judge("api", 200, headers({}), JSON.stringify({ status: "unavailable" })), /unavailable/);
    assert.match(judge("api", 503, headers({}), "{}"), /HTTP 503/);
    assert.match(judge("api", 200, headers({}), "<html>"), /bukan JSON/);
  });

  it("web/admin wajib membawa header keamanan nginx (N-07)", () => {
    assert.equal(judge("web", 200, headers(SECURE), "<html>"), null);
    assert.match(
      judge("admin", 200, headers({ "x-content-type-options": "nosniff" }), ""),
      /Content-Security-Policy/,
    );
    assert.match(judge("web", 200, headers({ "content-security-policy": "x" }), ""), /nosniff/);
  });

  it("mengulang sampai lulus, atau gagal saat habis waktu", async () => {
    let n = 0;
    const flaky = async () => {
      n += 1;
      return n < 3
        ? { status: 502, headers: headers({}), text: async () => "bad gateway" }
        : { status: 200, headers: headers(SECURE), text: async () => "<html>" };
    };
    const ok = await runSmoke({
      targets: [{ name: "web", url: "https://staging.kapdh.or.id/" }],
      fetchImpl: flaky,
      sleep: async () => {},
      log: () => {},
    });
    assert.equal(ok.ok, true);
    assert.equal(n, 3);

    let t = 0;
    const down = await runSmoke({
      targets: [{ name: "api", url: "https://staging-api.kapdh.or.id/api/v1/health/ready" }],
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      timeoutMs: 20_000,
      intervalMs: 10_000,
      log: () => {},
    });
    assert.equal(down.ok, false);
    assert.match(down.failing.get("api"), /galat jaringan/);
  });
});

describe("gerbang OSV (N-16)", () => {
  const report = {
    results: [
      {
        source: { path: "kapdh-mobile/pubspec.lock", type: "lockfile" },
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

  it("CVSS >= 9.0 memblokir; tinggi dan tanpa skor menjadi peringatan", () => {
    const list = findings(report);
    assert.equal(list.length, 3);
    const v = evaluate(list);
    assert.equal(v.ok, false);
    assert.deepEqual(
      v.blocking.map((f) => f.package),
      ["dio"],
    );
    assert.deepEqual(v.warnings.map((f) => f.package).sort(), ["http", "yaml"]);
  });

  it("tanpa kerentanan kritis -> lulus; laporan kosong -> lulus", () => {
    const only = { results: [{ ...report.results[0], packages: [report.results[0].packages[1]] }] };
    assert.equal(evaluate(findings(only)).ok, true);
    assert.equal(evaluate(findings({ results: [] })).ok, true);
  });
});
