import type { components } from "@kapdh/contracts";
import { admins, alumni, auditLogs } from "@kapdh/database";
import { and, eq, gte, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

export type AuditFilter = components["schemas"]["AuditFilter"];

/** Peran efektif pelaku (audit_logs_effective_role_chk, PRD 3.17). */
export const AUDIT_EFFECTIVE_ROLES = ["alumni", "admin", "super_admin", "system", "anonymous"] as const;

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, min > 1 ? `Minimal ${min} karakter` : "Wajib diisi")
    .max(max, `Maksimal ${max} karakter`);
const datetime = z.iso.datetime({ offset: true, message: "Format waktu tidak valid (RFC 3339)" });

/**
 * Filter audit yang SAMA untuk pencarian (query string) dan ekspor (body JSON), sehingga hasil keduanya identik
 * (AC F17-4; kontrak C7 AuditFilter). `from` inklusif dan `to` eksklusif terhadap created_at; `to` harus setelah
 * `from`. Nilai yang lolos validasi disimpan apa adanya di `after.filters` entri `audit.export.requested`.
 */
export const AuditFilterSchema = z
  .object({
    actor_q: text(2, 100).optional(),
    actor_admin_id: z.uuid("Id admin tidak valid").optional(),
    actor_user_id: z.uuid("Id akun tidak valid").optional(),
    effective_role: z.enum(AUDIT_EFFECTIVE_ROLES, { message: "Peran tidak dikenal" }).optional(),
    action: text(1, 100).optional(),
    entity_type: text(1, 64).optional(),
    entity_id: text(1, 100).optional(),
    request_id: text(1, 100).optional(),
    from: datetime.optional(),
    to: datetime.optional(),
  })
  .refine((f) => !f.from || !f.to || new Date(f.to).getTime() > new Date(f.from).getTime(), {
    path: ["to"],
    message: "Batas akhir harus setelah batas awal.",
  });

/** Bentuk kontrak AuditFilter tanpa kunci kosong (nilai `undefined` dibuang). */
export function compactFilter(filter: z.infer<typeof AuditFilterSchema>): AuditFilter {
  return Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined)) as AuditFilter;
}

/** Pola ILIKE "mengandung" dengan wildcard pengguna di-escape. */
export function containsPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Predikat SQL filter audit (dipakai pencarian, total, ekspor). `actor_q` mencocokkan nama tampilan admin pelaku atau
 * nama lengkap alumni pelaku (mengandung, tanpa beda huruf); aktor yang sudah dianonimkan (id null, D2) tidak cocok.
 */
export function auditFilterSql(filter: AuditFilter): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (filter.actor_q) {
    const pattern = containsPattern(filter.actor_q);
    conditions.push(
      or(
        sql`exists (select 1 from ${admins} where ${admins.id} = ${auditLogs.actorAdminId} and ${admins.displayName} ilike ${pattern})`,
        sql`exists (select 1 from ${alumni} where ${alumni.userId} = ${auditLogs.actorUserId} and ${alumni.fullName} ilike ${pattern})`,
      ),
    );
  }
  if (filter.actor_admin_id) conditions.push(eq(auditLogs.actorAdminId, filter.actor_admin_id));
  if (filter.actor_user_id) conditions.push(eq(auditLogs.actorUserId, filter.actor_user_id));
  if (filter.effective_role) conditions.push(eq(auditLogs.effectiveRole, filter.effective_role));
  if (filter.action) conditions.push(eq(auditLogs.action, filter.action));
  if (filter.entity_type) conditions.push(eq(auditLogs.entityType, filter.entity_type));
  if (filter.entity_id) conditions.push(eq(auditLogs.entityId, filter.entity_id));
  if (filter.request_id) conditions.push(eq(auditLogs.requestId, filter.request_id));
  if (filter.from) conditions.push(gte(auditLogs.createdAt, new Date(filter.from)));
  if (filter.to) conditions.push(lt(auditLogs.createdAt, new Date(filter.to)));
  return conditions.length > 0 ? and(...conditions) : undefined;
}
