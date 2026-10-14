// Uji katalog image CI/CD (PRD 5.5: image yang sama dipromosikan; web/admin per lingkungan dari commit yang sama).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMatrix,
  loadCatalog,
  normalizeRegistry,
  shaTag,
  sourceRefs,
  validateCatalog,
} from "../images.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const catalog = loadCatalog();

describe("katalog image", () => {
  it("katalog nyata valid dan setiap Dockerfile ada di kapdh-platform/infra", () => {
    assert.deepEqual(validateCatalog(catalog), []);
    assert.deepEqual(
      catalog.images.map((i) => i.name),
      ["api", "worker", "web", "admin"],
    );
  });

  it("matrix ci: satu build per image; web/admin memakai varian production yang kelak dipromosikan", () => {
    const { include } = buildMatrix(catalog, "ci");
    assert.deepEqual(
      include.map((e) => e.id),
      ["api", "worker", "web-production", "admin-production"],
    );
    const web = include.find((e) => e.name === "web");
    assert.equal(web.build_args, "PUBLIC_API_URL=https://api.kapdh.or.id/api/v1");
    assert.equal(
      include.find((e) => e.name === "admin").build_args,
      "VITE_API_BASE_URL=https://api.kapdh.or.id/api/v1",
    );
    assert.equal(include.find((e) => e.name === "api").build_args, "");
  });

  it("matrix publish: api/worker sekali, web/admin untuk staging dan production", () => {
    const { include } = buildMatrix(catalog, "publish");
    assert.deepEqual(
      include.map((e) => `${e.image}${e.tag_suffix}`),
      [
        "kapdh-api",
        "kapdh-worker",
        "kapdh-web-staging",
        "kapdh-web-production",
        "kapdh-admin-staging",
        "kapdh-admin-production",
      ],
    );
    const webStaging = include.find((e) => e.id === "web-staging");
    assert.equal(webStaging.build_args, "PUBLIC_API_URL=https://staging-api.kapdh.or.id/api/v1");
  });

  it("refs: production memakai digest sha yang sama untuk api/worker dan varian -production untuk web/admin", () => {
    const refs = sourceRefs(catalog, { env: "production", sha: SHA, registry: "ghcr.io/Org-KAPDH/" });
    assert.deepEqual(
      refs.map((r) => r.source),
      [
        `ghcr.io/org-kapdh/kapdh-api:sha-${SHA}`,
        `ghcr.io/org-kapdh/kapdh-worker:sha-${SHA}`,
        `ghcr.io/org-kapdh/kapdh-web:sha-${SHA}-production`,
        `ghcr.io/org-kapdh/kapdh-admin:sha-${SHA}-production`,
      ],
    );
    const staging = sourceRefs(catalog, { env: "staging", sha: SHA, registry: "ghcr.io/org-kapdh" });
    assert.equal(staging[0].source, refs[0].source, "api staging = api production (digest sama, PRD 5.5)");
    assert.equal(staging[2].source, `ghcr.io/org-kapdh/kapdh-web:sha-${SHA}-staging`);
  });

  it("input tidak sah ditolak", () => {
    assert.throws(() => shaTag("abc"), /40 heksadesimal/);
    assert.throws(() => shaTag(SHA.toUpperCase()), /40 heksadesimal/);
    assert.throws(() => normalizeRegistry("ghcr.io"), /registry tidak valid/);
    assert.throws(() => normalizeRegistry("ghcr.io/owner;rm -rf"), /registry tidak valid/);
    assert.throws(() => sourceRefs(catalog, { env: "dev", sha: SHA, registry: "ghcr.io/o" }), /lingkungan/);
    assert.throws(() => buildMatrix(catalog, "x"), /mode matrix/);
  });

  it("validasi menangkap Dockerfile hilang, URL non-https dan build arg tanpa nilai", () => {
    const broken = structuredClone(catalog);
    broken.environments.staging.api_base_url = "http://staging-api.kapdh.or.id/api/v1";
    broken.images[3].build_args = { VITE_API_BASE_URL: "tidak_ada" };
    const errors = validateCatalog(broken, { exists: (p) => p !== "infra/Dockerfile.admin" });
    assert.ok(errors.some((e) => /Dockerfile infra\/Dockerfile.admin tidak ditemukan/.test(e)));
    assert.ok(errors.some((e) => /staging.api_base_url wajib https/.test(e)));
    assert.ok(errors.some((e) => /tidak_ada kosong/.test(e)));
  });
});
