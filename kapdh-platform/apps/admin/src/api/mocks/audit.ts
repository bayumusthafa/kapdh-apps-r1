import { mockCurrentIdentity, requirePermission } from "./auth";
import { error, json, type MockRequest, type MockRoute, paginate, type S } from "./http";

/**
 * Tiruan audit dan ekspor CSV (kontrak admin-audit C7, F-17, AC F17-2..F17-4): pencarian dan ekspor memakai filter
 * yang SAMA (nama dan arti identik, `from` inklusif, `to` eksklusif); item daftar tanpa before/after; ekspor
 * diminta (202 processing) lalu diproses "worker" menjadi ready/failed; unduhan lewat URL bertanda tangan <=10 menit
 * yang izin dan kepemilikannya diperiksa setiap kali (status selain ready = 409 dengan `current`; expired = 404).
 * Data contoh bukan bukti AC (PRD 7.3).
 */
type Entry = S["AuditEntryDetail"];
type Export = S["AuditExport"];
type Filter = S["AuditFilter"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ["alumni", "admin", "super_admin", "system", "anonymous"] as const;
/** Batas baris ekspor tiruan (konfigurasi server); hasil lebih besar = failed row_limit_exceeded. */
export const MOCK_EXPORT_ROW_LIMIT = 30;
/** dev:mock: ekspor selesai otomatis setelah jeda ini; uji memakai mockAudit.finishExports(). */
const AUTO_COMPLETE_MS = import.meta.env.MODE === "mock" ? 3_000 : Number.POSITIVE_INFINITY;
const FILE_TTL_MS = 24 * 3_600_000;

export interface AuditRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  idempotencyKey: string | null;
  background: boolean;
  body: Record<string, unknown> | null;
}

/** Log permintaan audit (uji: filter pencarian = filter ekspor, header latar polling). */
export const auditRequests: AuditRequestLog[] = [];

interface ExportState {
  id: string;
  filters: Filter;
  requestedBy: S["AdminActorRef"];
  requestedAt: string;
  outcome: { kind: "ready"; at: string; rowCount: number; bytes: number; expiresAt: string } | { kind: "failed"; at: string; reason: S["AuditExportFailureReason"] } | null;
}

let entries: Entry[] = [];
let exports: ExportState[] = [];
const replays = new Map<string, { payload: string; body: unknown }>();
let seq = 0;
let nextFailure: S["AuditExportFailureReason"] | null = null;

const ADMINS = {
  bayu: { admin_id: "0199e000-0000-7000-8000-0000000000ad", user_id: "0199e000-0000-7000-8000-0000000001ad", name: "Bayu Musthafa" },
  ahmad: { admin_id: "0199e000-0000-7000-8000-0000000000b2", user_id: "0199e000-0000-7000-8000-0000000001b2", name: "Ahmad Zulhadi" },
};
const ALUMNI = { user_id: "0199e000-0000-7000-8000-0000000000c1", name: "ridwan" };

function hex(n: number, width = 12): string {
  return n.toString(16).padStart(width, "0");
}

