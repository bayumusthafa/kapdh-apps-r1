import { useMemo } from "react";
import { cn } from "../../lib/cn";

/**
 * Pratinjau isi berita/halaman di web admin. HTML draf dari editor maupun dari server diperlakukan tidak tepercaya:
 * pratinjau MEMBANGUN ULANG dokumen hanya dari daftar tag dan atribut yang sama dengan kebijakan sanitasi server
 * (kontrak Post.body_html, PRD 3.8): p, br, h2-h4, strong, em, u, s, blockquote, ul, ol, li, a (https/mailto),
 * img (https, dengan alt), hr. Elemen lain dibuka (teksnya tetap) dan elemen aktif (script, style, iframe, form,
 * svg, ...) dibuang beserta isinya. Tidak ada atribut asli yang disalin selain href/src/alt yang tervalidasi,
 * sehingga atribut on* dan URL javascript: tidak pernah sampai ke DOM. Tautan luar diberi indikasi yang jelas
 * seperti di aplikasi anggota (PRD 3.8).
 */
const ALLOWED = new Set([
  "P",
  "BR",
  "H2",
  "H3",
  "H4",
  "STRONG",
  "EM",
  "U",
  "S",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "A",
  "IMG",
  "HR",
]);
const DROPPED = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "FRAME",
  "OBJECT",
  "EMBED",
  "TEMPLATE",
  "NOSCRIPT",
  "SVG",
  "MATH",
  "FORM",
  "INPUT",
  "BUTTON",
  "TEXTAREA",
  "SELECT",
  "LINK",
  "META",
  "BASE",
  "VIDEO",
  "AUDIO",
  "CANVAS",
]);
const SAFE_LINK = /^(https:\/\/|mailto:)/i;
const SAFE_IMAGE = /^https:\/\//i;

function rebuild(from: Node, to: Element, doc: Document): void {
  from.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      to.appendChild(doc.createTextNode(node.textContent ?? ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (DROPPED.has(tag)) return;
    if (!ALLOWED.has(tag)) {
      rebuild(el, to, doc);
      return;
    }
    if (tag === "IMG") {
      const src = el.getAttribute("src") ?? "";
      const alt = el.getAttribute("alt")?.trim() ?? "";
      if (!SAFE_IMAGE.test(src)) return;
      const img = doc.createElement("img");
      img.setAttribute("src", src);
      img.setAttribute("alt", alt);
      img.setAttribute("loading", "lazy");
      img.setAttribute("referrerpolicy", "no-referrer");
      to.appendChild(img);
      return;
    }
    if (tag === "A") {
      const href = el.getAttribute("href")?.trim() ?? "";
      if (!SAFE_LINK.test(href)) {
        // Tautan tidak aman kehilangan tautannya; teksnya tetap.
        rebuild(el, to, doc);
        return;
      }
      const a = doc.createElement("a");
      a.setAttribute("href", href);
      rebuild(el, a, doc);
      if (/^https:/i.test(href)) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer nofollow");
        a.setAttribute("data-external", "true");
        const mark = doc.createElement("span");
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = " ↗";
        const sr = doc.createElement("span");
        sr.setAttribute("class", "sr-only");
        sr.textContent = " (tautan luar, tab baru)";
        a.append(mark, sr);
      }
      to.appendChild(a);
      return;
    }
    const clean = doc.createElement(tag.toLowerCase());
    rebuild(el, clean, doc);
    to.appendChild(clean);
  });
}

/** HTML aman untuk pratinjau, dibangun ulang dari daftar izin (lihat keterangan berkas). */
export function sanitizeContentHtml(html: string): string {
  const source = new DOMParser().parseFromString(html, "text/html");
  const target = document.implementation.createHTMLDocument("");
  const container = target.createElement("div");
  rebuild(source.body, container, target);
  return container.innerHTML;
}

export function HtmlPreview({ html, className }: { html: string; className?: string }) {
  const safe = useMemo(() => sanitizeContentHtml(html), [html]);
  if (!safe.trim())
    return <p className={cn("text-sm italic text-text-muted", className)}>Isi masih kosong.</p>;
  // Aman: `safe` hanya berisi elemen yang dibuat ulang dari daftar izin di atas.
  return <div className={cn("prose-kapdh text-sm", className)} dangerouslySetInnerHTML={{ __html: safe }} />;
}
