import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { paymentMethods, payments } from "@kapdh/database";
import { and, asc, count, eq, exists, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db, DbOrTx } from "../../core/db/types.js";
import { AppException, notFound, versionConflict } from "../../core/errors/app-exception.js";
import { decodeCursor, keysetAfter, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { queryBool, validateQuery } from "../../core/validation/validate.js";
import type { PaymentMethodRow } from "./payment-rules.js";

type AdminPaymentMethod = components["schemas"]["AdminPaymentMethod"];

const text = (label: string, max: number) =>
  z
    .string({ message: `${label} wajib diisi` })
    .trim()
    .min(1, `${label} wajib diisi`)
    .max(max, `${label} maksimal ${max} karakter`);

/** Isi lengkap metode (kontrak PaymentMethodInput; POST dan PUT penggantian penuh). */
export const paymentMethodInputSchema = z.object({
  kind: z.enum(["bank", "ewallet"], { message: "Pilih jenis rekening" }),
  provider: text("Nama bank atau e-wallet", 80),
  account_number: text("Nomor rekening", 64),
  account_holder: text("Nama pemilik rekening", 120),
  instructions: z
    .string()
    .max(1000, "Petunjuk maksimal 1000 karakter")
    .refine((value) => !/<[^>]*>/.test(value), "Petunjuk berupa teks polos tanpa HTML")
    .nullable(),
  active: z.boolean({ message: "Pilih status aktif" }),
  sort_order: z.number().int().min(0).max(32767),
});
export type PaymentMethodInput = z.infer<typeof paymentMethodInputSchema>;

export const methodListQuery = z.object({ active: queryBool().optional() });

/** Identitas rekening yang dikunci setelah metode dipakai payment (kontrak adminUpdatePaymentMethod). */
const IDENTITY_FIELDS = ["kind", "provider", "account_number", "account_holder"] as const;

/**
 * Metode bayar oleh pengurus settings.manage (F-15, AC F15-3, F15-4, D13): perubahan wajib reautentikasi (dekorator),
 * diaudit di transaksi yang sama, If-Match untuk ubah/hapus. Metode yang sudah dirujuk payment hanya dapat
 * dinonaktifkan dan identitas rekeningnya tetap; baris metode dikunci FOR UPDATE sehingga tidak ada payment baru yang
 * menyalin isi lama (pembuatan payment mengunci FOR SHARE).
 */
@Injectable()
export class AdminPaymentMethodsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async list(query: unknown): Promise<components["schemas"]["AdminPaymentMethodPage"]> {
    const page = parsePageQuery(query);
    const filters = validateQuery(methodListQuery, query);
    const where = filters.active === undefined ? undefined : eq(paymentMethods.active, filters.active);
    const after = page.cursor
      ? decodeCursor(
          page.cursor,
          z.object({ sort_order: z.number().int(), provider: z.string(), id: z.uuid() }),
        )
      : null;
    const rows = await this.db
      .select({ method: paymentMethods, inUse: this.inUseSql() })
      .from(paymentMethods)
      .where(
        and(
          where,
          after
            ? keysetAfter([
                { column: paymentMethods.sortOrder, value: after.sort_order, direction: "asc" },
                { column: paymentMethods.provider, value: after.provider, direction: "asc" },
                { column: paymentMethods.id, value: after.id, direction: "asc" },
              ])
            : undefined,
        ),
      )
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.provider), asc(paymentMethods.id))
      .limit(page.limit + 1);
    const [total] = await this.db.select({ n: count() }).from(paymentMethods).where(where);
    return pageOf(rows, page.limit, {
      total: Number(total?.n ?? 0),
      cursorOf: (row) => ({
        sort_order: row.method.sortOrder,
        provider: row.method.provider,
        id: row.method.id,
      }),
      toItem: (row) => toAdminMethod(row.method, row.inUse),
    });
  }

  async get(methodId: string, db: DbOrTx = this.db): Promise<AdminPaymentMethod> {
    const [row] = await db
      .select({ method: paymentMethods, inUse: this.inUseSql() })
      .from(paymentMethods)
      .where(eq(paymentMethods.id, methodId))
      .limit(1);
    if (!row) throw notFound("Metode pembayaran tidak ditemukan.");
    return toAdminMethod(row.method, row.inUse);
  }

  async create(input: PaymentMethodInput): Promise<AdminPaymentMethod> {
    const id = await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          id: uuidv7(),
          kind: input.kind,
          provider: input.provider,
          accountNumber: input.account_number,
          accountHolder: input.account_holder,
          instructions: normalizeInstructions(input.instructions),
          active: input.active,
          sortOrder: input.sort_order,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await this.audit.write(tx, {
        action: "payment_method.created",
        entityType: "payment_method",
        entityId: row!.id,
        after: auditView(row!),
      });
      return row!.id;
    });
    return this.get(id);
  }

  /** Penggantian penuh (AC F15-3, F15-4): identitas rekening metode in_use tidak dapat diubah (400 per field). */
  async update(
    methodId: string,
    expectedVersion: number,
    input: PaymentMethodInput,
  ): Promise<AdminPaymentMethod> {
    await this.db.transaction(async (tx) => {
      const current = await this.lockMethod(tx, methodId);
      if (current.version !== expectedVersion) throw versionConflict(await this.get(methodId, tx));
      if (await this.inUse(tx, methodId)) {
        const before = {
          kind: current.kind,
          provider: current.provider,
          account_number: current.accountNumber,
          account_holder: current.accountHolder,
        };
        const changed = IDENTITY_FIELDS.filter((field) => before[field] !== input[field]);
        if (changed.length > 0)
          throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
            fieldErrors: Object.fromEntries(
              changed.map((field) => [
                field,
                [
                  "Metode ini sudah dipakai pembayaran sehingga rekeningnya tidak dapat diubah. Nonaktifkan lalu buat metode baru.",
                ],
              ]),
            ),
          });
      }
      const now = this.clock.now();
      const [updated] = await tx
        .update(paymentMethods)
        .set({
          kind: input.kind,
          provider: input.provider,
          accountNumber: input.account_number,
          accountHolder: input.account_holder,
          instructions: normalizeInstructions(input.instructions),
          active: input.active,
          sortOrder: input.sort_order,
          version: sql`${paymentMethods.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.version, expectedVersion)))
        .returning();
      await this.audit.write(tx, {
        action: "payment_method.updated",
        entityType: "payment_method",
        entityId: methodId,
        before: auditView(current),
        after: auditView(updated!),
      });
    });
    return this.get(methodId);
  }

  /** Hapus hanya metode yang belum pernah dipakai; selain itu 400 (nonaktifkan saja). */
  async delete(methodId: string, expectedVersion: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await this.lockMethod(tx, methodId);
      if (current.version !== expectedVersion) throw versionConflict(await this.get(methodId, tx));
      if (await this.inUse(tx, methodId))
        throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          fieldErrors: { _: ["Metode sudah dipakai pembayaran, nonaktifkan saja agar histori tetap utuh."] },
        });
      await tx.delete(paymentMethods).where(eq(paymentMethods.id, methodId));
      await this.audit.write(tx, {
        action: "payment_method.deleted",
        entityType: "payment_method",
        entityId: methodId,
        before: auditView(current),
      });
    });
  }

  private async lockMethod(tx: DbOrTx, methodId: string): Promise<PaymentMethodRow> {
    const [row] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, methodId)).for("update");
    if (!row) throw notFound("Metode pembayaran tidak ditemukan.");
    return row;
  }

  /**
   * Dirujuk payment (kontrak AdminPaymentMethod.in_use): sebagai metode asal yang tertaut (`payment_method_id`) atau
   * sebagai snapshot rekening tujuan (`method_snapshot.id`, termasuk payment yang tautannya sudah kosong). Selama ada
   * rujukan, identitas rekening dikunci sehingga tidak ada snapshot yang diam-diam berbeda dari rekening berlaku
   * (AC F15-3). Metode yang sudah ditinggalkan semua payment (anggota mengganti rekening sebelum bukti, PRD 4.3) tidak
   * lagi dirujuk snapshot mana pun.
   */
  private async inUse(db: DbOrTx, methodId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(referencesMethod(sql`${methodId}::uuid`))
      .limit(1);
    return Boolean(row);
  }

  private inUseSql(): SQL<boolean> {
    return sql<boolean>`${exists(
      this.db
        .select({ one: sql`1` })
        .from(payments)
        .where(referencesMethod(paymentMethods.id)),
    )}`.mapWith(Boolean);
  }
}

/** Payment merujuk metode lewat payment_method_id atau snapshot `method_snapshot.id`. */
function referencesMethod(methodId: SQL | typeof paymentMethods.id): SQL {
  return or(
    eq(payments.paymentMethodId, methodId),
    sql`(${payments.methodSnapshot} ->> 'id') = (${methodId})::text`,
  )!;
}

function normalizeInstructions(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function toAdminMethod(row: PaymentMethodRow, inUse: boolean): AdminPaymentMethod {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    account_number: row.accountNumber,
    account_holder: row.accountHolder,
    instructions: row.instructions,
    active: row.active,
    sort_order: row.sortOrder,
    in_use: inUse,
    version: String(row.version),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Audit metode (AC F17-1): rekening ORGANISASI, tetapi nomor lengkap tidak disalin (kunci account_number dibuang
 * sanitizer); empat digit terakhir cukup untuk akuntabilitas perubahan.
 */
function auditView(row: PaymentMethodRow) {
  return {
    kind: row.kind,
    provider: row.provider,
    account_suffix: row.accountNumber.slice(-4),
    account_holder: row.accountHolder,
    instructions: row.instructions,
    active: row.active,
    sort_order: row.sortOrder,
    version: row.version,
  };
}
