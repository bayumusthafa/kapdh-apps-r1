import type { components } from "@kapdh/contracts";
import { requestJson, type ApiResult } from "./api";
import { byId, el, icon, ICONS } from "./dom";
import { formatCountdown, formatDate } from "./format";
import { sanitizeRichHtml } from "./sanitize";

/** GET /public/pages/{slug} (content.yaml): salinan TAYANG halaman legal/informasi (F-08, PRD 3.8). */
export type PublicPage = components["schemas"]["PublicPage"];

const LEGAL_DOCUMENTS = new Set(["privacy", "terms", "community"]);

export function isPublicPage(value: unknown): value is PublicPage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.slug === "string" &&
    typeof v.title === "string" &&
    typeof v.body_html === "string" &&
    typeof v.version === "string" &&
    typeof v.published_at === "string" &&
    !Number.isNaN(Date.parse(v.published_at)) &&
    (v.legal_document === null ||
      (typeof v.legal_document === "string" && LEGAL_DOCUMENTS.has(v.legal_document)))
  );
}

export function fetchPublicPage(
  apiBase: string,
  slug: string,
  fetcher?: typeof fetch,
): Promise<ApiResult<PublicPage>> {
  return requestJson(apiBase, `/public/pages/${encodeURIComponent(slug)}`, { accept: isPublicPage, fetcher });
}

export type InfoPageView =
  | { kind: "loading" }
  | { kind: "ready"; page: PublicPage }
  /** 404: halaman belum pernah diterbitkan pengurus (content.yaml getPublicPage). */
  | { kind: "not_published" }
  | { kind: "unreachable"; retryAfterSeconds: number | null };

export function toInfoPageView(result: ApiResult<PublicPage>): InfoPageView {
  if (result.ok) return { kind: "ready", page: result.data };
  if (result.kind === "http" && result.status === 404) return { kind: "not_published" };
  return { kind: "unreachable", retryAfterSeconds: result.kind === "http" ? result.retryAfterSeconds : null };
}

/** "Versi 3 · Diterbitkan 12 Oktober 2026" (versi tayang dan tanggal terbit, F-01/F-08). */
export function pageMetaText(page: PublicPage): string {
  return `Versi ${page.version} · Diterbitkan ${formatDate(page.published_at)}`;
}

export interface InfoPageOptions {
  doc: Document;
  root: HTMLElement;
  apiBase: string;
  slug: string;
  /** Asal situs untuk menandai tautan luar (location.origin). */
  siteOrigin: string;
  fetcher?: typeof fetch;
}

/**
 * Mengisi shell halaman informasi: loading -> isi tersanitasi beserta versi dan tanggal terbit, atau keadaan
 * belum terbit / tidak terjangkau dengan coba lagi. Judul dokumen mengikuti judul tayang.
 */
export function mountInfoPage(options: InfoPageOptions): { load: () => Promise<void> } {
  const { doc, root, apiBase, slug, siteOrigin } = options;
  const title = byId(doc, "info-title");
  const meta = byId(doc, "info-meta");
  let timer: ReturnType<typeof setInterval> | null = null;
  let loading = false;

  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const notice = (
    tone: string,
    iconPaths: readonly string[],
    heading: string,
    body: string,
    extra: Node[] = [],
  ) =>
    // role=status: keadaan belum terbit/galat diumumkan pembaca layar tanpa membacakan seluruh dokumen (N-11).
    el(doc, "div", { class: `flex flex-col gap-3 rounded-lg p-5 ${tone}`, attrs: { role: "status" } }, [
      el(doc, "p", { class: "flex items-center gap-2 font-semibold" }, [icon(doc, [...iconPaths]), heading]),
      el(doc, "p", { class: "text-sm text-text", text: body }),
      ...extra,
    ]);

  const render = (view: InfoPageView) => {
    stopTimer();
    root.setAttribute("aria-busy", view.kind === "loading" ? "true" : "false");
    switch (view.kind) {
      case "loading":
        meta.textContent = "Memuat versi terbaru…";
        root.replaceChildren(
          el(doc, "div", { class: "flex flex-col gap-3", attrs: { "data-state": "loading" } }, [
            el(doc, "span", { class: "sr-only", text: "Memuat isi halaman…" }),
            ...[0, 1, 2, 3].map(() =>
              el(doc, "div", {
                class: "h-4 animate-pulse rounded bg-divider",
                attrs: { "aria-hidden": "true" },
              }),
            ),
          ]),
        );
        return;
      case "ready": {
        title.textContent = view.page.title;
        meta.textContent = pageMetaText(view.page);
        doc.title = `${view.page.title} | KAPDH`;
        const body = el(doc, "div", { class: "prose-kapdh", attrs: { "data-state": "ready" } });
        body.append(sanitizeRichHtml(view.page.body_html, doc, siteOrigin));
        root.replaceChildren(body);
        return;
      }
      case "not_published":
        meta.textContent = "";
        root.replaceChildren(
          notice(
            "bg-neutral-bg",
            ICONS.info,
            "Belum diterbitkan",
            "Halaman ini belum diterbitkan pengurus KAPDH. Silakan kembali lagi nanti atau hubungi kami lewat halaman Kontak.",
            [
              el(doc, "a", {
                class: "text-sm font-semibold text-primary underline",
                text: "Buka halaman Kontak",
                attrs: { href: "/kontak" },
              }),
            ],
          ),
        );
        root.firstElementChild?.setAttribute("data-state", "not_published");
        return;
      case "unreachable": {
        meta.textContent = "";
        const retry = el(doc, "button", {
          class: "btn-outline self-start",
          text: "Coba lagi",
          attrs: { type: "button" },
        });
        retry.addEventListener("click", () => void load());
        root.replaceChildren(
          notice(
            "bg-info-bg",
            ICONS.wifiOff,
            "Tidak dapat memuat halaman",
            view.retryAfterSeconds !== null
              ? "Terlalu banyak permintaan dalam waktu singkat. Tunggu sebentar lalu coba lagi."
              : "Server KAPDH tidak dapat dihubungi. Periksa koneksi Anda lalu coba lagi.",
            [retry],
          ),
        );
        root.firstElementChild?.setAttribute("data-state", "unreachable");
        if (view.retryAfterSeconds !== null && view.retryAfterSeconds > 0) {
          let left = view.retryAfterSeconds;
          retry.disabled = true;
          retry.textContent = `Coba lagi (${formatCountdown(left)})`;
          timer = setInterval(() => {
            left -= 1;
            if (left <= 0) {
              stopTimer();
              retry.disabled = false;
              retry.textContent = "Coba lagi";
            } else {
              retry.textContent = `Coba lagi (${formatCountdown(left)})`;
            }
          }, 1000);
        }
        return;
      }
    }
  };

  const load = async () => {
    if (loading) return;
    loading = true;
    try {
      render({ kind: "loading" });
      render(toInfoPageView(await fetchPublicPage(apiBase, slug, options.fetcher)));
    } finally {
      loading = false;
    }
  };

  return { load };
}
