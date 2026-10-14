// Uji asap HTTP sesudah deploy (PRD 5.5, 8.3): readiness, header keamanan, dan commit image yang benar-benar berjalan.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commitUrl, judge, judgeCommit, parseTargets, runSmoke } from "../smoke.mjs";

const headers = (h) => new Headers(h);
const SECURE = { "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff" };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD = "fedcba9876543210fedcba9876543210fedcba98";

describe("uji asap", () => {
  it("target wajib nama=url https", () => {
    assert.deepEqual(parseTargets(["api=https://staging-api.kapdh.or.id/api/v1/health/ready"]), [
      { name: "api", url: "https://staging-api.kapdh.or.id/api/v1/health/ready" },
    ]);
    assert.throws(() => parseTargets(["web=http://staging.kapdh.or.id/"]), /https/);
    assert.throws(() => parseTargets(["tanpa-url"]), /nama=url/);
    assert.throws(() => parseTargets([]), /tidak ada target/);
  });

  it("dengan --expect-commit: api memeriksa /health, web/admin memeriksa /version.json", () => {
    const targets = parseTargets(
      [
        "api=https://staging-api.kapdh.or.id/api/v1/health/ready",
        "web=https://staging.kapdh.or.id/",
        "admin=https://staging-admin.kapdh.or.id",
      ],
      { expectCommit: SHA },
    );
    assert.deepEqual(
      targets.map((t) => t.commitUrl),
      [
        "https://staging-api.kapdh.or.id/api/v1/health",
        "https://staging.kapdh.or.id/version.json",
        "https://staging-admin.kapdh.or.id/version.json",
      ],
    );
    assert.throws(
      () => commitUrl({ name: "api", url: "https://api.kapdh.or.id/api/v1/health" }),
      /health\/ready/,
    );
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

  it("commit image wajib sama persis; kontainer lama atau tanpa commit gagal", () => {
    assert.equal(judgeCommit(200, JSON.stringify({ status: "ok", commit: SHA }), SHA), null);
    assert.match(judgeCommit(200, JSON.stringify({ commit: OLD }), SHA), /fedcba987654 != 0123456789ab/);
    assert.match(judgeCommit(200, JSON.stringify({ status: "ok", commit: null }), SHA), /tidak dilaporkan/);
    assert.match(judgeCommit(404, "", SHA), /HTTP 404/);
    assert.match(judgeCommit(200, "<html>", SHA), /bukan JSON/);
  });

  it("readiness lulus tetapi kontainer lama masih melayani: menunggu lalu gagal saat habis waktu", async () => {
    let t = 0;
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.endsWith("/health/ready"))
        return { status: 200, headers: headers({}), text: async () => JSON.stringify({ status: "ok" }) };
      return {
        status: 200,
        headers: headers({}),
        text: async () => JSON.stringify({ status: "ok", commit: OLD }),
      };
    };
    const r = await runSmoke({
      targets: parseTargets(["api=https://staging-api.kapdh.or.id/api/v1/health/ready"], {
        expectCommit: SHA,
      }),
      expectCommit: SHA,
      fetchImpl,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      timeoutMs: 30_000,
      intervalMs: 10_000,
      log: () => {},
    });
    assert.equal(r.ok, false);
    assert.match(r.failing.get("api"), /kontainer lama/);
  });

  it("kontainer baru siap setelah beberapa percobaan: lulus dengan commit yang sama", async () => {
    let n = 0;
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.endsWith("/version.json")) {
        n += 1;
        return {
          status: 200,
          headers: headers({}),
          text: async () => JSON.stringify({ commit: n < 3 ? OLD : SHA }),
        };
      }
      return { status: 200, headers: headers(SECURE), text: async () => "<html>" };
    };
    const r = await runSmoke({
      targets: parseTargets(["web=https://staging.kapdh.or.id/"], { expectCommit: SHA }),
      expectCommit: SHA,
      fetchImpl,
      sleep: async () => {},
      log: () => {},
    });
    assert.equal(r.ok, true);
    assert.equal(n, 3);
    await assert.rejects(
      runSmoke({ targets: [], expectCommit: "bukan-sha", fetchImpl, log: () => {} }),
      /40 heksadesimal/,
    );
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
