// HTML hasil build apps/web/dist untuk gerbang pasca-build (assert-csp-safe.mjs, assert-static-content.mjs).
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

/** @param {string} dir @returns {Promise<string[]>} */
async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return htmlFiles(path);
      return Promise.resolve(e.name.endsWith(".html") ? [path] : []);
    }),
  );
  return nested.flat();
}

/**
 * Seluruh HTML di dist/ sebagai Map path relatif bergaya URL ("index.html", "tentang/index.html") ke isinya,
 * diurutkan menurut path.
 * @param {string} [dist]
 * @returns {Promise<Map<string, string>>}
 */
export async function readDistHtml(dist = DIST) {
  /** @type {Map<string, string>} */
  const pages = new Map();
  for (const file of (await htmlFiles(dist)).sort()) {
    pages.set(relative(dist, file).split(sep).join("/"), await readFile(file, "utf8"));
  }
  return pages;
}
