import type { components } from "@kapdh/contracts";
import { failureAction, requestJson, type ApiResult } from "./api";
import { formatDate, formatDateTime } from "./format";

/** POST /public/kta/verify (public.yaml, F-06). */
export type KtaVerification = components["schemas"]["KtaVerification"];
export type KtaVerifiedMember = components["schemas"]["KtaVerifiedMember"];

/** Pola MemberNumber (me.yaml): AA.SS.JK.N, N tanpa nol di depan (PRD 3.5). */
const NUMBER_RE = /^[0-9]{2}\.0[1-3]\.0[12]\.[1-9][0-9]{0,15}$/;
/** Token QR adalah JWT (header.payload.signature, base64url); panjang mengikuti KtaVerifyRequest (16..2048). */
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TOKEN_MIN = 16;
const TOKEN_MAX = 2048;

export type KtaLocation =
  | { status: "ok"; memberNumber: string; token: string }
  /** /kta tanpa nomor dan token: halaman dibuka langsung, bukan dari QR. */
  | { status: "missing" }
  /** Nomor/token rusak, tidak lengkap, atau percent-encoding tidak sah: tidak pernah dikirim ke API. */
  | { status: "invalid" };

/**
 * Nomor dari path /kta/{nomor}; token dari fragmen #t= sehingga tidak terkirim ke server web, tidak tercatat di
 * access log dan tidak bocor lewat Referer (F-06, usulan v3.1). Percent-encoding yang rusak (mis. `%E0%A4%A`)
 * menghasilkan `invalid`, bukan galat yang menghentikan skrip.
 */
export function parseKtaLocation(pathname: string, hash: string): KtaLocation {
  const match = /^\/kta(?:\/(.*))?$/.exec(pathname);
  if (!match) return { status: "invalid" };
  const rawNumber = (match[1] ?? "").replace(/\/+$/, "");
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("t") ?? "";
  if (!rawNumber && !token) return { status: "missing" };
  let memberNumber: string;
  try {
    memberNumber = decodeURIComponent(rawNumber);
  } catch {
    return { status: "invalid" };
  }
  if (!NUMBER_RE.test(memberNumber)) return { status: "invalid" };
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX || !TOKEN_RE.test(token))
    return { status: "invalid" };
  return { status: "ok", memberNumber, token };
}

const RESULTS = new Set(["active", "expired", "inactive", "not_found", "invalid_token"]);

function isMember(value: unknown): value is KtaVerifiedMember {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.full_name === "string" &&
    typeof m.cohort_code === "string" &&
    typeof m.member_number === "string" &&
    typeof m.expires_at === "string" &&
    (m.avatar_url === null || typeof m.avatar_url === "string")
  );
}

/** Respons yang tidak sesuai kontrak diperlakukan sebagai tidak terjangkau, bukan hasil bisnis (AC F06-4). */
export function isKtaVerification(value: unknown): value is KtaVerification {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.result !== "string" || !RESULTS.has(v.result)) return false;
  if (typeof v.checked_at !== "string" || Number.isNaN(Date.parse(v.checked_at))) return false;
  if (typeof v.expiring !== "boolean") return false;
  if (v.member !== null && !isMember(v.member)) return false;
  // `member` wajib untuk active (public.yaml); tanpa identitas pemeriksa tidak dapat mencocokkan pemegang kartu.
  if (v.result === "active" && v.member === null) return false;
  return true;
}

export function verifyKta(
  apiBase: string,
  memberNumber: string,
  token: string,
  fetcher?: typeof fetch,
): Promise<ApiResult<KtaVerification>> {
  return requestJson(apiBase, "/public/kta/verify", {
    method: "POST",
    body: { member_number: memberNumber, token },
    accept: isKtaVerification,
    fetcher,
  });
}

export type KtaView =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "active"; expiring: boolean; member: KtaVerifiedMember; checkedAt: string }
  | { kind: "expired"; member: KtaVerifiedMember | null; checkedAt: string }
  | { kind: "inactive"; checkedAt: string }
  | { kind: "not_found"; checkedAt: string }
  | { kind: "invalid"; checkedAt: string | null; cause: "token" | "link" }
  /** `rateLimited`: 429 RATE_LIMITED; `retryAfterSeconds` menahan tombol coba lagi selama jeda server. */
  | { kind: "unreachable"; rateLimited: boolean; retryAfterSeconds: number | null };

/**
 * Hasil API -> keadaan tampilan. Jaringan putus, timeout, 429, 5xx dan respons yang tidak dapat dipercaya SELALU
 * `unreachable` ("Tidak dapat memverifikasi" + coba lagi), tidak pernah Tidak ditemukan (AC F06-4).
 *
 * Galat dipetakan lewat kode katalog (PRD 5.2), bukan status saja: hanya 400 VALIDATION_ERROR berbody `Error` dari
 * API yang menjadi putusan "QR tidak valid" (AC F06-3). HTML 400 dari WAF/proxy berarti token belum pernah diperiksa,
 * sehingga tetap `unreachable` dengan coba lagi.
 */
