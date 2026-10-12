#!/usr/bin/env node
// Menggabungkan openapi/root.yaml + openapi/domains/*.yaml menjadi dist/openapi.yaml (ARCHITECTURE §6).
// Gagal (exit 1) bila ada path, operationId, tag atau komponen ganda, $ref yang tidak ditemukan,
// atau domain yang memakai tag milik domain lain. Keluaran deterministik (urutan berkas domain alfabetis).
//
// Pemakaian: node scripts/assemble.mjs [--src <dir openapi>] [--out <berkas>]
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { assemble, HTTP_METHODS } from "./lib/assemble.mjs";
import { PATHS, rel, writeIfChanged } from "./lib/fs.mjs";

const HEADER = `# DIBANGKITKAN oleh packages/contracts/scripts/assemble.mjs dari openapi/root.yaml dan
# openapi/domains/*.yaml. JANGAN DISUNTING; ubah berkas sumbernya lalu jalankan \`pnpm contracts:gen\`.
`;

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : fallback;
}

function parseYaml(file) {
  try {
    return parse(readFileSync(file, "utf8"), { prettyErrors: true });
  } catch (error) {
    throw new Error(
      `${rel(file)}: YAML tidak valid\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function loadSources(srcDir) {
  const root = parseYaml(join(srcDir, "root.yaml"));
  const domainDir = join(srcDir, "domains");
  const files = readdirSync(domainDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  return {
    root,
    domains: files.map((file) => ({ file: `domains/${file}`, doc: parseYaml(join(domainDir, file)) })),
  };
}

export function renderBundle(doc) {
  return HEADER + stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srcDir = argValue("--src", PATHS.openapiDir);
  const out = argValue("--out", PATHS.bundle);
  try {
    const { doc, errors, warnings } = assemble(loadSources(srcDir));
    for (const w of warnings) console.warn(`peringatan: ${w}`);
    if (errors.length > 0) {
      console.error(`Kontrak tidak dapat digabungkan (${errors.length} galat):`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    const changed = writeIfChanged(out, renderBundle(doc));
    const ops = Object.values(doc.paths).reduce(
      (n, item) => n + Object.keys(item).filter((k) => HTTP_METHODS.includes(k)).length,
      0,
    );
    console.log(
      `${rel(out)} ${changed ? "ditulis" : "tidak berubah"}: ${doc.tags.length} tag, ` +
        `${Object.keys(doc.paths).length} path, ${ops} operasi, ` +
        `${Object.keys(doc.components.schemas ?? {}).length} skema.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
