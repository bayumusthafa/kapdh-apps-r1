// Uji pemicu deploy Coolify (PRD 5.5): validasi URL rahasia, antrean deployment, penantian status, tanpa kebocoran.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main, parseDeployUrl, triggerDeploy, waitForDeployments } from "../coolify-deploy.mjs";

const URL_OK = "https://coolify.kapdh.or.id/api/v1/deploy?uuid=aaaaaaaa1111,bbbbbbbb2222&force=false";
const TOKEN = "rahasia-token-uji-123";

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

/** fetch palsu: memutar urutan status per deployment dan mencatat permintaan. */
function fakeCoolify(statuses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    const u = new URL(String(url));
    if (u.pathname.endsWith("/deploy"))
      return response(200, {
        deployments: [
          { message: "queued", resource_uuid: "aaaaaaaa1111", deployment_uuid: "dep-api-0001" },
          { message: "queued", resource_uuid: "bbbbbbbb2222", deployment_uuid: "dep-web-0002" },
        ],
      });
    const id = decodeURIComponent(u.pathname.split("/").pop());
    const queue = statuses[id];
    return response(200, { status: queue.length > 1 ? queue.shift() : queue[0] });
  };
  return { calls, fetchImpl };
}

const noSleep = async () => {};

describe("deploy Coolify", () => {
  it("URL deploy divalidasi: https, endpoint /api/v1/deploy, uuid atau tag, tanpa kredensial", () => {
    const p = parseDeployUrl(URL_OK);
    assert.deepEqual(p.resources, ["aaaaaaaa1111", "bbbbbbbb2222"]);
    assert.equal(p.apiBase, "https://coolify.kapdh.or.id/api/v1");
    assert.throws(() => parseDeployUrl("http://coolify.kapdh.or.id/api/v1/deploy?uuid=a"), /https/);
    assert.throws(() => parseDeployUrl("https://coolify.kapdh.or.id/webhooks/x?uuid=a"), /\/api\/v1\/deploy/);
    assert.throws(() => parseDeployUrl("https://coolify.kapdh.or.id/api/v1/deploy"), /uuid=/);
    assert.throws(() => parseDeployUrl("https://u:p@coolify.kapdh.or.id/api/v1/deploy?uuid=a"), /kredensial/);
    assert.throws(() => parseDeployUrl("bukan url"), /bukan URL/);
  });

  it("galat validasi tidak pernah memuat URL rahasia", () => {
    try {
      parseDeployUrl("http://rahasia.example/api/v1/deploy?uuid=sangat-rahasia");
      assert.fail("harus gagal");
    } catch (e) {
      assert.doesNotMatch(e.message, /sangat-rahasia|rahasia\.example/);
    }
  });

  it("deploy diantrekan dengan Bearer token lalu ditunggu sampai semua finished", async () => {
    const { calls, fetchImpl } = fakeCoolify({
      "dep-api-0001": ["queued", "in_progress", "finished"],
      "dep-web-0002": ["in_progress", "finished"],
    });
    const { url, apiBase } = parseDeployUrl(URL_OK);
    const deployments = await triggerDeploy({ url, token: TOKEN, fetchImpl });
    const logs = [];
    const result = await waitForDeployments({
      apiBase,
      token: TOKEN,
      deployments,
      fetchImpl,
      sleep: noSleep,
      log: (l) => logs.push(l),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.results.map((r) => r.status),
      ["finished", "finished"],
    );
    assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
    assert.ok(calls.some((c) => c.url === "https://coolify.kapdh.or.id/api/v1/deployments/dep-api-0001"));
    assert.ok(logs.every((l) => !l.includes(TOKEN)));
  });

  it("deployment gagal atau habis waktu -> tidak ok", async () => {
    const failed = fakeCoolify({ "dep-api-0001": ["failed"], "dep-web-0002": ["finished"] });
    const { url, apiBase } = parseDeployUrl(URL_OK);
    const deployments = await triggerDeploy({ url, token: TOKEN, fetchImpl: failed.fetchImpl });
    const r1 = await waitForDeployments({
      apiBase,
      token: TOKEN,
      deployments,
      fetchImpl: failed.fetchImpl,
      sleep: noSleep,
      log: () => {},
    });
    assert.equal(r1.ok, false);

    const stuck = fakeCoolify({ "dep-api-0001": ["in_progress"], "dep-web-0002": ["finished"] });
    let t = 0;
    const r2 = await waitForDeployments({
      apiBase,
      token: TOKEN,
      deployments,
      fetchImpl: stuck.fetchImpl,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      timeoutMs: 30_000,
      intervalMs: 10_000,
      log: () => {},
    });
    assert.equal(r2.ok, false);
    assert.match(r2.results.find((r) => !r.ok).status, /timeout/);
  });

  it("deployment tanpa deployment_uuid (tidak dapat dipantau) -> GAGAL, bukan dianggap sukses", async () => {
    const { apiBase } = parseDeployUrl(URL_OK);
    const ok = fakeCoolify({ "dep-api-0001": ["finished"] });
    const logs = [];
    const r = await waitForDeployments({
      apiBase,
      token: TOKEN,
      deployments: [
        { message: "queued", resource_uuid: "aaaaaaaa1111", deployment_uuid: "dep-api-0001" },
        { message: "Service deployed", resource_uuid: "bbbbbbbb2222" },
      ],
      fetchImpl: ok.fetchImpl,
      sleep: noSleep,
      log: (l) => logs.push(l),
    });
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.results.map((x) => [x.status, x.ok]),
      [
        ["unmonitored", false],
        ["finished", true],
      ],
    );
    assert.ok(logs.some((l) => l.startsWith("::error::")));
  });

  it("Coolify menolak (401) -> galat tanpa token; main --dry-run tidak mengirim permintaan", async () => {
    const { url } = parseDeployUrl(URL_OK);
    await assert.rejects(
      triggerDeploy({
        url,
        token: TOKEN,
        fetchImpl: async () => response(401, { message: "Unauthenticated." }),
      }),
      (e) => /HTTP 401/.test(e.message) && !e.message.includes(TOKEN),
    );
    let called = false;
    const code = await main({
      argv: ["--dry-run"],
      env: { COOLIFY_DEPLOY_URL: URL_OK, COOLIFY_API_TOKEN: TOKEN },
      fetchImpl: async () => {
        called = true;
        return response(200, {});
      },
      log: () => {},
    });
    assert.equal(code, 0);
    assert.equal(called, false);
    await assert.rejects(
      main({ argv: [], env: { COOLIFY_DEPLOY_URL: URL_OK }, log: () => {} }),
      /TOKEN kosong/,
    );
  });
});
