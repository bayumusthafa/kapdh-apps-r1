// Aturan gerbang isi statis situs publik: identitas badan hukum KAPDH harus terbaca TANPA JavaScript di HTML hasil
// build (peninjau Google for Nonprofits dan perayap). Dipakai assert-static-content.mjs dan diuji
// src/scripts/static-content-check.test.ts. Nilai pembanding (nama badan hukum, nomor SK, email, alamat) diambil dari
// JSON-LD organisasi hasil build (sumbernya src/lib/organization.ts), jadi fakta legal tidak ditulis ulang di sini.

/**
 * @typedef {object} StaticContentRules
 * @property {string} legalPage Halaman yang memuat bagian Legalitas statis.
 * @property {string} legalSectionId Id bagian Legalitas (src/lib/site.ts LEGAL_SECTION_ID).
 * @property {string} legalSectionAfterId Bagian Legalitas berada setelah elemen ber-id ini (judul halaman).
 * @property {string} legalSectionBeforeId ... dan sebelum elemen ber-id ini (isi CMS yang diisi saat runtime).
 * @property {string[]} legalSectionTexts Judul yang wajib ada di bagian Legalitas.
 * @property {string[]} jsonLdPages Halaman yang wajib memuat JSON-LD organisasi di <head>.
 */

/** @type {StaticContentRules} */
export const DEFAULT_RULES = {
  legalPage: "tentang/index.html",
  legalSectionId: "legalitas",
  legalSectionAfterId: "info-title",
  legalSectionBeforeId: "info-body",
  legalSectionTexts: ["Legalitas organisasi", "Maksud dan tujuan", "Kegiatan", "Pengelolaan kekayaan"],
  jsonLdPages: ["index.html", "tentang/index.html", "kontak/index.html"],
};

const LD_JSON = /<script\b[^>]*\stype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'", nbsp: " " };

/** @param {string} value */
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Teks terlihat (tanpa tag, entitas dasar didekode, spasi dirapatkan) untuk mencari kalimat lintas markup. */
function visibleText(/** @type {string} */ html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(amp|lt|gt|quot|apos|#39|#x27|nbsp);/g,
      (_, name) => ENTITIES[/** @type {keyof typeof ENTITIES} */ (name)],
    )
    .replace(/\s+/g, " ");
}

/** Posisi atribut id="..." persis (atau -1). */
function idIndex(/** @type {string} */ html, /** @type {string} */ id) {
  return html.search(new RegExp(`\\sid\\s*=\\s*["']?${escapeRe(id)}(?=["'\\s>])`));
}

function idCount(/** @type {string} */ html, /** @type {string} */ id) {
  return html.match(new RegExp(`\\sid\\s*=\\s*["']?${escapeRe(id)}(?=["'\\s>])`, "g"))?.length ?? 0;
}

/** Isi elemen pertama bernama `tag` (tanpa elemen bersarang bernama sama), atau null. */
function firstElement(/** @type {string} */ html, /** @type {string} */ tag) {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(html)?.[1] ?? null;
}

/** HTML lengkap elemen `<section>` yang memuat posisi `at` pada tag pembukanya, memperhitungkan section bersarang. */
function sectionAt(/** @type {string} */ html, /** @type {number} */ at) {
  const start = html.lastIndexOf("<section", at);
  if (start < 0) return null;
  const tags = /<\/?section\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return null;
}

/** "/tentang" -> "tentang/index.html", "/" -> "index.html" (keluaran Astro build.format "directory"). */
function pageFile(/** @type {string} */ path) {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "index.html" : `${trimmed}/index.html`;
}

/** @param {unknown} value */
const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * Pelanggaran isi statis pada seluruh HTML hasil build.
 * @param {Map<string, string>} pages Path relatif dist ("tentang/index.html") ke isi HTML.
 * @param {StaticContentRules} [rules]
 * @returns {string[]}
 */
