import sanitizeHtml from "sanitize-html";

/**
 * Sanitasi rich text berita dan halaman di server (PRD 3.8 "Cover dan rich text disanitasi; tautan luar diberi
 * indikasi yang jelas"; kontrak C4 `Post.body_html`, `PublicPage.body_html`). HTML dari editor web admin TIDAK
 * tepercaya: hanya daftar putih tag teks dasar yang disimpan, tanpa script/style/iframe, atribut on*, atau URL
 * javascript:. Disanitasi saat disimpan (dan diulang saat halaman diterbitkan), sehingga klien cukup merender.
 *
 * Aturan:
 * - Tag: p, br, h2-h4, strong, em, u, s, blockquote, ul, ol, li, a, img, hr. h1 -> h2, h5/h6 -> h4, b -> strong,
 *   i -> em, strike/del -> s. Tag lain dibuang tetapi teksnya dipertahankan; isi script/style/iframe/dll dibuang.
 * - Tautan: hanya `https:` (tautan luar) dan `mailto:`. Tautan https SELALU diberi `target="_blank"`,
 *   `rel="noopener noreferrer nofollow"`, `data-external="true"` dan kelas {@link EXTERNAL_LINK_CLASS} sehingga klien
 *   menampilkan indikasi tautan luar yang jelas. Atribut tautan dari klien tidak pernah diteruskan. Tautan dengan
 *   skema lain (javascript:, data:, http:, relatif) kehilangan tautannya, teksnya tetap.
 * - Gambar: hanya berkas publik KAPDH (`<API_PUBLIC_URL>/api/v1/files/public/<uuid>`) dengan teks alternatif
 *   (N-11); selain itu dibuang. Id berkasnya dikembalikan agar layanan melampirkannya (tidak dibersihkan job
 *   `files.cleanup-temp`).
 */
export const EXTERNAL_LINK_CLASS = "kapdh-external-link";
export const EXTERNAL_LINK_REL = "noopener noreferrer nofollow";

export const CONTENT_ALLOWED_TAGS = [
  "p",
  "br",
  "h2",
  "h3",
  "h4",
  "strong",
  "em",
  "u",
  "s",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "img",
  "hr",
] as const;

const MAX_URL_LENGTH = 2048;
const MAX_ALT_LENGTH = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAILTO = /^mailto:[^\s<>"'`\\]+$/i;

export interface SanitizedContentHtml {
  /** HTML aman untuk disimpan. */
  html: string;
  /** Id berkas publik KAPDH yang dirujuk tag img (unik, urutan kemunculan). */
  imageFileIds: string[];
  /** false bila setelah sanitasi tidak tersisa teks maupun gambar ("kosong setelah sanitasi ditolak"). */
  hasContent: boolean;
}

/** Tautan https yang sah (tanpa kredensial di URL) dalam bentuk ternormalisasi, atau null. */
export function safeHttpsUrl(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.length === 0 || url.username || url.password) return null;
  const normalized = url.href;
  return normalized.length <= MAX_URL_LENGTH ? normalized : null;
}

/** Pembuat sanitizer untuk satu asal API (host berkas publik KAPDH). */
export function createContentSanitizer(apiPublicUrl: string): (dirty: string) => SanitizedContentHtml {
  const base = new URL(apiPublicUrl);
  const publicFilePrefix = `${apiPublicUrl.replace(/\/+$/, "")}/api/v1/files/public/`;
  const imageScheme = base.protocol.replace(/:$/, "");

  return (dirty: string): SanitizedContentHtml => {
    const imageFileIds: string[] = [];
    const html = sanitizeHtml(dirty, {
      allowedTags: [...CONTENT_ALLOWED_TAGS],
      allowedAttributes: {
        a: ["href", "target", "rel", "data-external", "class"],
        img: ["src", "alt"],
      },
      allowedClasses: { a: [EXTERNAL_LINK_CLASS] },
      allowedSchemes: ["https", "mailto"],
      allowedSchemesByTag: { a: ["https", "mailto"], img: [imageScheme] },
      allowedSchemesAppliedToAttributes: ["href", "src"],
      allowProtocolRelative: false,
      disallowedTagsMode: "discard",
      nonTextTags: [
        "script",
        "style",
        "textarea",
        "option",
        "noscript",
        "iframe",
        "object",
        "embed",
        "template",
        "svg",
        "math",
        "head",
        "title",
      ],
      enforceHtmlBoundary: false,
      parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
      // Tag tidak pernah diganti nama ke tag yang dibuang (sanitize-html menyimpan nama transformasi per kedalaman
      // dan tidak membersihkannya untuk tag yang dibuang, sehingga penutup tag lain bisa salah nama). Tautan/gambar
      // yang tidak sah dibiarkan tanpa atribut lalu disingkirkan di sini: tautan tanpa href dibuka bungkusnya (teks
      // tetap), gambar tanpa src dibuang seluruhnya.
      exclusiveFilter: (frame) => {
        if (frame.tag === "a" && !frame.attribs.href) return "excludeTag";
        return frame.tag === "img" && !frame.attribs.src;
      },
      transformTags: {
        h1: "h2",
        h5: "h4",
        h6: "h4",
        b: "strong",
        i: "em",
        strike: "s",
        del: "s",
        a: (_tag, attribs): sanitizeHtml.Tag => {
          const href = attribs.href ?? "";
          const https = safeHttpsUrl(href);
          if (https)
            return {
              tagName: "a",
              attribs: {
                href: https,
                target: "_blank",
                rel: EXTERNAL_LINK_REL,
                "data-external": "true",
                class: EXTERNAL_LINK_CLASS,
              },
            };
          const mailto = href.trim();
          if (mailto.length <= MAX_URL_LENGTH && MAILTO.test(mailto))
            return { tagName: "a", attribs: { href: mailto } };
          return { tagName: "a", attribs: {} };
        },
        img: (_tag, attribs): sanitizeHtml.Tag => {
          const src = (attribs.src ?? "").trim();
          const alt = (attribs.alt ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ALT_LENGTH);
          const fileId = src.startsWith(publicFilePrefix) ? src.slice(publicFilePrefix.length) : "";
          if (!UUID.test(fileId) || alt.length === 0) return { tagName: "img", attribs: {} };
          if (!imageFileIds.includes(fileId)) imageFileIds.push(fileId);
          return { tagName: "img", attribs: { src: `${publicFilePrefix}${fileId}`, alt } };
        },
      },
    }).trim();
    // Spasi tak terputus (entitas maupun karakter U+00A0, yang dibuang trim()) tidak dihitung sebagai isi.
    const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
      .replace(/&nbsp;|&#160;/g, " ")
      .trim();
    return { html, imageFileIds, hasContent: text.length > 0 || imageFileIds.length > 0 };
  };
}
