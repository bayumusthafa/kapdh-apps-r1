// Berkas asosiasi tautan aplikasi KAPDH (Android App Links, iOS Universal Links) untuk https://kapdh.or.id/app/...
// dari apps/web/app-links.json. Modul murni tanpa fs: dipakai write-app-links.mjs setelah astro build dan diuji
// src/lib/app-links.test.ts. nginx hanya melayani dua berkas ini di /.well-known/ (infra/nginx-web.conf); konfigurasi
// kosong berarti berkas tidak ditulis sehingga keduanya 404.

/** Path relatif dist/ yang dilayani location persis di infra/nginx-web.conf. */
export const ASSETLINKS_PATH = ".well-known/assetlinks.json";
export const AASA_PATH = ".well-known/apple-app-site-association";
/** Batas Apple untuk apple-app-site-association (128 KB tanpa kompresi); berlaku juga untuk assetlinks.json. */
export const MAX_FILE_BYTES = 128 * 1024;

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
// Nama paket Android: reverse-DNS minimal dua segmen, tiap segmen diawali huruf kecil (huruf kecil, angka, _).
const PACKAGE_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
// Bundle ID iOS: reverse-DNS minimal dua segmen (huruf, angka, tanda hubung).
const BUNDLE_ID = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const WEB_PREFIX = "/app";

// Nilai contoh dokumentasi yang sering tersalin apa adanya: sidik di panduan App Links developer.android.com dan Team
// ID di panduan Universal Links Apple, ditambah deret yang jelas bukan Team ID.
const SAMPLE_FINGERPRINTS = new Set([
  "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5",
]);
const SAMPLE_TEAM_IDS = new Set(["ABCDE12345", "1234567890", "0987654321"]);

