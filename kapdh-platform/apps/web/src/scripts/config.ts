import type { components } from "@kapdh/contracts";
import { requestJson, type ApiResult } from "./api";

/** GET /public/config (public.yaml): tautan toko, kontak bantuan, maintenance, versi legal, jam server. */
export type PublicConfig = components["schemas"]["PublicConfig"];
export type StoreLinks = components["schemas"]["StoreLinks"];
export type SupportContact = components["schemas"]["SupportContact"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

export function isPublicConfig(value: unknown): value is PublicConfig {
  if (!isObj(value)) return false;
  const { store_links, support, maintenance, server_time } = value;
  return (
    isObj(store_links) &&
    isStrOrNull(store_links.android) &&
    isStrOrNull(store_links.ios) &&
    isObj(support) &&
    typeof support.email === "string" &&
    isStrOrNull(support.whatsapp) &&
    isObj(maintenance) &&
    typeof maintenance.active === "boolean" &&
    typeof server_time === "string"
  );
}

export function fetchPublicConfig(apiBase: string, fetcher?: typeof fetch): Promise<ApiResult<PublicConfig>> {
  return requestJson(apiBase, "/public/config", { accept: isPublicConfig, fetcher });
}

export interface TimedConfig {
  result: ApiResult<PublicConfig>;
  /** Jam perangkat saat request dikirim dan respons diterima (ms), untuk serverOffsetMs. */
  sentAt: number;
  receivedAt: number;
}

/** Satu GET /public/config per halaman beserta waktu tempuhnya; dipakai bersama banner dan alur hapus akun. */
export async function fetchPublicConfigTimed(
  apiBase: string,
  fetcher?: typeof fetch,
  now: () => number = Date.now,
): Promise<TimedConfig> {
  const sentAt = now();
  const result = await fetchPublicConfig(apiBase, fetcher);
  return { result, sentAt, receivedAt: now() };
}

/** Kanal dukungan awal PRD 8.3 bila konfigurasi belum terbaca. */
export const DEFAULT_SUPPORT_EMAIL = "bantuan@kapdh.or.id";

/** Tautan toko hanya https agar konfigurasi yang salah tidak membuka skema lain (javascript:, http:). */
export function safeStoreUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** mailto: hanya untuk alamat sederhana (tanpa ?/&) agar tidak dapat menyisipkan header surat. */
export function mailtoHref(email: string): string | null {
  const trimmed = email.trim();
  return EMAIL_RE.test(trimmed) ? `mailto:${trimmed}` : null;
}

/**
 * Nomor WhatsApp dukungan (PRD 8.3) -> https://wa.me/<digit internasional>. Format lokal 08xx diubah ke 628xx.
 * null bila bukan nomor telepon yang wajar (8..15 digit, E.164).
 */
export function whatsappHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\+?[0-9 ()-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/[^0-9]/g, "");
  if (!trimmed.startsWith("+") && digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  return `https://wa.me/${digits}`;
}

/**
 * Selisih jam server terhadap perangkat (ms) dari `server_time`, dengan titik tengah waktu tempuh request sebagai
 * perkiraan saat server menulis jam. Dipakai hitung mundur OTP agar jam perangkat yang menyimpang tidak mengunci UI.
 */
export function serverOffsetMs(serverTimeIso: string, sentAtMs: number, receivedAtMs: number): number | null {
  const server = Date.parse(serverTimeIso);
  if (Number.isNaN(server)) return null;
  return server - (sentAtMs + receivedAtMs) / 2;
}