export function staticContentViolations(pages, rules = DEFAULT_RULES) {
  /** @type {string[]} */
  const problems = [];

  // 1. JSON-LD organisasi: tepat satu blok di <head>, dapat di-parse, bertipe NGO, tanpa NPWP, sama di semua halaman.
  /** @type {Record<string, any> | null} */
  let org = null;
  /** @type {string | null} */
  let firstRaw = null;
  for (const path of rules.jsonLdPages) {
    const html = pages.get(path);
    if (html === undefined) {
      problems.push(`${path}: tidak ada di dist`);
      continue;
    }
    const head = firstElement(html, "head") ?? "";
    const all = [...html.matchAll(LD_JSON)];
    const inHead = [...head.matchAll(LD_JSON)];
    if (all.length !== 1 || inHead.length !== 1) {
      problems.push(`${path}: wajib tepat satu blok application/ld+json di <head>`);
      continue;
    }
    const raw = (inHead[0]?.[1] ?? "").trim();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      problems.push(`${path}: JSON-LD tidak dapat di-parse`);
      continue;
    }
    if (data?.["@type"] !== "NGO") problems.push(`${path}: JSON-LD @type harus NGO`);
    if (/taxid|vatid|npwp/i.test(raw)) problems.push(`${path}: JSON-LD memuat NPWP/taxID`);
    if (firstRaw === null) firstRaw = raw;
    else if (raw !== firstRaw) problems.push(`${path}: JSON-LD berbeda dari ${rules.jsonLdPages[0]}`);
    if (org === null || path === rules.legalPage) org = data;
  }
  if (org === null) return [...new Set(problems)];

  const legalName = nonEmpty(org.legalName);
  const shortName = nonEmpty(org.alternateName);
  const email = nonEmpty(org.email);
  const skNumber = nonEmpty(org.identifier?.value);
  const street = nonEmpty(org.address?.streetAddress);
  const postalCode = nonEmpty(org.address?.postalCode);
  if (!legalName || !shortName || !email || !skNumber || !street || !postalCode) {
    problems.push("JSON-LD organisasi tidak lengkap (legalName, alternateName, email, identifier, address)");
    return [...new Set(problems)];
  }

  for (const [path, html] of pages) {
    // 2. Identitas badan hukum di footer setiap halaman.
    const footer = firstElement(html, "footer");
    if (footer === null) {
      problems.push(`${path}: tanpa <footer>`);
    } else {
      const text = visibleText(footer);
      for (const needle of [`${legalName} (${shortName})`, skNumber, street, postalCode]) {
        if (!text.includes(needle)) problems.push(`${path}: footer tanpa "${needle}"`);
      }
      if (!footer.includes(`href="mailto:${email}"`))
        problems.push(`${path}: footer tanpa tautan mailto:${email}`);
    }
    if (html.includes("EducationalOrganization")) problems.push(`${path}: memuat EducationalOrganization`);

    // 3. Bagian Legalitas hanya ada di halaman legal.
    const count = idCount(html, rules.legalSectionId);
    if (path === rules.legalPage ? count !== 1 : count !== 0) {
      problems.push(`${path}: id="${rules.legalSectionId}" muncul ${count} kali`);
    }

    // 4. Tautan fragmen statis (/tentang#legalitas, #konten) menuju id yang ada.
    for (const m of html.matchAll(/\shref\s*=\s*"(\/[^"#?]*)?#([^"]+)"/g)) {
      const target = m[1] === undefined ? path : pageFile(m[1]);
      const targetHtml = pages.get(target);
      if (targetHtml === undefined || idIndex(targetHtml, m[2] ?? "") < 0) {
        problems.push(`${path}: tautan ${m[1] ?? ""}#${m[2]} tidak menuju id yang ada`);
      }
    }
  }

  // 5. Isi dan letak bagian Legalitas: setelah judul halaman, sebelum isi CMS, memuat identitas dan judul wajib.
  const legalHtml = pages.get(rules.legalPage);
  if (legalHtml === undefined) {
    problems.push(`${rules.legalPage}: tidak ada di dist`);
  } else {
    const at = idIndex(legalHtml, rules.legalSectionId);
    const section = at < 0 ? null : sectionAt(legalHtml, at);
    if (section === null) {
      problems.push(`${rules.legalPage}: <section id="${rules.legalSectionId}"> tidak ditemukan`);
    } else {
      const after = idIndex(legalHtml, rules.legalSectionAfterId);
      const before = idIndex(legalHtml, rules.legalSectionBeforeId);
      if (after < 0 || before < 0 || !(after < at && at < before)) {
        problems.push(
          `${rules.legalPage}: bagian Legalitas wajib di antara #${rules.legalSectionAfterId} dan #${rules.legalSectionBeforeId}`,
        );
      }
      const text = visibleText(section);
      for (const needle of [legalName, skNumber, ...rules.legalSectionTexts]) {
        if (!text.includes(needle)) problems.push(`${rules.legalPage}: bagian Legalitas tanpa "${needle}"`);
      }
      if (!section.includes(`href="mailto:${email}"`)) {
        problems.push(`${rules.legalPage}: bagian Legalitas tanpa tautan mailto:${email}`);
      }
    }
  }

  return [...new Set(problems)];
}
