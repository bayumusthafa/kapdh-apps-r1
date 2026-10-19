import { mockAdminRef, requirePermission } from "./auth";
import { error, json, type MockRequest, type MockRoute, type S } from "./http";
import { routes as paymentRoutes } from "./payments";

/**
 * Tiruan pengaturan aplikasi (kontrak admin-settings C3, F-15, AC F15-3, F15-4, PRD 4.5, 8.3, D13): setiap kunci
 * app_settings punya `version` sendiri; PUT wajib izin settings.manage dan If-Match versi kunci itu (usang = 409
 * VERSION_CONFLICT dengan `current`), tanpa X-Reauth-Token (keputusan PO 2026-10-15, ADR-025); validasi mengikuti
 * skema input kontrak (400 field_errors).
 * Biaya (`fees`) dimiliki tiruan pembayaran; GET /admin/settings membacanya dari sana agar konsisten.
 * Data contoh bukan bukti AC (PRD 7.3).
 */
type Settings = S["AdminAppSettings"];
type SettingKey = "min_app_version" | "maintenance" | "store_links" | "support" | "payment_instructions";

export interface SettingsRequestLog {
  method: string;
  path: string;
  ifMatch: string | null;
  reauth: boolean;
  background: boolean;
  body: Record<string, unknown> | null;
}

/** Log permintaan pengaturan (uji: If-Match, tidak ada X-Reauth-Token, header latar). */
export const settingsRequests: SettingsRequestLog[] = [];

const SEED_AT = "2026-10-01T00:00:00Z";
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function meta(version = "1", updatedAt = SEED_AT): S["AdminSettingMeta"] {
  return { version, updated_at: updatedAt, updated_by: null };
}

type Mutable = Omit<Settings, "fees">;

function fixtures(): Mutable {
  return {
    min_app_version: { ...meta(), android: "1.0.0", ios: "1.0.0" },
    maintenance: { ...meta(), active: false, message: null, until: null },
    store_links: {
      ...meta(),
      android: "https://play.google.com/store/apps/details?id=id.or.kapdh.app",
      ios: null,
    },
    support: { ...meta(), email: "bantuan@kapdh.or.id", whatsapp: null },
    payment_instructions: { ...meta(), dues_hidden_platforms: [] },
    membership: { ...meta(), period_months: 12, expiring_days: 30, renewal_window_days: 30 },
    events: {
      ...meta(),
      hold_hours: 24,
      checkin_before_hours: 2,
      self_cancel_days: 3,
      review_escalation_business_days: 2,
    },
    chat: { ...meta(), max_text_chars: 4000, max_group_members: 100 },
  };
}

let state: Mutable = fixtures();
let failNextGet: number | null = null;

export function reset(): void {
  state = fixtures();
  failNextGet = null;
  settingsRequests.length = 0;
}

function log(req: MockRequest): void {
  settingsRequests.push({
    method: req.method,
    path: req.path,
    ifMatch: req.headers.get("If-Match"),
    reauth: req.headers.has("X-Reauth-Token"),
    background: req.headers.get("X-Background-Request") === "1",
    body: req.body,
  });
}

function nextMeta(current: S["AdminSettingMeta"]): S["AdminSettingMeta"] {
  return {
    version: String(Number(current.version) + 1),
    updated_at: new Date().toISOString(),
    updated_by: mockAdminRef(),
  };
}

/** Bandingkan semver MAJOR.MINOR.PATCH; >0 bila a lebih baru. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function invalid(fieldErrors: Record<string, string[]>): Response | null {
  return Object.keys(fieldErrors).length > 0
    ? error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", { field_errors: fieldErrors })
    : null;
}

/** Penjaga bersama PUT pengaturan: izin lalu If-Match versi kunci (AC F15-3, F15-4); tanpa reautentikasi. */
function guardPut(req: MockRequest, key: SettingKey): Response | null {
  log(req);
  const denied = requirePermission(req, "settings.manage");
  if (denied) return denied;
  const ifMatch = req.headers.get("If-Match");
  if (!ifMatch)
    return error(400, "VALIDATION_ERROR", "Header If-Match wajib diisi.", {
      field_errors: { "If-Match": ["Versi pengaturan wajib dikirim."] },
    });
  if (ifMatch !== state[key].version)
    return error(409, "VERSION_CONFLICT", "Pengaturan sudah diubah admin lain. Muat ulang.", {
      current: state[key],
    });
  return null;
}

async function currentFees(req: MockRequest): Promise<S["FeeSettings"]> {
  const route = paymentRoutes.find((r) => r.method === "GET" && r.path === "/admin/settings/fees");
  if (route) {
    const res = await route.handler(req);
    if (res.ok) return (await res.json()) as S["FeeSettings"];
  }
  return {
    registration_fee: "50000.00",
    card_fee: "10000.00",
    renewal_fee: "10000.00",
    registration_total: "60000.00",
    version: "1",
    effective_from: SEED_AT,
    updated_by: null,
  };
}

/** Kendali server tiruan untuk uji dan dev:mock. */
export const mockSettings = {
  /** Admin lain mengubah kunci ini (versi naik) sehingga formulir lama mendapat 409 VERSION_CONFLICT. */
  changeElsewhere(key: SettingKey, patch: Record<string, unknown> = {}): void {
    state = {
      ...state,
      [key]: {
        ...state[key],
        ...patch,
        version: String(Number(state[key].version) + 1),
        updated_at: new Date().toISOString(),
        updated_by: { admin_id: "0199e000-0000-7000-8000-0000000000b2", display_name: "Hasan Basri" },
      },
    } as Mutable;
  },
  /** GET /admin/settings berikutnya gagal dengan status ini (uji keadaan galat). */
  failNextGet(status: number): void {
    failNextGet = status;
  },
  current(): Mutable {
    return state;
  },
};