function fixtures(): Entry[] {
  const base = Date.parse("2026-10-12T10:00:00Z");
  const out: Entry[] = [];
  const add = (
    minutesAgo: number,
    action: string,
    entityType: string,
    actor: "bayu" | "ahmad" | "alumni" | "system",
    extra: Omit<Partial<Entry>, "before" | "after"> & {
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
    } = {},
  ) => {
    const n = out.length + 1;
    const a =
      actor === "system"
        ? { admin_id: null, user_id: null, display_name: null }
        : actor === "alumni"
          ? { admin_id: null, user_id: ALUMNI.user_id, display_name: ALUMNI.name }
          : { admin_id: ADMINS[actor].admin_id, user_id: ADMINS[actor].user_id, display_name: ADMINS[actor].name };
    out.push({
      id: `0199e000-0000-7000-8000-a0${hex(n, 10)}`,
      created_at: new Date(base - minutesAgo * 60_000).toISOString(),
      action,
      entity_type: entityType,
      entity_id: `0199e000-0000-7000-8000-e0${hex(n, 10)}`,
      effective_role:
        actor === "system" ? "system" : actor === "alumni" ? "alumni" : actor === "bayu" ? "super_admin" : "admin",
      actor: a,
      request_id: `req-${hex(n, 6)}`,
      reason: null,
      ...extra,
      // before/after berbentuk bebas per tindakan (kontrak AuditEntryDetail: object|null).
      before: (extra.before ?? null) as Entry["before"],
      after: (extra.after ?? null) as Entry["after"],
    });
  };
  add(5, "payment.approved", "payment", "ahmad", {
    before: { status: "pending", proof_version: 1 },
    after: { status: "paid", decided_at: "2026-10-12T09:55:00Z" },
  });
  add(12, "admin.invited", "admin", "bayu", {
    after: { display_name: "Rina Kartika", email: "rina@kapdh.test", role: "admin", permissions: ["members.read"] },
  });
  add(30, "settings.updated", "app_setting", "bayu", {
    entity_id: "maintenance",
    reason: "Pemeliharaan server terjadwal",
    before: { active: false, message: null },
    after: { active: true, message: "Pemeliharaan 30 menit" },
  });
  add(45, "payment.rejected", "payment", "ahmad", {
    reason: "Nominal tidak sesuai",
    before: { status: "pending" },
    after: { status: "rejected" },
  });
  add(60, "member.suspended", "alumni", "bayu", {
    reason: "Spam berulang di grup",
    before: { suspended_at: null },
    after: { suspended_at: "2026-10-12T09:00:00Z", phone: "+6281234567890" },
  });
  add(90, "account.deletion.requested", "account_deletion", "alumni");
  add(120, "audit.export.completed", "audit_export", "system", { after: { file_id: "f-1", row_count: 12 } });
  for (let i = 0; i < 26; i += 1)
    add(150 + i * 30, i % 2 === 0 ? "admin.login" : "moderation.report_viewed", i % 2 === 0 ? "admin" : "report", i % 3 === 0 ? "bayu" : "ahmad");
  return out;
}

export function reset(): void {
  entries = fixtures();
  exports = [];
  replays.clear();
  seq = 0;
  nextFailure = null;
  auditRequests.length = 0;
}
reset();

function log(req: MockRequest): void {
  auditRequests.push({
    method: req.method,
    path: req.path,
    query: Object.fromEntries(req.url.searchParams.entries()),
    idempotencyKey: req.headers.get("Idempotency-Key"),
    background: req.headers.get("X-Background-Request") === "1",
    body: req.body,
  });
}

/** Validasi filter bersama pencarian dan ekspor (AC F17-4). */
function parseFilter(raw: Record<string, unknown>): { filter: Filter } | { response: Response } {
  const fe: Record<string, string[]> = {};
  const f: Filter = {};
  const str = (k: keyof Filter, min: number, max: number) => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") return;
    if (typeof v !== "string" || v.length < min || v.length > max) fe[k] = [`Isi ${min}-${max} karakter.`];
    else (f as Record<string, string>)[k] = v;
  };
  str("actor_q", 2, 100);
  str("action", 1, 100);
  str("entity_type", 1, 64);
  str("entity_id", 1, 100);
  str("request_id", 1, 100);
  for (const k of ["actor_admin_id", "actor_user_id"] as const) {
    const v = raw[k];
    if (v === undefined || v === "") continue;
    if (typeof v !== "string" || !UUID.test(v)) fe[k] = ["Id tidak valid."];
    else f[k] = v;
  }
  const role = raw.effective_role;
  if (role !== undefined && role !== "") {
    if (!ROLES.includes(role as (typeof ROLES)[number])) fe.effective_role = ["Peran tidak dikenal."];
    else f.effective_role = role as S["AuditEffectiveRole"];
  }
  for (const k of ["from", "to"] as const) {
    const v = raw[k];
    if (v === undefined || v === "") continue;
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) fe[k] = ["Waktu tidak valid."];
    else f[k] = v;
  }
  if (f.from && f.to && Date.parse(f.to) <= Date.parse(f.from)) fe.to = ["Batas akhir harus setelah batas awal."];
  if (Object.keys(fe).length > 0)
    return { response: error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", { field_errors: fe }) };
  return { filter: f };
}

