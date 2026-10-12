import type { components } from "@kapdh/contracts";

type Verification = components["schemas"]["KtaVerification"];

const NUMBER_RE = /^\d{2}\.0[1-3]\.0[12]\.[1-9]\d*$/;

/** Nomor dari path /kta/{nomor}; token dari fragmen #t= agar tidak terkirim ke server web (F-06, usulan v3.1). */
export function parseKtaLocation(
  pathname: string,
  hash: string,
): { memberNumber: string | null; token: string | null } {
  const raw = decodeURIComponent(pathname.replace(/^\/kta\/?/, "").replace(/\/$/, ""));
  const memberNumber = NUMBER_RE.test(raw) ? raw : null;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("t");
  return { memberNumber, token: token && token.length > 10 ? token : null };
}

export type ViewState =
  | { kind: "active"; title: string; detail: string }
  | { kind: "expired"; title: string; detail: string }
  | { kind: "inactive"; title: string; detail: string }
  | { kind: "not_found"; title: string; detail: string }
  | { kind: "invalid"; title: string; detail: string }
  | { kind: "unreachable"; title: string; detail: string };

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

/** Tidak membocorkan alasan privat; API tidak terjangkau tidak pernah ditampilkan sebagai "Tidak ditemukan" (AC F06-4). */
export function toViewState(result: Verification | null): ViewState {
  if (!result)
    return {
      kind: "unreachable",
      title: "Tidak dapat memverifikasi",
      detail: "Periksa koneksi lalu coba lagi.",
    };
  const checked = `Diperiksa ${fmtTime(result.checked_at)} WIB.`;
  switch (result.result) {
    case "active":
      return {
        kind: "active",
        title: "Aktif",
        detail: `${result.member?.full_name ?? ""} (${result.member?.cohort_code ?? ""}), berlaku sampai ${result.member?.expires_at ? fmt(result.member.expires_at) : "-"}. ${checked}`,
      };
    case "expired":
      return { kind: "expired", title: "Kedaluwarsa", detail: `Masa keanggotaan sudah berakhir. ${checked}` };
    case "inactive":
      return {
        kind: "inactive",
        title: "Tidak aktif",
        detail: `Keanggotaan tidak dapat digunakan saat ini. ${checked}`,
      };
    case "not_found":
      return {
        kind: "not_found",
        title: "Tidak ditemukan",
        detail: `Nomor anggota tidak terdaftar. ${checked}`,
      };
    case "invalid_token":
      return {
        kind: "invalid",
        title: "QR tidak valid atau perlu diperbarui",
        detail: "Minta pemegang kartu membuka KTA dalam keadaan online, lalu pindai ulang.",
      };
  }
}

export async function verify(
  apiBase: string,
  memberNumber: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<Verification | null> {
  try {
    const res = await fetcher(`${apiBase}/public/kta/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ member_number: memberNumber, token }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as Verification;
  } catch {
    return null;
  }
}
