// Utilitas berkas untuk generator kontrak (ARCHITECTURE §6).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Akar paket @kapdh/contracts. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Akar monorepo kapdh-platform. */
export const PLATFORM_ROOT = resolve(PACKAGE_ROOT, "../..");

export const PATHS = {
  openapiDir: join(PACKAGE_ROOT, "openapi"),
  bundle: join(PACKAGE_ROOT, "dist", "openapi.yaml"),
  tsOut: join(PACKAGE_ROOT, "src", "generated", "api.ts"),
  tsRealtimeOut: join(PACKAGE_ROOT, "src", "generated", "realtime.ts"),
  tsEnumsOut: join(PACKAGE_ROOT, "src", "generated", "enums.ts"),
  eventsDir: join(PACKAGE_ROOT, "events"),
  dartPackage: join(PACKAGE_ROOT, "dart", "kapdh_api"),
  dartSrc: join(PACKAGE_ROOT, "dart", "kapdh_api", "lib", "src"),
  sharedSrc: join(PLATFORM_ROOT, "packages", "shared", "src"),
};

/**
 * Menulis berkas hanya bila isinya berubah, secara atomik (tulis berkas sementara lalu rename).
 * Mencegah pembaca paralel (turbo menjalankan build/typecheck/lint bersamaan) membaca berkas setengah jadi,
 * dan menjaga mtime tetap bila hasil generator identik.
 * @returns {boolean} true bila berkas ditulis.
 */
export function writeIfChanged(file, content) {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
  return true;
}

/** Semua berkas (rekursif) di bawah dir, path relatif dengan pemisah "/". */
export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Menyelaraskan isi direktori keluaran dengan peta {pathRelatif: isi}: menulis yang berubah dan menghapus
 * berkas lama yang tidak lagi dibangkitkan (mis. kelas API untuk tag yang dihapus).
 */
export function syncDirectory(dir, files) {
  let written = 0;
  let removed = 0;
  for (const [rel, content] of Object.entries(files)) {
    if (writeIfChanged(join(dir, rel), content)) written += 1;
  }
  for (const rel of listFiles(dir)) {
    if (!(rel in files)) {
      rmSync(join(dir, rel));
      removed += 1;
    }
  }
  return { written, removed };
}

/** Path relatif terhadap akar monorepo untuk pesan log. */
export function rel(file) {
  return relative(PLATFORM_ROOT, file).split("\\").join("/");
}
