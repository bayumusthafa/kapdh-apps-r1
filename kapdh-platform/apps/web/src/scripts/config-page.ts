import type { ApiResult } from "./api";
import {
  DEFAULT_SUPPORT_EMAIL,
  fetchPublicConfig,
  mailtoHref,
  safeStoreUrl,
  whatsappHref,
  type PublicConfig,
} from "./config";
import { formatDateTime } from "./format";

/**
 * Mengisi bagian halaman yang bergantung pada GET /public/config saat runtime (PRD 4.6, 8.3): tombol toko
 * (`[data-store]`), kontak bantuan (`[data-support-*]`) dan banner maintenance (`[data-maintenance]`). Nilai dari
 * pengurus (app_settings) tidak ditanam saat build agar perubahan tautan toko/kontak langsung berlaku.
 * Setiap keadaan gagal memuat menampilkan pesan dan tombol `[data-config-retry]` (PRD 4.5).
 */

type Platform = "android" | "ios";

export function applyStoreLinks(doc: Document, config: PublicConfig | null, failed: boolean): void {
  for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[data-store]"))) {
    const platform = anchor.dataset.store as Platform;
    const status = anchor.querySelector<HTMLElement>("[data-store-status]");
    const url = config ? safeStoreUrl(config.store_links[platform]) : null;
    if (url) {
      anchor.href = url;
      anchor.removeAttribute("aria-disabled");
      anchor.dataset.available = "true";
      if (status) status.textContent = platform === "android" ? "Unduh di Google Play" : "Unduh di App Store";
    } else {
      anchor.removeAttribute("href");
      anchor.setAttribute("aria-disabled", "true");
      anchor.dataset.available = "false";
      if (status) status.textContent = failed ? "Tautan belum dapat dimuat" : "Segera tersedia";
    }
  }
  for (const note of Array.from(doc.querySelectorAll<HTMLElement>("[data-store-note]"))) {
    note.hidden = !failed;
  }
}

/**
 * Kontak bantuan dari konfigurasi; email baku PRD 8.3 bila belum terbaca. `failed`: konfigurasi gagal dimuat, sehingga
 * `[data-support-error]` ("Kontak terbaru belum dapat dimuat" + coba lagi) tampil alih-alih diam-diam memakai default.
 */
export function applySupport(doc: Document, config: PublicConfig | null, failed = false): void {
  const email = config?.support.email ?? DEFAULT_SUPPORT_EMAIL;
  const emailHref = mailtoHref(email) ?? mailtoHref(DEFAULT_SUPPORT_EMAIL)!;
  for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[data-support-email]"))) {
    anchor.href = emailHref;
    anchor.textContent = emailHref.slice("mailto:".length);
  }
  const wa = whatsappHref(config?.support.whatsapp);
  for (const block of Array.from(doc.querySelectorAll<HTMLElement>("[data-support-whatsapp]"))) {
    const anchor = block.querySelector<HTMLAnchorElement>("a");
    block.hidden = !wa;
    if (anchor && wa && config?.support.whatsapp) {
      anchor.href = wa;
      anchor.textContent = config.support.whatsapp.trim();
    }
  }
  for (const pending of Array.from(doc.querySelectorAll<HTMLElement>("[data-support-pending]"))) {
    pending.hidden = true;
  }
  for (const error of Array.from(doc.querySelectorAll<HTMLElement>("[data-support-error]"))) {
    error.hidden = !failed;
  }
}

/**
 * Banner maintenance (PRD 4.5: "Jelaskan rentang estimasi, retry dan kanal dukungan"). Markup banner (Base.astro)
 * memuat tautan `[data-support-email]`/`[data-support-whatsapp]` yang diisi applySupport dan tombol
 * `[data-config-retry]` untuk memeriksa ulang apakah pemeliharaan sudah selesai.
 */
export function applyMaintenance(doc: Document, config: PublicConfig | null): void {
  const banner = doc.querySelector<HTMLElement>("[data-maintenance]");
  if (!banner) return;
  const text = banner.querySelector<HTMLElement>("[data-maintenance-text]");
  if (!config?.maintenance.active) {
    banner.hidden = true;
    return;
  }
  const until = config.maintenance.until
    ? ` Perkiraan selesai ${formatDateTime(config.maintenance.until)}.`
    : "";
  const message = config.maintenance.message?.trim() ? ` ${config.maintenance.message.trim()}` : "";
  if (text) {
    text.textContent = `Layanan KAPDH sedang dalam pemeliharaan; pendaftaran dan perubahan data ditunda sementara.${until}${message} Coba lagi setelah pemeliharaan selesai.`;
  }
  banner.hidden = false;
}

/**
 * Menerapkan hasil GET /public/config. `lastGood`: konfigurasi terakhir yang berhasil dimuat; bila pemuatan ulang
 * (tombol coba lagi/periksa lagi) gagal, nilai itu tetap dipakai sehingga banner maintenance dan tautan yang sudah
 * tampil tidak hilang hanya karena jaringan putus sesaat.
 */
export function applyConfig(
  doc: Document,
  result: ApiResult<PublicConfig>,
  lastGood: PublicConfig | null = null,
): PublicConfig | null {
  const config = result.ok ? result.data : lastGood;
  const failed = config === null;
  applyStoreLinks(doc, config, failed);
  applySupport(doc, config, failed);
  applyMaintenance(doc, config);
  return config;
}

/**
 * Satu permintaan konfigurasi per halaman (`initial` bila halaman sudah memulainya); tombol `[data-config-retry]`
 * memuat ulang (gagal memuat tautan toko/kontak, atau memeriksa ulang status maintenance).
 */
export async function mountConfigConsumers(
  doc: Document,
  apiBase: string,
  fetcher?: typeof fetch,
  initial?: Promise<ApiResult<PublicConfig>>,
): Promise<PublicConfig | null> {
  let lastGood: PublicConfig | null = null;
  const apply = (result: ApiResult<PublicConfig>) => (lastGood = applyConfig(doc, result, lastGood));
  const load = async () => apply(await fetchPublicConfig(apiBase, fetcher));
  for (const button of Array.from(doc.querySelectorAll<HTMLButtonElement>("[data-config-retry]"))) {
    button.addEventListener("click", () => void load());
  }
  return initial ? apply(await initial) : load();
}
