/**
 * Utilitas murni ekspor CSV audit (AC F17-3, N-09; kontrak C7 adminCreateAuditExport). Diuji unit di csv.test.ts.
 *
 * 1. Penyamaran kolom privat dan secret pada before/after: penelusuran objek dan array pada kedalaman berapa pun,
 *    pencocokan nama kunci tanpa membedakan huruf besar/kecil (camelCase dinormalkan ke snake_case agar lebih
 *    konservatif). Nilai bukan null diganti `[disembunyikan]`; nama kunci dan null tetap ada.
 * 2. Netralisasi formula: sel yang diawali `=`, `+`, `-`, `@`, tab atau carriage return diberi awalan apostrof.
 * 3. Kutipan RFC 4180: setiap sel tidak kosong dikutip ganda dan kutip di dalamnya digandakan; baris diakhiri CRLF.
 */

export const MASKED_VALUE = "[disembunyikan]";

/** Pola kunci privat/secret (tabel kontrak C7: kontak, data pribadi, foto/berkas, perangkat, secret). */
const PRIVATE_KEY_PATTERNS: readonly RegExp[] = [
  // kontak
  /^email$/,
  /_email$/,
  /^phone$/,
  /_phone$/,
  /^whatsapp$/,
  /_whatsapp$/,
  /^social_/,
  // data pribadi
  /^address$/,
  /_address$/,
  /^birth_date$/,
  /^birth_place$/,
  /^date_of_birth$/,
  /^city$/,
  // foto dan berkas pribadi
  /^avatar_file_id$/,
  /^avatar_url$/,
  /^photo_/,
  /^proof_/,
  // perangkat dan jaringan
  /^ip$/,
  /^ip_address$/,
  /^user_agent$/,
  /^device_name$/,
  // secret (pertahanan ganda; AuditService sudah menyaring saat tulis)
  /^password/,
  /_hash$/,
  /^otp/,
  /token/,
  /secret/,
  /^backup_code/,
  /^totp/,
  /^nik$/,
  /^ktp$/,
  /account_number/,
];

/** Nama kunci dinormalkan: camelCase -> snake_case, huruf kecil. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

export function isPrivateExportKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return PRIVATE_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Penyamaran rekursif before/after untuk berkas ekspor (bukan untuk tampilan di dalam sistem). */
export function maskPrivateFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => maskPrivateFields(item));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (isPrivateExportKey(key)) result[key] = inner === null || inner === undefined ? null : MASKED_VALUE;
      else result[key] = maskPrivateFields(inner);
    }
    return result;
  }
  return value;
}

/** AC F17-3: sel yang dapat dieksekusi spreadsheet sebagai formula dinetralkan dengan awalan apostrof. */
export function neutralizeFormula(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}

/** Satu sel CSV: null/undefined menjadi sel kosong; selain itu dinetralkan lalu dikutip (RFC 4180). */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = neutralizeFormula(String(value));
  if (text === "") return "";
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** Kolom CSV audit sesuai urutan kontrak. */
export const AUDIT_CSV_HEADER = [
  "created_at",
  "action",
  "entity_type",
  "entity_id",
  "effective_role",
  "actor_admin_id",
  "actor_user_id",
  "actor_name",
  "request_id",
  "reason",
  "before",
  "after",
] as const;

export interface AuditCsvEntry {
  createdAt: Date;
  action: string;
  entityType: string;
  entityId: string | null;
  effectiveRole: string;
  actorAdminId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  requestId: string;
  reason: string | null;
  before: unknown;
  after: unknown;
}

function jsonCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(maskPrivateFields(value));
}

/** Satu baris CSV audit: before/after disamarkan lalu diserialisasi JSON; setiap sel dinetralkan. */
export function auditCsvRow(entry: AuditCsvEntry): string {
  return csvRow([
    entry.createdAt.toISOString(),
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.effectiveRole,
    entry.actorAdminId,
    entry.actorUserId,
    entry.actorName,
    entry.requestId,
    entry.reason,
    jsonCell(entry.before),
    jsonCell(entry.after),
  ]);
}
