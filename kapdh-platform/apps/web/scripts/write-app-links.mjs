// Gerbang pasca-build situs publik: memvalidasi apps/web/app-links.json lalu menulis berkas asosiasi tautan aplikasi
// (Android App Links, iOS Universal Links) ke dist/.well-known/ hanya bila nilainya terisi. Konfigurasi tidak sah
// menggagalkan build; konfigurasi kosong memastikan tidak ada berkas di dist/.well-known/ (nginx menjawab 404).
// Aturan dan bentuk berkas ada di app-links.mjs.
//
//   node scripts/write-app-links.mjs [--config <app-links.json>] [--dist <direktori dist>]
//
// Argumen untuk uji (src/lib/app-links.test.ts) dan langkah CI compose-stack (fixture infra/ci/test/fixtures/app-links.uji.json);
// build memakai bawaan apps/web/app-links.json dan apps/web/dist.
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AASA_PATH, ASSETLINKS_PATH, renderAppLinkFiles, validateAppLinks } from "./app-links.mjs";
import { DIST } from "./dist-html.mjs";

const { values } = parseArgs({ options: { config: { type: "string" }, dist: { type: "string" } } });
const configPath = values.config ?? fileURLToPath(new URL("../app-links.json", import.meta.url));
const dist = values.dist ?? DIST;

/** @param {string[]} lines @param {string} summary @returns {never} */
function fail(lines, summary) {
  for (const line of lines) console.error(line);
  console.error(`Gerbang tautan aplikasi gagal: ${summary}`);
  process.exit(1);
}

/** @type {unknown} */
let config;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  fail(
    [`${configPath}: ${error instanceof Error ? error.message : String(error)}`],
    "app-links.json bukan JSON.",
  );
}
const problems = validateAppLinks(config);
if (problems.length > 0) {
  fail(
    problems.map((problem) => `app-links.json: ${problem}`),
    "perbaiki apps/web/app-links.json (panduan nilai di $comment).",
  );
}

try {
  await stat(join(dist, "index.html"));
} catch {
  fail([`${dist}: index.html tidak ada`], "dist kosong: jalankan astro build lebih dahulu.");
}

const files = renderAppLinkFiles(config);
const managed = [ASSETLINKS_PATH, AASA_PATH];
const wellKnown = join(dist, ".well-known");
// nginx hanya melayani dua berkas ini di /.well-known/ (location persis); berkas lain di sana selalu 404, jadi
// keberadaannya hampir pasti kekeliruan (mis. diletakkan di public/.well-known/).
const strays = (await readdir(wellKnown).catch(() => []))
  .map((name) => `.well-known/${name}`)
  .filter((path) => !managed.includes(path));
if (strays.length > 0) {
  fail(
    strays.map((path) => `dist/${path}: tidak pernah dilayani nginx (hanya ${managed.join(" dan ")})`),
    "hapus berkas lain dari dist/.well-known/.",
  );
}

const reasons = {
  [ASSETLINKS_PATH]: "sidik sertifikat Android belum diisi",
  [AASA_PATH]: "Team ID Apple belum diisi",
};
for (const path of managed) {
  const target = join(dist, path);
  const body = files.get(path);
  if (body === undefined) {
    await rm(target, { force: true });
    console.log(`Tautan aplikasi: /${path} tidak diterbitkan (404): ${reasons[path]} di app-links.json.`);
  } else {
    await mkdir(wellKnown, { recursive: true });
    await writeFile(target, body, "utf8");
    console.log(`Tautan aplikasi: dist/${path} ditulis (${Buffer.byteLength(body, "utf8")} byte).`);
  }
}
if (files.size === 0) await rm(wellKnown, { recursive: true, force: true });