export const routes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/settings",
    handler: async (req) => {
      log(req);
      const denied = requirePermission(req, "settings.manage");
      if (denied) return denied;
      if (failNextGet !== null) {
        const status = failNextGet;
        failNextGet = null;
        return error(status, "INTERNAL_ERROR", "Terjadi kesalahan. Coba lagi.");
      }
      const body: Settings = { fees: await currentFees(req), ...state };
      return json(200, body);
    },
  },
  {
    method: "PUT",
    path: "/admin/settings/min-app-version",
    handler: (req) => {
      const guard = guardPut(req, "min_app_version");
      if (guard) return guard;
      const b = req.body ?? {};
      const fe: Record<string, string[]> = {};
      for (const p of ["android", "ios"] as const) {
        const v = b[p];
        if (typeof v !== "string" || v.length > 32 || !SEMVER.test(v))
          fe[p] = ["Gunakan format MAJOR.MINOR.PATCH, mis. 1.2.0."];
        // PRD 8.4: naikkan versi minimum hanya bila versi baru dapat diunduh (tautan toko terisi).
        else if (compareSemver(v, state.min_app_version[p]) > 0 && !state.store_links[p])
          fe[p] = ["Isi tautan toko platform ini sebelum menaikkan versi minimum."];
      }
      const bad = invalid(fe);
      if (bad) return bad;
      state.min_app_version = {
        ...nextMeta(state.min_app_version),
        android: b.android as string,
        ios: b.ios as string,
      };
      return json(200, state.min_app_version);
    },
  },
  {
    method: "PUT",
    path: "/admin/settings/maintenance",
    handler: (req) => {
      const guard = guardPut(req, "maintenance");
      if (guard) return guard;
      const b = req.body ?? {};
      const fe: Record<string, string[]> = {};
      if (typeof b.active !== "boolean") fe.active = ["Status wajib diisi."];
      const message = b.message;
      if (message !== null && (typeof message !== "string" || message.length > 500))
        fe.message = ["Pesan maksimal 500 karakter."];
      if (b.active === true && (typeof message !== "string" || message.trim() === ""))
        fe.message = ["Pesan wajib diisi saat mode pemeliharaan aktif (PRD 4.5)."];
      const until = b.until;
      if (until !== null && (typeof until !== "string" || Number.isNaN(Date.parse(until))))
        fe.until = ["Waktu tidak valid."];
      else if (typeof until === "string" && Date.parse(until) <= Date.now())
        fe.until = ["Perkiraan selesai harus di masa depan."];
      const bad = invalid(fe);
      if (bad) return bad;
      state.maintenance = {
        ...nextMeta(state.maintenance),
        active: b.active as boolean,
        message: (message as string | null) ?? null,
        until: (until as string | null) ?? null,
      };
      return json(200, state.maintenance);
    },
  },
  {
    method: "PUT",
    path: "/admin/settings/store-links",
    handler: (req) => {
      const guard = guardPut(req, "store_links");
      if (guard) return guard;
      const b = req.body ?? {};
      const fe: Record<string, string[]> = {};
      const rules = { android: /^https:\/\/play\.google\.com\//, ios: /^https:\/\/apps\.apple\.com\// };
      for (const p of ["android", "ios"] as const) {
        const v = b[p];
        if (v === null) continue;
        if (typeof v !== "string" || v.length > 500 || !rules[p].test(v))
          fe[p] = [
            p === "android"
              ? "Gunakan tautan https://play.google.com/..."
              : "Gunakan tautan https://apps.apple.com/...",
          ];
      }
      const bad = invalid(fe);
      if (bad) return bad;
      state.store_links = {
        ...nextMeta(state.store_links),
        android: (b.android as string | null) ?? null,
        ios: (b.ios as string | null) ?? null,
      };
      return json(200, state.store_links);
    },
  },
  {
    method: "PUT",
    path: "/admin/settings/support",
    handler: (req) => {
      const guard = guardPut(req, "support");
      if (guard) return guard;
      const b = req.body ?? {};
      const fe: Record<string, string[]> = {};
      if (typeof b.email !== "string" || b.email.length > 254 || !EMAIL.test(b.email))
        fe.email = ["Format email tidak valid."];
      if (b.whatsapp !== null && (typeof b.whatsapp !== "string" || !E164.test(b.whatsapp)))
        fe.whatsapp = ["Gunakan format internasional, mis. +6281234567890."];
      const bad = invalid(fe);
      if (bad) return bad;
      state.support = {
        ...nextMeta(state.support),
        email: (b.email as string).trim().toLowerCase(),
        whatsapp: (b.whatsapp as string | null) ?? null,
      };
      return json(200, state.support);
    },
  },
  {
    method: "PUT",
    path: "/admin/settings/payment-instructions",
    handler: (req) => {
      const guard = guardPut(req, "payment_instructions");
      if (guard) return guard;
      const b = req.body ?? {};
      const fe: Record<string, string[]> = {};
      const list = b.dues_hidden_platforms;
      if (
        !Array.isArray(list) ||
        list.length > 2 ||
        new Set(list).size !== list.length ||
        list.some((p) => p !== "android" && p !== "ios")
      )
        fe.dues_hidden_platforms = ["Pilih Android dan/atau iOS tanpa duplikat."];
      if (b.reason !== undefined && (typeof b.reason !== "string" || b.reason.length > 500))
        fe.reason = ["Catatan maksimal 500 karakter."];
      const bad = invalid(fe);
      if (bad) return bad;
      state.payment_instructions = {
        ...nextMeta(state.payment_instructions),
        dues_hidden_platforms: list as S["DevicePlatform"][],
      };
      return json(200, state.payment_instructions);
    },
  },
];
