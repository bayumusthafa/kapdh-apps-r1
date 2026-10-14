/**
 * Jaringan jalur `test:live`: fetch Node dibungkus cookie jar kecil dan header Origin untuk origin API, karena
 * fetch Node tidak menyimpan cookie dan tidak mengirim Origin seperti peramban. Cookie refresh admin `kapdh_admin_rt` (HttpOnly, Path=/api/v1/auth) dengan
 * begitu dikirim kembali seperti oleh peramban, sehingga pemulihan sesi, rotasi refresh dan logout klien web admin
 * diuji terhadap server sungguhan. `rawFetch` (tanpa jar) dipakai untuk admin lain yang bertindak lewat API, agar
 * cookie sesinya tidak tercampur dengan sesi UI.
 */

interface StoredCookie {
  value: string;
  path: string;
  expiresAt: number | null;
}

export const rawFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const jar = new Map<string, StoredCookie>();

export function clearCookies(): void {
  jar.clear();
}

export function cookieNames(): string[] {
  return [...jar.keys()];
}

export function cookieValue(name: string): string | undefined {
  return jar.get(name)?.value;
}

/**
 * Kelas FormData, Blob dan File milik Node. Lingkungan jsdom Vitest memasang Blob/File/FormData jsdom sebagai global,
 * padahal fetch Node (undici) hanya mengenali kelas Node dan memakai `File` global saat menambahkan berkas ke FormData:
 * berkas jsdom terkirim sebagai teks "[object File]" atau dengan Content-Length yang salah. Jalur ini memasang kelas
 * Node sebagai global (src/live/setup.ts) sehingga `new FormData()` di klien web admin dan berkas yang diunggah uji
 * dikirim sebagai multipart sungguhan, seperti oleh peramban. FormData diambil dari Response Node dan Blob/File dari
 * node:buffer (specifier dinamis agar paket web admin tidak memerlukan tipe Node).
 */
export async function nodeMultipartClasses(): Promise<{
  FormData: typeof FormData;
  Blob: typeof Blob;
  File: typeof File;
}> {
  const form = await new Response(new URLSearchParams("probe=1")).formData();
  const buffer = (await import(/* @vite-ignore */ ["node", "buffer"].join(":"))) as {
    Blob: typeof Blob;
    File: typeof File;
  };
  return { FormData: form.constructor as typeof FormData, Blob: buffer.Blob, File: buffer.File };
}

function storeSetCookie(header: string, now: number): void {
  const [pair, ...attributes] = header.split(";");
  const eq = pair?.indexOf("=") ?? -1;
  if (!pair || eq <= 0) return;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  let path = "/";
  let expiresAt: number | null = null;
  for (const attribute of attributes) {
    const [key, ...rest] = attribute.split("=");
    const k = key?.trim().toLowerCase();
    const v = rest.join("=").trim();
    if (k === "path" && v) path = v;
    else if (k === "max-age") expiresAt = now + Number(v) * 1000;
    else if (k === "expires" && expiresAt === null) expiresAt = Date.parse(v);
  }
  if (value === "" || (expiresAt !== null && expiresAt <= now)) jar.delete(name);
  else jar.set(name, { value, path, expiresAt });
}

/**
 * Pasang pembungkus fetch untuk `origin` API (dipanggil sekali oleh src/live/setup.ts). Seperti peramban, permintaan
 * ke API membawa header Origin halaman (web admin berada di origin lain dari API di production, jadi peramban
 * mengirim Origin pada setiap permintaan CORS); server memeriksanya untuk mutasi berbasis cookie (CSRF, PRD 5.2).
 */
export function installCookieJar(origin: string): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // Request dari klien dipakai apa adanya (body multipart tidak disalin ulang); selain itu dibuat dari input.
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === origin) {
      const now = Date.now();
      const cookies = [...jar.entries()]
        .filter(([, c]) => (c.expiresAt === null || c.expiresAt > now) && url.pathname.startsWith(c.path))
        .map(([name, c]) => `${name}=${c.value}`);
      if (cookies.length > 0) request.headers.set("cookie", cookies.join("; "));
      if (!request.headers.has("origin")) request.headers.set("origin", window.location.origin);
    }
    const response = await rawFetch(request);
    if (url.origin === origin)
      for (const header of response.headers.getSetCookie()) storeSetCookie(header, Date.now());
    return response;
  };
}