/**
 * @typedef {object} AppLinksConfig
 * @property {string} [$comment]
 * @property {{ package_name: string, sha256_cert_fingerprints: string[] }} android
 * @property {{ app_id_prefix: string | null, bundle_id: string }} ios
 * @property {string[]} paths
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Kunci yang tidak dikenal (salah ketik tidak boleh diam-diam diabaikan). */
function unknownKeys(
  /** @type {Record<string, unknown>} */ value,
  /** @type {string[]} */ allowed,
  /** @type {string} */ where,
) {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}${key}: kunci tidak dikenal`);
}

/**
 * Deret byte yang jelas bukan SHA-256 sertifikat: pola berulang pendek (periode <= 4 byte, termasuk semua byte sama)
 * atau deret aritmetika (00:01:02:..., FF:FE:FD:...).
 * @param {number[]} bytes
 */
function patterned(bytes) {
  for (let period = 1; period <= 4; period += 1) {
    if (bytes.every((b, i) => b === bytes[i % period])) return true;
  }
  const step = (bytes[1] - bytes[0] + 256) % 256;
  return bytes.every((b, i) => i === 0 || (b - bytes[i - 1] + 256) % 256 === step);
}

/** @param {string} fingerprint sudah lolos FINGERPRINT */
function placeholderFingerprint(fingerprint) {
  if (SAMPLE_FINGERPRINTS.has(fingerprint)) return true;
  return patterned(fingerprint.split(":").map((pair) => Number.parseInt(pair, 16)));
}

/** @param {string} teamId sudah lolos TEAM_ID */
function placeholderTeamId(teamId) {
  if (SAMPLE_TEAM_IDS.has(teamId) || /TEAM|XXXX/.test(teamId)) return true;
  const codes = [...teamId].map((c) => c.charCodeAt(0));
  // Semua karakter sama (AAAAAAAAAA) atau berurutan naik/turun (ABCDEFGHIJ, 0123456789).
  return [0, 1, -1].some((step) => codes.every((c, i) => i === 0 || c - codes[i - 1] === step));
}

/** @param {unknown} path @returns {string | null} alasan bila tidak sah */
function pathProblem(path) {
  if (typeof path !== "string") return "harus teks";
  if (path === WEB_PREFIX) return null;
  if (!path.startsWith(`${WEB_PREFIX}/`)) return `wajib "${WEB_PREFIX}" atau di bawah "${WEB_PREFIX}/"`;
  const segments = path.slice(WEB_PREFIX.length + 1).split("/");
  for (const [i, segment] of segments.entries()) {
    if (segment === "*" && i === segments.length - 1) continue;
    if (!PATH_SEGMENT.test(segment) || segment === "." || segment === "..") {
      return 'segmen hanya huruf, angka, "._~-" (bukan "." atau ".."); "*" hanya sebagai segmen terakhir';
    }
  }
  return null;
}

/**
 * Pelanggaran konfigurasi app-links.json (kosong = sah). Pesan berbahasa Indonesia untuk keluaran build.
 * @param {unknown} config
 * @returns {string[]}
 */
export function validateAppLinks(config) {
  if (!isObject(config)) return ["app-links.json harus objek JSON"];
  /** @type {string[]} */
  const problems = unknownKeys(config, ["$comment", "android", "ios", "paths"], "");
  if ("$comment" in config && typeof config.$comment !== "string") problems.push("$comment: harus teks");

  const android = config.android;
  if (!isObject(android)) {
    problems.push("android: wajib objek { package_name, sha256_cert_fingerprints }");
  } else {
    problems.push(...unknownKeys(android, ["package_name", "sha256_cert_fingerprints"], "android."));
    if (typeof android.package_name !== "string" || !PACKAGE_NAME.test(android.package_name)) {
      problems.push("android.package_name: wajib nama paket reverse-DNS seperti id.or.kapdh.app");
    }
    const fingerprints = android.sha256_cert_fingerprints;
    if (!Array.isArray(fingerprints)) {
      problems.push(
        "android.sha256_cert_fingerprints: wajib daftar (kosong = assetlinks.json tidak diterbitkan)",
      );
    } else {
      const seen = new Set();
      for (const [i, fingerprint] of fingerprints.entries()) {
        const where = `android.sha256_cert_fingerprints[${i}]`;
        if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) {
          problems.push(`${where}: wajib 32 pasang heksadesimal huruf besar dipisah titik dua (AB:CD:...)`);
          continue;
        }
        if (seen.has(fingerprint)) problems.push(`${where}: duplikat`);
        seen.add(fingerprint);
        if (placeholderFingerprint(fingerprint)) {
          problems.push(
            `${where}: nilai contoh/placeholder, bukan sidik sertifikat penandatanganan aplikasi`,
          );
        }
      }
    }
  }

  const ios = config.ios;
  if (!isObject(ios)) {
    problems.push("ios: wajib objek { app_id_prefix, bundle_id }");
  } else {
    problems.push(...unknownKeys(ios, ["app_id_prefix", "bundle_id"], "ios."));
    const prefix = ios.app_id_prefix;
    if (prefix !== null && (typeof prefix !== "string" || !TEAM_ID.test(prefix))) {
      problems.push("ios.app_id_prefix: wajib null atau Team ID Apple (10 huruf besar/angka)");
    } else if (typeof prefix === "string" && placeholderTeamId(prefix)) {
      problems.push("ios.app_id_prefix: nilai contoh/placeholder, bukan Team ID Apple Developer");
    }
    if (typeof ios.bundle_id !== "string" || !BUNDLE_ID.test(ios.bundle_id)) {
      problems.push("ios.bundle_id: wajib bundle ID reverse-DNS seperti id.or.kapdh.app");
    }
  }

  const paths = config.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    problems.push(`paths: wajib daftar tidak kosong, mis. ["${WEB_PREFIX}", "${WEB_PREFIX}/*"]`);
  } else {
    const seen = new Set();
    for (const [i, path] of paths.entries()) {
      const problem = pathProblem(path);
      if (problem) problems.push(`paths[${i}] ${JSON.stringify(path)}: ${problem}`);
      else if (seen.has(path)) problems.push(`paths[${i}] ${JSON.stringify(path)}: duplikat`);
      seen.add(path);
    }
  }
  return problems;
}

/**
 * Isi assetlinks.json (JSON ringkas), atau null bila belum ada sidik sertifikat. `config` sudah lolos
 * validateAppLinks.
 * @param {AppLinksConfig} config
 * @returns {string | null}
 */
export function renderAssetLinks(config) {
  const fingerprints = config.android.sha256_cert_fingerprints;
  if (fingerprints.length === 0) return null;
  return JSON.stringify([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: config.android.package_name,
        sha256_cert_fingerprints: [...fingerprints],
      },
    },
  ]);
}

/**
 * Isi apple-app-site-association (format components iOS 13+, JSON ringkas), atau null bila Team ID belum diisi.
 * `config` sudah lolos validateAppLinks.
 * @param {AppLinksConfig} config
 * @returns {string | null}
 */
export function renderAasa(config) {
  const prefix = config.ios.app_id_prefix;
  if (prefix === null) return null;
  return JSON.stringify({
    applinks: {
      details: [
        {
          appIDs: [`${prefix}.${config.ios.bundle_id}`],
          components: config.paths.map((path) => ({ "/": path })),
        },
      ],
    },
  });
}

/**
 * Berkas yang diterbitkan: Map path relatif dist/ ke isi JSON ringkas UTF-8. Konfigurasi kosong menghasilkan Map
 * kosong. Melempar galat bila konfigurasi tidak sah atau berkas mencapai batas 128 KB.
 * @param {unknown} config
 * @returns {Map<string, string>}
 */
export function renderAppLinkFiles(config) {
  const problems = validateAppLinks(config);
  if (problems.length > 0) throw new Error(`app-links.json tidak sah: ${problems.join("; ")}`);
  const valid = /** @type {AppLinksConfig} */ (config);
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const [path, body] of /** @type {const} */ ([
    [ASSETLINKS_PATH, renderAssetLinks(valid)],
    [AASA_PATH, renderAasa(valid)],
  ])) {
    if (body === null) continue;
    const bytes = new TextEncoder().encode(body).length;
    if (bytes >= MAX_FILE_BYTES)
      throw new Error(`${path}: ${bytes} byte, melebihi batas ${MAX_FILE_BYTES} byte`);
    files.set(path, body);
  }
  return files;
}
