#!/usr/bin/env node
// Manifest rilis aplikasi (PRD 9.3 paket penerimaan: image API/worker/web, OpenAPI dan SDK, schema/migrasi; PRD 5.5:
// versi image dan versi skema harus dapat dihubungkan oleh manifest backup). Dilampirkan ke GitHub Release oleh
// .github/workflows/release.yml.
//
//   node infra/ci/release-manifest.mjs --tag v1.0.0 --sha <40 hex> --digests <tsv nama/repo/digest> \
//        --out release-manifest.json --notes release-notes.md
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_ROOT } from "./images.mjs";

const TAG_RE = /^v(\d+\.\d+\.\d+(?:-rc\.\d+)?)$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Membaca baris `nama<TAB>repositori<TAB>digest`. */
export function parseDigests(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, repository, digest] = line.split("\t");
      if (!name || !repository || !DIGEST_RE.test(digest ?? ""))
        throw new Error(`baris digest tidak valid: ${line}`);
      return { name, repository, digest, ref: `${repository}@${digest}` };
    });
}

/** Metadata dari repo: versi kontrak, versi aplikasi minimum, migrasi terakhir. */
export function repoFacts(root = PLATFORM_ROOT) {
  const contractsPkg = JSON.parse(readFileSync(join(root, "packages/contracts/package.json"), "utf8"));
  const rootYaml = readFileSync(join(root, "packages/contracts/openapi/root.yaml"), "utf8");
  const minApp = /^\s+x-kapdh-min-app-version:\s*["']?([0-9][^"'\s]*)["']?\s*$/m.exec(rootYaml)?.[1] ?? null;
  const journal = JSON.parse(
    readFileSync(join(root, "packages/database/migrations/meta/_journal.json"), "utf8"),
  );
  const entries = journal.entries ?? [];
  return {
    contracts: { version: contractsPkg.version, min_app_version: minApp },
    database: { latest_migration: entries.at(-1)?.tag ?? null, migrations: entries.length },
  };
}

export function buildManifest({ tag, sha, images, facts, createdAt = new Date().toISOString() }) {
  const m = TAG_RE.exec(tag ?? "");
  if (!m) throw new Error(`tag rilis harus vX.Y.Z atau vX.Y.Z-rc.N: ${tag}`);
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("sha commit tidak valid");
  if (images.length === 0) throw new Error("manifest tanpa image");
  return {
    schema: "kapdh-release-manifest/1",
    version: m[1],
    tag,
    commit: sha,
    created_at: createdAt,
    images,
    contracts: facts.contracts,
    database: facts.database,
  };
}

export function renderNotes(manifest) {
  const rows = manifest.images.map((i) => `| ${i.name} | \`${i.repository}\` | \`${i.digest}\` |`);
  return [
    `Rilis ${manifest.tag} dari commit \`${manifest.commit}\`.`,
    "",
    "Image dipromosikan dengan digest yang sama dari build CI yang sudah lulus staging (PRD 5.5); tidak ada build ulang.",
    "",
    "| Image | Repositori | Digest |",
    "| --- | --- | --- |",
    ...rows,
    "",
    `Kontrak ${manifest.contracts.version} (aplikasi minimum ${manifest.contracts.min_app_version ?? "-"}); ` +
      `migrasi skema terakhir \`${manifest.database.latest_migration}\` (${manifest.database.migrations} migrasi).`,
    "",
    "Deploy production menunggu persetujuan environment `production` (gerbang rilis PRD 9.3); urutan dan rollback: " +
      "docs/runbooks/ci-cd.md.",
  ].join("\n");
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  const images = parseDigests(readFileSync(arg(argv, "--digests"), "utf8"));
  const manifest = buildManifest({
    tag: arg(argv, "--tag"),
    sha: arg(argv, "--sha"),
    images,
    facts: repoFacts(),
  });
  writeFileSync(arg(argv, "--out"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (arg(argv, "--notes")) writeFileSync(arg(argv, "--notes"), `${renderNotes(manifest)}\n`);
  console.log(
    `Manifest ${manifest.tag}: ${images.length} image, migrasi ${manifest.database.latest_migration}.`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`::error title=release-manifest::${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