function matches(e: Entry, f: Filter): boolean {
  if (f.actor_q && !(e.actor.display_name ?? "").toLowerCase().includes(f.actor_q.toLowerCase())) return false;
  if (f.actor_admin_id && e.actor.admin_id !== f.actor_admin_id) return false;
  if (f.actor_user_id && e.actor.user_id !== f.actor_user_id) return false;
  if (f.effective_role && e.effective_role !== f.effective_role) return false;
  if (f.action && e.action !== f.action) return false;
  if (f.entity_type && e.entity_type !== f.entity_type) return false;
  if (f.entity_id && e.entity_id !== f.entity_id) return false;
  if (f.request_id && e.request_id !== f.request_id) return false;
  if (f.from && Date.parse(e.created_at) < Date.parse(f.from)) return false;
  if (f.to && Date.parse(e.created_at) >= Date.parse(f.to)) return false;
  return true;
}

function listItem(e: Entry): S["AuditEntry"] {
  return {
    id: e.id,
    created_at: e.created_at,
    action: e.action,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    effective_role: e.effective_role,
    actor: e.actor,
    request_id: e.request_id,
    reason: e.reason,
  };
}

/** Status turunan sesuai urutan prioritas kontrak AuditExport. */
function present(x: ExportState): Export {
  const now = Date.now();
  if (!x.outcome && now - Date.parse(x.requestedAt) >= AUTO_COMPLETE_MS) complete(x);
  const o = x.outcome;
  const day = x.requestedAt.slice(0, 10).replace(/-/g, "");
  const fileName = `audit-${day}-${x.id.replace(/-/g, "").slice(0, 8)}.csv`;
  if (o?.kind === "ready") {
    const expired = Date.parse(o.expiresAt) <= now;
    return {
      id: x.id,
      status: expired ? "expired" : "ready",
      filters: x.filters,
      requested_by: x.requestedBy,
      requested_at: x.requestedAt,
      completed_at: o.at,
      expires_at: o.expiresAt,
      row_count: o.rowCount,
      file_name: fileName,
      bytes: o.bytes,
      failure_reason: null,
    };
  }
  return {
    id: x.id,
    status: o?.kind === "failed" ? "failed" : "processing",
    filters: x.filters,
    requested_by: x.requestedBy,
    requested_at: x.requestedAt,
    completed_at: o?.kind === "failed" ? o.at : null,
    expires_at: null,
    row_count: null,
    file_name: null,
    bytes: null,
    failure_reason: o?.kind === "failed" ? o.reason : null,
  };
}

function complete(x: ExportState): void {
  if (x.outcome) return;
  const at = new Date().toISOString();
  if (nextFailure) {
    x.outcome = { kind: "failed", at, reason: nextFailure };
    nextFailure = null;
    return;
  }
  const rowCount = entries.filter((e) => matches(e, x.filters)).length;
  if (rowCount > MOCK_EXPORT_ROW_LIMIT) {
    x.outcome = { kind: "failed", at, reason: "row_limit_exceeded" };
    return;
  }
  x.outcome = {
    kind: "ready",
    at,
    rowCount,
    bytes: 180 + rowCount * 210,
    expiresAt: new Date(Date.now() + FILE_TTL_MS).toISOString(),
  };
}

/** Ekspor yang terlihat pemanggil: milik sendiri, atau semua untuk Super Admin (kontrak adminListAuditExports). */
function visible(): ExportState[] {
  const me = mockCurrentIdentity();
  return exports.filter((x) => me.role === "super_admin" || x.requestedBy.admin_id === me.admin_id);
}

function guard(req: MockRequest, withExport: boolean): Response | null {
  log(req);
  return (
    requirePermission(req, "audit.read") ?? (withExport ? requirePermission(req, "audit.export") : null)
  );
}

