// Aturan gerbang CSP situs publik (N-07); dipakai assert-csp-safe.mjs dan diuji src/scripts/csp-check.test.ts.
// CSP nginx: script-src 'self'; style-src 'self' (tanpa 'unsafe-inline'), lihat infra/nginx-web.conf.

const OFF_ORIGIN = /^(?:https?:)?\/\//i;

/**
 * Pelanggaran CSP pada satu dokumen HTML hasil build.
 * @param {string} html
 * @returns {string[]}
 */
export function cspViolations(html) {
  const problems = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? "";
    const body = (m[2] ?? "").trim();
    const src = /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    // Blok data (application/json, application/ld+json) tidak dieksekusi sehingga tidak diblokir CSP.
    const isData = type !== undefined && type !== "module" && type.includes("json");
    if (!src && body && !isData) problems.push("skrip inline");
    if (src && OFF_ORIGIN.test(src)) problems.push(`skrip dari origin lain: ${src}`);
  }
  if (/<style\b/i.test(html)) problems.push("blok <style> inline");
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = m[0];
    if (/\sstyle\s*=/i.test(tag)) problems.push("atribut style inline");
    if (/\son[a-z]+\s*=/i.test(tag)) problems.push("atribut event handler inline (on*)");
    if (/=\s*["']?\s*javascript:/i.test(tag)) problems.push("URL javascript:");
    if (/^<link\b/i.test(tag) && /\srel\s*=\s*["']?stylesheet/i.test(tag)) {
      const href = /\shref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] ?? "";
      if (OFF_ORIGIN.test(href)) problems.push(`stylesheet dari origin lain: ${href}`);
    }
  }
  return [...new Set(problems)];
}
