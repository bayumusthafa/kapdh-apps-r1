// Uji katalog image CI/CD (PRD 5.5: image yang sama dipromosikan; web/admin per lingkungan dari commit yang sama).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMatrix,
  dockerStages,
  loadCatalog,
  main,
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
      ["api", "release", "worker", "web", "admin"],
    );
  });

  it("matrix ci: satu build per image; web/admin memakai varian production yang kelak dipromosikan", () => {
    const { include } = buildMatrix(catalog, "ci");
    assert.deepEqual(
      include.map((e) => e.id),
      ["api", "release", "worker", "web-production", "admin-production"],
    );
    // api dan release dari Dockerfile yang sama, tahap berbeda; image lain memakai tahap terakhir.
    assert.equal(include.find((e) => e.name === "api").target, "api");
    assert.equal(include.find((e) => e.name === "release").target, "release");
    assert.equal(include.find((e) => e.name === "release").dockerfile, "infra/Dockerfile.api");
    assert.equal(include.find((e) => e.name === "worker").target, "");
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
        "kapdh-release",
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
        `ghcr.io/org-kapdh/kapdh-release:sha-${SHA}`,
        `ghcr.io/org-kapdh/kapdh-worker:sha-${SHA}`,
        `ghcr.io/org-kapdh/kapdh-web:sha-${SHA}-production`,
        `ghcr.io/org-kapdh/kapdh-admin:sha-${SHA}-production`,
      ],
    );
    const staging = sourceRefs(catalog, { env: "staging", sha: SHA, registry: "ghcr.io/org-kapdh" });
    assert.equal(staging[0].source, refs[0].source, "api staging = api production (digest sama, PRD 5.5)");
    assert.equal(staging[1].source, refs[1].source, "release staging = release production");
    assert.equal(staging[3].source, `ghcr.io/org-kapdh/kapdh-web:sha-${SHA}-staging`);
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
    broken.images.find((i) => i.name === "admin").build_args = { VITE_API_BASE_URL: "tidak_ada" };
    broken.images.find((i) => i.name === "release").target = "tidak-ada";
    broken.images.find((i) => i.name === "worker").target = "Bukan Nama";
    const errors = validateCatalog(broken, { exists: (p) => p !== "infra/Dockerfile.admin" });
    assert.ok(errors.some((e) => /Dockerfile infra\/Dockerfile.admin tidak ditemukan/.test(e)));
    assert.ok(errors.some((e) => /staging.api_base_url wajib https/.test(e)));
    assert.ok(errors.some((e) => /tidak_ada kosong/.test(e)));
    assert.ok(errors.some((e) => /release: tahap tidak-ada tidak ada di infra\/Dockerfile.api/.test(e)));
    assert.ok(errors.some((e) => /worker: target tidak valid/.test(e)));
  });

  it("tahap Dockerfile dibaca dari baris FROM ... AS", () => {
    assert.deepEqual(
      [
        ...dockerStages(
          "FROM node:24 AS build\nFROM node:24 AS runtime\nFROM runtime AS release\nFROM runtime AS api\n",
        ),
      ],
      ["build", "runtime", "release", "api"],
    );
  });
});

describe("CLI katalog image", () => {
  const run = (argv) => {
    const out = [];
    const code = main(argv, (l) => out.push(l));
    return { code, out };
  };

  it("count dan api-base-url untuk pemeriksaan workflow (_deploy.yml, release.yml)", () => {
    assert.deepEqual(run(["count"]), { code: 0, out: [String(catalog.images.length)] });
    assert.deepEqual(run(["api-base-url", "--env", "production"]), {
      code: 0,
      out: [catalog.environments.production.api_base_url],
    });
    assert.throws(() => run(["api-base-url", "--env", "dev"]), /lingkungan tidak dikenal/);
  });

  it("smoke setiap image memeriksa commit terbakar dan proses bukan root", () => {
    for (const image of catalog.images) {
      assert.match(image.smoke, /KAPDH_EXPECTED_COMMIT/, image.name);
      assert.match(image.smoke, /id -u/, image.name);
    }
  });
});
