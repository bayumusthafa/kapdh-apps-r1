/**
 * Render aman HTML halaman informasi/legal (F-08, PRD 3.8: "rich text disanitasi; tautan luar diberi indikasi yang
 * jelas"). Server sudah menyanitasi `body_html`; di sini lapisan kedua (defense in depth) dengan daftar izin:
 * HTML diurai di dokumen inert (DOMParser: skrip tidak jalan, gambar tidak dimuat), lalu fragmen BARU dibangun
 * elemen demi elemen di dokumen tujuan. Atribut di luar daftar (style, class, on*, data-*) tidak pernah disalin.
 *
 * Jangkar dalam halaman (daftar isi kebijakan privasi): `id` yang sah disalin dengan awalan `isi-` (tidak bentrok
 * dengan id halaman seperti `konten` atau `info-title`) dan `href="#x"` ditulis ulang ke `#isi-x`. Tautan jangkar
 * yang targetnya tidak ada di isi tersanitasi dibuka menjadi teks biasa sehingga tidak ada tautan mati.
 */

/** Tag yang dipertahankan apa adanya. */
const KEEP = new Set([
  "p",
  "br",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "mark",
  "small",
  "sub",
  "sup",
  "code",
  "pre",
  "blockquote",
  "hr",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "a",
  "img",
  "figure",
  "figcaption",
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
]);

/** Tag yang dibuang beserta seluruh isinya. */
const DROP = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "svg",
  "math",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "head",
  "title",
  "link",
  "meta",
  "base",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
  "dialog",
  "portal",
]);

/** Judul halaman sudah h1; heading isi diturunkan satu tingkat. */
const RENAME: Record<string, string> = { h1: "h2" };

const MAX_DEPTH = 40;

const INT_ATTR = /^[1-9][0-9]{0,3}$/;

/** id sumber yang diterima untuk jangkar; disalin dengan awalan ANCHOR_PREFIX. */
const ANCHOR_ID = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
export const ANCHOR_PREFIX = "isi-";

/** Elemen kosong tanpa makna sebagai tujuan jangkar. */
const NO_ID = new Set(["br", "hr", "img"]);

interface CleanContext {
  siteOrigin: string;
  /** id sumber (tanpa awalan) yang sudah dipakai; id ganda hanya dipertahankan pada kemunculan pertama. */
  ids: Set<string>;
}

/**
 * URL tautan yang aman: http(s), mailto, tel, relatif terhadap situs, atau #jangkar. Mengembalikan URL absolut
 * (atau #jangkar) dan apakah tautan keluar dari situs; null bila ditolak (javascript:, data:, vbscript:, dll.).
 */
export function safeLink(raw: string, siteOrigin: string): { href: string; external: boolean } | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("#"))
    return /^#[A-Za-z0-9_-]{1,100}$/.test(value) ? { href: value, external: false } : null;
  let url: URL;
  try {
    url = new URL(value, siteOrigin);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:" || url.protocol === "tel:") return { href: url.href, external: false };
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return { href: url.href, external: url.origin !== siteOrigin };
}

/** Sumber gambar hanya https atau situs sendiri (CSP img-src juga membatasi). */
export function safeImageSrc(raw: string, siteOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), siteOrigin);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:" || url.origin === siteOrigin) return url.href;
  return null;
}

function copyAttributes(
  source: Element,
  target: HTMLElement,
  tag: string,
  siteOrigin: string,
  doc: Document,
): boolean {
  const attr = (name: string) => source.getAttribute(name);
  switch (tag) {
    case "a": {
      const link = safeLink(attr("href") ?? "", siteOrigin);
      if (!link) return true; // tautan berbahaya: isi tetap tampil sebagai teks biasa lewat unwrap
      // Jangkar dalam halaman menunjuk id berawalan yang disalin appendClean.
      target.setAttribute(
        "href",
        link.href.startsWith("#") ? `#${ANCHOR_PREFIX}${link.href.slice(1)}` : link.href,
      );
      const title = attr("title");
      if (title) target.setAttribute("title", title.slice(0, 200));
      if (link.external) {
        target.setAttribute("target", "_blank");
        target.setAttribute("rel", "noopener noreferrer nofollow external");
        target.setAttribute("data-external", "true");
        const hint = doc.createElement("span");
        hint.className = "sr-only";
        hint.textContent = " (tautan luar, terbuka di tab baru)";
        target.append(hint);
      }
      return false;
    }
    case "img": {
      const src = safeImageSrc(attr("src") ?? "", siteOrigin);
      if (!src) return true;
      target.setAttribute("src", src);
      target.setAttribute("alt", (attr("alt") ?? "").slice(0, 300));
      for (const dim of ["width", "height"]) {
        const v = attr(dim);
        if (v && INT_ATTR.test(v)) target.setAttribute(dim, v);
      }
      target.setAttribute("loading", "lazy");
      target.setAttribute("decoding", "async");
      target.setAttribute("referrerpolicy", "no-referrer");
      return false;
    }
    case "th":
    case "td": {
      for (const span of ["colspan", "rowspan"]) {
        const v = attr(span);
        if (v && INT_ATTR.test(v) && Number(v) <= 100) target.setAttribute(span, v);
      }
      const scope = attr("scope");
      if (tag === "th" && (scope === "row" || scope === "col")) target.setAttribute("scope", scope);
      return false;
    }
    case "ol": {
      const start = attr("start");
      if (start && INT_ATTR.test(start)) target.setAttribute("start", start);
      return false;
    }
    default:
      return false;
  }
}

