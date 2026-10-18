import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, staticContentViolations } from "../../scripts/static-content-check.mjs";
import {
  ORGANIZATION,
  ORGANIZATION_ADDRESS_LINE,
  organizationJsonLd,
  serializeJsonLd,
} from "../lib/organization";
import { LEGAL_SECTION_HREF, LEGAL_SECTION_ID } from "../lib/site";

const LD = serializeJsonLd(organizationJsonLd(new URL("https://kapdh.or.id")));
const LD_TAG = `<script type="application/ld+json">${LD}</script>`;
const MAILTO = `<a href="mailto:${ORGANIZATION.email}">${ORGANIZATION.email}</a>`;
const FOOTER =
  `<footer><p><strong>${ORGANIZATION.legalName} (${ORGANIZATION.shortName})</strong></p>` +
  `<p>Badan hukum perkumpulan, ${ORGANIZATION.sk.shortLabel} Nomor ${ORGANIZATION.sk.number}</p>` +
  `<address><span>${ORGANIZATION_ADDRESS_LINE}</span>${MAILTO}</address>` +
  `<a href="${LEGAL_SECTION_HREF}">Legalitas</a></footer>`;
const LEGAL =
  `<section id="${LEGAL_SECTION_ID}"><h2>Legalitas organisasi</h2><dl><dt>Nama badan hukum</dt>` +
  `<dd>${ORGANIZATION.legalName}</dd><dt>Pengesahan badan hukum</dt><dd>${ORGANIZATION.sk.title}</dd>` +
  `<dt>Kontak resmi</dt><dd>${MAILTO}</dd></dl>` +
  `<section><h3>Maksud dan tujuan</h3></section><section><h3>Kegiatan</h3></section>` +
  `<section><h3>Pengelolaan kekayaan</h3></section></section>`;
const INFO = (inner: string) => `<h1 id="info-title">Judul</h1>${inner}<article id="info-body"></article>`;

function page(body: string, head = LD_TAG, footer = FOOTER): string {
  return `<!doctype html><html><head><title>x</title>${head}</head><body><a href="#konten">Lewati</a><main id="konten">${body}</main>${footer}</body></html>`;
}

function site(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map(
    Object.entries({
      "index.html": page(`<a href="${LEGAL_SECTION_HREF}">Lihat legalitas organisasi</a>`),
      "tentang/index.html": page(INFO(LEGAL)),
      "kontak/index.html": page("<p>Kontak</p>"),
      "kebijakan-privasi/index.html": page(INFO(""), ""),
      ...overrides,
    }),
  );
}

describe("gerbang isi statis: identitas badan hukum terbaca tanpa JavaScript", () => {
  it("aturan baku memakai id bagian Legalitas yang sama dengan lib/site", () => {
    expect(DEFAULT_RULES.legalSectionId).toBe(LEGAL_SECTION_ID);
    expect(LEGAL_SECTION_HREF).toBe(`/tentang#${DEFAULT_RULES.legalSectionId}`);
    expect(DEFAULT_RULES.legalPage).toBe("tentang/index.html");
  });

  it("situs lengkap lolos", () => {
    expect(staticContentViolations(site())).toEqual([]);
  });

  it("menolak footer tanpa nama badan hukum, nomor SK atau email", () => {
    const footer = FOOTER.replace(`${ORGANIZATION.legalName} (`, "Keluarga Alumni (");
    const problems = staticContentViolations(site({ "kontak/index.html": page("", LD_TAG, footer) }));
    expect(problems).toContain(`kontak/index.html: footer tanpa "${ORGANIZATION.legalName} (KAPDH)"`);
    const noSk = staticContentViolations(
      site({ "kontak/index.html": page("", LD_TAG, FOOTER.replace(ORGANIZATION.sk.number, "")) }),
    );
    expect(noSk).toContain(`kontak/index.html: footer tanpa "${ORGANIZATION.sk.number}"`);
    const noFooter = staticContentViolations(site({ "kontak/index.html": page("", LD_TAG, "") }));
    expect(noFooter).toContain("kontak/index.html: tanpa <footer>");
  });

  it("bagian Legalitas hanya di /tentang, tepat sekali, di antara judul dan isi CMS", () => {
    expect(staticContentViolations(site({ "tentang/index.html": page(INFO("")) }))).toContain(
      'tentang/index.html: id="legalitas" muncul 0 kali',
    );
    expect(staticContentViolations(site({ "kontak/index.html": page(LEGAL) }))).toContain(
      'kontak/index.html: id="legalitas" muncul 1 kali',
    );
    const after = page(`<h1 id="info-title">Judul</h1><article id="info-body"></article>${LEGAL}`);
    expect(staticContentViolations(site({ "tentang/index.html": after }))).toContain(
      "tentang/index.html: bagian Legalitas wajib di antara #info-title dan #info-body",
    );
    const noAims = page(INFO(LEGAL.replace("Maksud dan tujuan", "Tujuan")));
    expect(staticContentViolations(site({ "tentang/index.html": noAims }))).toContain(
      'tentang/index.html: bagian Legalitas tanpa "Maksud dan tujuan"',
    );
  });

  it("JSON-LD wajib satu blok NGO di <head>, tanpa NPWP, sama di semua halaman", () => {
    expect(staticContentViolations(site({ "index.html": page("", "") }))).toContain(
      "index.html: wajib tepat satu blok application/ld+json di <head>",
    );
    const school = LD_TAG.replace('"NGO"', '"EducationalOrganization"');
    const problems = staticContentViolations(site({ "kontak/index.html": page("", school) }));
    expect(problems).toContain("kontak/index.html: JSON-LD @type harus NGO");
    expect(problems).toContain("kontak/index.html: memuat EducationalOrganization");
    expect(problems).toContain("kontak/index.html: JSON-LD berbeda dari index.html");
    const tax = LD_TAG.replace('"@type":"NGO"', '"@type":"NGO","taxID":"x"');
    expect(staticContentViolations(site({ "kontak/index.html": page("", tax) }))).toContain(
      "kontak/index.html: JSON-LD memuat NPWP/taxID",
    );
    const broken = '<script type="application/ld+json">{"@type":</script>';
    expect(staticContentViolations(site({ "kontak/index.html": page("", broken) }))).toContain(
      "kontak/index.html: JSON-LD tidak dapat di-parse",
    );
  });

  it("menolak tautan fragmen statis yang tidak menuju id", () => {
    const problems = staticContentViolations(
      site({ "kontak/index.html": page('<a href="/tentang#tidak-ada">x</a><a href="#hilang">y</a>') }),
    );
    expect(problems).toContain("kontak/index.html: tautan /tentang#tidak-ada tidak menuju id yang ada");
    expect(problems).toContain("kontak/index.html: tautan #hilang tidak menuju id yang ada");
  });
});
