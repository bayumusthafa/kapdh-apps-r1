// Uji kebijakan URL API image admin (infra/scripts/admin-csp.mjs; N-07, PRD 5.2): render CSP dan build arg
// infra/Dockerfile.admin harus menerima himpunan URL yang sama (hanya https://<host>/api/v1), agar tidak ada cabang
// yang mati di salah satunya.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { API_ORIGIN_PLACEHOLDER, apiOriginOf, renderAdminConf } from "../../scripts/admin-csp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INFRA = join(HERE, "..", "..");

describe("admin-csp.mjs: origin API untuk CSP admin", () => {
  it("menerima https://<host>/api/v1 production dan staging", () => {
    assert.equal(apiOriginOf("https://api.kapdh.or.id/api/v1"), "https://api.kapdh.or.id");
    assert.equal(apiOriginOf("https://staging-api.kapdh.or.id/api/v1"), "https://staging-api.kapdh.or.id");
  });

  it("menolak http (termasuk localhost), kredensial, query, fragmen dan path selain /api/v1", () => {
    for (const bad of [
      "http://api.kapdh.or.id/api/v1",
      "http://localhost:3000/api/v1",
      "http://127.0.0.1:3000/api/v1",
      "https://user:sandi@api.kapdh.or.id/api/v1",
      "https://api.kapdh.or.id/api/v1?x=1",
      "https://api.kapdh.or.id/api/v1#x",
      "https://api.kapdh.or.id/",
      "https://api.kapdh.or.id/lain/api/v1",
      "bukan-url",
    ])
      assert.throws(() => apiOriginOf(bad), /VITE_API_BASE_URL/, bad);
  });

  it("render mengganti placeholder dengan origin persis; templat nginx-admin.conf memuat placeholder", () => {
    const template = readFileSync(join(INFRA, "nginx-admin.conf"), "utf8");
    assert.ok(template.includes(API_ORIGIN_PLACEHOLDER));
    const conf = renderAdminConf(template, "https://staging-api.kapdh.or.id/api/v1");
    assert.ok(!conf.includes(API_ORIGIN_PLACEHOLDER));
    assert.match(conf, /connect-src 'self' https:\/\/staging-api\.kapdh\.or\.id[;" ]/);
  });

  it("Dockerfile.admin memeriksa build arg dengan pola yang sama (https://*/api/v1) sebelum render", () => {
    const dockerfile = readFileSync(join(INFRA, "Dockerfile.admin"), "utf8");
    assert.match(dockerfile, /case "\$VITE_API_BASE_URL" in \\\r?\n\s+https:\/\/\*\/api\/v1\) ;; \\/);
    assert.ok(
      dockerfile.indexOf("https://*/api/v1)") < dockerfile.indexOf("node infra/scripts/admin-csp.mjs render"),
    );
  });
});
