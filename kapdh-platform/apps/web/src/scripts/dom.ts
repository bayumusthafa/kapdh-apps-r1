/**
 * Pembantu DOM kecil. Teks SELALU lewat textContent (tidak ada innerHTML dengan data API); HTML kaya hanya lewat
 * sanitize.ts. Tidak ada atribut style agar CSP style-src 'self' berlaku (N-07).
 */

type Child = Node | string | null | undefined | false;

export interface ElOptions {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  options: ElOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (name === "style" || name.startsWith("on")) throw new Error(`atribut ${name} tidak diizinkan`);
    node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? doc.createTextNode(child) : child);
  }
  return node;
}

export function byId<T extends HTMLElement = HTMLElement>(doc: Document, id: string): T {
  const node = doc.getElementById(id);
  if (!node) throw new Error(`elemen #${id} tidak ada`);
  return node as T;
}

/** Menampilkan tepat satu panel dari sekumpulan panel (atribut hidden). */
export function showOnly(panels: Iterable<HTMLElement>, visible: HTMLElement | null): void {
  for (const panel of panels) panel.hidden = panel !== visible;
}

/** Ikon SVG dekoratif (aria-hidden) dari path; tanpa innerHTML. */
export function icon(doc: Document, paths: string[], className = "size-5"): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", className);
  for (const d of paths) {
    const p = doc.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** Path ikon (gaya garis guideline, 24x24). */
export const ICONS = {
  check: ["M20 6 9 17l-5-5"],
  checkCircle: ["M22 11.1V12a10 10 0 1 1-5.9-9.1", "M22 4 12 14l-3-3"],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 6v6l4 2"],
  alert: [
    "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
    "M12 9v4",
    "M12 17h.01",
  ],
  ban: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "m4.9 4.9 14.2 14.2"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "m21 21-4.3-4.3"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  wifiOff: [
    "M2 2l20 20",
    "M8.5 16.5a5 5 0 0 1 7 0",
    "M2 8.8a15 15 0 0 1 4.2-2.6",
    "M10.7 5.1A15 15 0 0 1 22 8.8",
    "M5 12.9a10 10 0 0 1 5.2-2.7",
    "M16.9 10.4a10 10 0 0 1 2.1 1.5",
    "M12 20h.01",
  ],
  info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 16v-4", "M12 8h.01"],
  qr: [
    "M3 3h7v7H3z",
    "M14 3h7v7h-7z",
    "M3 14h7v7H3z",
    "M14 14h3v3h-3z",
    "M20 14v.01",
    "M14 20h.01",
    "M20 20h.01",
  ],
} as const;