function appendClean(source: Node, parent: Node, doc: Document, ctx: CleanContext, depth: number): void {
  if (source.nodeType === 3) {
    parent.appendChild(doc.createTextNode((source as Text).data));
    return;
  }
  if (source.nodeType !== 1) return; // komentar, instruksi pemrosesan, dll.
  const element = source as Element;
  const name = element.localName.toLowerCase();
  if (DROP.has(name) || element.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
  if (depth >= MAX_DEPTH) {
    parent.appendChild(doc.createTextNode(element.textContent ?? ""));
    return;
  }
  const tag = RENAME[name] ?? name;
  if (!KEEP.has(tag)) {
    // Tag tidak dikenal (div, span, section, font, ...): bungkus dibuang, isi dipertahankan.
    for (const child of Array.from(element.childNodes)) appendClean(child, parent, doc, ctx, depth + 1);
    return;
  }
  const target = doc.createElement(tag);
  const unwrap = copyAttributes(element, target, tag, ctx.siteOrigin, doc);
  const sourceId = element.getAttribute("id");
  if (!unwrap && !NO_ID.has(tag) && sourceId && ANCHOR_ID.test(sourceId) && !ctx.ids.has(sourceId)) {
    ctx.ids.add(sourceId);
    target.setAttribute("id", `${ANCHOR_PREFIX}${sourceId}`);
  }
  if (tag === "img") {
    if (!unwrap) parent.appendChild(target);
    return;
  }
  const container: Node = unwrap ? parent : target;
  // Petunjuk tautan luar ditambahkan copyAttributes; isi asli disisipkan sebelum petunjuk itu.
  const hint = !unwrap && tag === "a" ? target.lastChild : null;
  for (const child of Array.from(element.childNodes)) {
    if (hint) {
      const holder = doc.createDocumentFragment();
      appendClean(child, holder, doc, ctx, depth + 1);
      target.insertBefore(holder, hint);
    } else {
      appendClean(child, container, doc, ctx, depth + 1);
    }
  }
  if (unwrap) return;
  if (tag === "table") {
    // Tabel lebar digulir di dalam bingkainya sendiri sehingga halaman tidak bergulir horizontal di ponsel.
    const frame = doc.createElement("div");
    frame.className = "prose-table";
    frame.append(target);
    parent.appendChild(frame);
    return;
  }
  parent.appendChild(target);
}

/** Mengurai `html` di dokumen inert dan mengembalikan fragmen bersih milik `doc`. */
export function sanitizeRichHtml(html: string, doc: Document, siteOrigin: string): DocumentFragment {
  const inert = new DOMParser().parseFromString(html, "text/html");
  const fragment = doc.createDocumentFragment();
  const ctx: CleanContext = { siteOrigin, ids: new Set() };
  for (const child of Array.from(inert.body.childNodes)) appendClean(child, fragment, doc, ctx, 0);
  // Jangkar tanpa tujuan di isi ini (id dibuang server, ganda, atau tidak sah) dibuka menjadi teks biasa.
  for (const anchor of Array.from(fragment.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'))) {
    const id = anchor.getAttribute("href")!.slice(1 + ANCHOR_PREFIX.length);
    if (!ctx.ids.has(id)) anchor.replaceWith(...Array.from(anchor.childNodes));
  }
  return fragment;
}