export function toKtaView(result: ApiResult<KtaVerification>): KtaView {
  if (!result.ok) {
    const action = failureAction(result);
    if (result.status === 400 && action === "show_field_errors")
      return { kind: "invalid", checkedAt: null, cause: "token" };
    const rateLimited = action === "show_countdown";
    return {
      kind: "unreachable",
      rateLimited,
      retryAfterSeconds: rateLimited && result.kind === "http" ? result.retryAfterSeconds : null,
    };
  }
  const v = result.data;
  switch (v.result) {
    case "active":
      return { kind: "active", expiring: v.expiring, member: v.member!, checkedAt: v.checked_at };
    case "expired":
      return { kind: "expired", member: v.member, checkedAt: v.checked_at };
    case "inactive":
      return { kind: "inactive", checkedAt: v.checked_at };
    case "not_found":
      return { kind: "not_found", checkedAt: v.checked_at };
    case "invalid_token":
      return { kind: "invalid", checkedAt: v.checked_at, cause: "token" };
  }
}

export type Tone = "success" | "warning" | "danger" | "neutral" | "info";

export interface KtaDescription {
  tone: Tone;
  /** Label status; selalu teks, tidak hanya warna (PRD 4.5). */
  title: string;
  detail: string;
  facts: Array<{ label: string; value: string }>;
  checked: string | null;
  avatarUrl: string | null;
  retry: boolean;
}

/** Foto anggota hanya dari URL https (http hanya untuk API lokal saat pengembangan). */
export function safeAvatarUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return url.href;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
      return url.href;
    return null;
  } catch {
    return null;
  }
}

const checkedText = (iso: string) => `Diperiksa ${formatDateTime(iso)} dari server KAPDH.`;

function identityFacts(m: KtaVerifiedMember, expiryLabel: string) {
  return [
    { label: "Nama", value: m.full_name },
    { label: "Angkatan", value: m.cohort_code },
    { label: "Nomor anggota", value: m.member_number },
    { label: expiryLabel, value: formatDate(m.expires_at) },
  ];
}

/** Teks per hasil AC F06-1..F06-4 tanpa alasan privat (D3: tanpa email, telepon, alamat, alasan suspend). */
export function describeKta(view: KtaView): KtaDescription {
  const base = { facts: [], checked: null, avatarUrl: null, retry: false };
  switch (view.kind) {
    case "loading":
      return {
        ...base,
        tone: "info",
        title: "Memeriksa…",
        detail: "Menghubungi server KAPDH untuk status keanggotaan terkini.",
      };
    case "missing":
      return {
        ...base,
        tone: "info",
        title: "Pindai QR pada KTA",
        detail:
          "Halaman ini menampilkan status keanggotaan saat QR pada KTA digital di aplikasi KAPDH dipindai dengan kamera ponsel.",
      };
    case "active":
      return {
        ...base,
        tone: view.expiring ? "warning" : "success",
        title: view.expiring ? "Aktif, segera berakhir" : "Aktif",
        detail: view.expiring
          ? `Keanggotaan berlaku dan akan berakhir pada ${formatDate(view.member.expires_at)}. Cocokkan nama dan foto dengan pemegang kartu.`
          : "Keanggotaan berlaku. Cocokkan nama dan foto dengan pemegang kartu.",
        facts: identityFacts(view.member, "Berlaku sampai"),
        checked: checkedText(view.checkedAt),
        avatarUrl: safeAvatarUrl(view.member.avatar_url),
      };
    case "expired":
      return {
        ...base,
        tone: "danger",
        title: "Kedaluwarsa",
        detail: "Masa keanggotaan sudah berakhir. Kartu ini tidak dapat dipakai sampai diperpanjang.",
        facts: view.member ? identityFacts(view.member, "Berakhir pada") : [],
        checked: checkedText(view.checkedAt),
      };
    case "inactive":
      return {
        ...base,
        tone: "neutral",
        title: "Tidak aktif",
        detail: "Keanggotaan ini tidak dapat digunakan saat ini.",
        checked: checkedText(view.checkedAt),
      };
    case "not_found":
      return {
        ...base,
        tone: "neutral",
        title: "Tidak ditemukan",
        detail: "Nomor anggota pada QR tidak terdaftar.",
        checked: checkedText(view.checkedAt),
      };
    case "invalid":
      return {
        ...base,
        tone: "danger",
        title: "QR tidak valid atau perlu diperbarui",
        detail:
          view.cause === "link"
            ? "Tautan QR rusak atau tidak lengkap. Pindai ulang QR langsung dari KTA digital di aplikasi KAPDH."
            : "Minta pemegang kartu membuka KTA di aplikasi dalam keadaan online, lalu pindai ulang QR yang baru.",
        checked: view.checkedAt ? checkedText(view.checkedAt) : null,
      };
    case "unreachable":
      return {
        ...base,
        tone: "info",
        title: "Tidak dapat memverifikasi",
        detail: view.rateLimited
          ? "Terlalu banyak pemeriksaan dalam waktu singkat. Tunggu sebentar lalu coba lagi. Ini bukan berarti anggota tidak terdaftar."
          : "Server KAPDH tidak dapat dihubungi. Periksa koneksi lalu coba lagi. Ini bukan berarti anggota tidak terdaftar.",
        retry: true,
      };
  }
}