/** Kendali server tiruan untuk uji dan dev:mock. */
export const mockAudit = {
  /** "Worker" menyelesaikan semua ekspor yang masih diproses. */
  finishExports(): void {
    for (const x of exports) complete(x);
  },
  /** Ekspor berikutnya yang diselesaikan gagal dengan alasan ini. */
  failNextExport(reason: S["AuditExportFailureReason"]): void {
    nextFailure = reason;
  },
  /** Berkas ekspor siap dihapus pembersihan otomatis (status menjadi expired). */
  expireExports(): void {
    for (const x of exports) if (x.outcome?.kind === "ready") x.outcome.expiresAt = new Date(Date.now() - 1).toISOString();
  },
  exportCount(): number {
    return exports.length;
  },
};

export const routes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/audit/entries",
    handler: (req) => {
      const denied = guard(req, false);
      if (denied) return denied;
      const parsed = parseFilter(Object.fromEntries(req.url.searchParams.entries()));
      if ("response" in parsed) return parsed.response;
      const sort = req.url.searchParams.get("sort") ?? "created_at_desc";
      const items = entries
        .filter((e) => matches(e, parsed.filter))
        .sort((a, b) =>
          sort === "created_at_asc" ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at),
        )
        .map(listItem);
      return json(200, paginate(items, req.url) satisfies S["AuditEntryPage"]);
    },
  },
  {
    method: "GET",
    path: "/admin/audit/entries/{entryId}",
    handler: (req) => {
      const denied = guard(req, false);
      if (denied) return denied;
      const id = req.params.entryId ?? "";
      if (!UUID.test(id))
        return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          field_errors: { entryId: ["Id entri tidak valid."] },
        });
      const e = entries.find((x) => x.id === id);
      return e ? json(200, e) : error(404, "NOT_FOUND", "Entri audit tidak ditemukan.");
    },
  },
  {
    method: "POST",
    path: "/admin/audit/exports",
    handler: (req) => {
      const denied = guard(req, true);
      if (denied) return denied;
      const key = req.headers.get("Idempotency-Key");
      const payload = JSON.stringify(req.body ?? {});
      const prior = key ? replays.get(key) : undefined;
      if (prior) {
        if (prior.payload !== payload)
          return error(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah dipakai untuk permintaan lain.");
        return json(202, prior.body);
      }
      const parsed = parseFilter(req.body ?? {});
      if ("response" in parsed) return parsed.response;
      seq += 1;
      const me = mockCurrentIdentity();
      const x: ExportState = {
        id: `0199e000-0000-7000-8000-b0${hex(seq, 10)}`,
        filters: parsed.filter,
        requestedBy: { admin_id: me.admin_id, display_name: me.display_name },
        requestedAt: new Date().toISOString(),
        outcome: null,
      };
      exports.unshift(x);
      const body = present(x);
      if (key) replays.set(key, { payload, body });
      return json(202, body);
    },
  },
  {
    method: "GET",
    path: "/admin/audit/exports",
    handler: (req) => {
      const denied = guard(req, true);
      if (denied) return denied;
      const status = req.url.searchParams.get("status");
      const items = visible()
        .map(present)
        .filter((x) => !status || x.status === status);
      return json(200, paginate(items, req.url) satisfies S["AuditExportPage"]);
    },
  },
  {
    method: "GET",
    path: "/admin/audit/exports/{exportId}",
    handler: (req) => {
      const denied = guard(req, true);
      if (denied) return denied;
      const x = visible().find((e) => e.id === req.params.exportId);
      return x ? json(200, present(x)) : error(404, "NOT_FOUND", "Ekspor tidak ditemukan.");
    },
  },
  {
    method: "GET",
    path: "/admin/audit/exports/{exportId}/access",
    handler: (req) => {
      const denied = guard(req, true);
      if (denied) return denied;
      const x = visible().find((e) => e.id === req.params.exportId);
      if (!x) return error(404, "NOT_FOUND", "Ekspor tidak ditemukan.");
      const current = present(x);
      if (current.status === "expired") return error(404, "NOT_FOUND", "Berkas ekspor sudah dihapus otomatis.");
      if (current.status !== "ready")
        return error(409, "VERSION_CONFLICT", "Ekspor belum siap diunduh.", { current });
      return json(200, {
        url: `https://files.kapdh.test/signed/${current.file_name}?sig=mock&exp=600`,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        file_name: current.file_name!,
      } satisfies S["AuditExportAccess"]);
    },
  },
];
