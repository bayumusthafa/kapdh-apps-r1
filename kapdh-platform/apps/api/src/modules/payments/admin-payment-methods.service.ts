import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { files, paymentMethods, payments } from "@kapdh/database";
import { and, asc, count, eq, exists, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db, DbOrTx } from "../../core/db/types.js";
import { AppException, fieldError, notFound, versionConflict } from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { decodeCursor, keysetAfter, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { queryBool, validateQuery } from "../../core/validation/validate.js";
import type { PaymentMethodRow } from "./payment-rules.js";
import { PaymentViews } from "./payment-views.js";

type AdminPaymentMethod = components["schemas"]["AdminPaymentMethod"];

const text = (label: string, max: number) =>
  z
    .string({ message: `${label} wajib diisi` })
    .trim()
    .min(1, `${label} wajib diisi`)
    .max(max, `${label} maksimal ${max} karakter`);

/**
 * Isi lengkap metode (kontrak PaymentMethodInput; POST dan PUT penggantian penuh). `qr_image_file_id` (ADR-026):
 * tidak dikirim = gambar tetap (POST: tanpa gambar), null = tanpa gambar, UUID = gambar baru hasil
 * POST /admin/payment-qr-images. Konsistensi dengan `kind` diperiksa layanan setelah nilai efektifnya diketahui.
 */
export const paymentMethodInputSchema = z.object({
  kind: z.enum(["bank", "ewallet", "qris"], { message: "Pilih jenis rekening" }),
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
  qr_image_file_id: z.union([z.uuid("Gambar QRIS tidak valid"), z.null()]).optional(),
});
export type PaymentMethodInput = z.infer<typeof paymentMethodInputSchema>;

export const methodListQuery = z.object({ active: queryBool().optional() });

/**
 * Cursor keyset daftar metode dalam rentang kolom skema (sort_order smallint): cursor yang dimanipulasi menjadi
 * 400 VALIDATION_ERROR field `cursor`, bukan 500 overflow smallint (kontrak root.yaml Cursor, PRD 7.3).
 */
const methodCursorSchema = z.object({
  sort_order: z.number().int().min(-32768).max(32767),
  provider: z.string().min(1).max(256),
  id: z.uuid(),
});

/**
 * Identitas rekening yang dikunci setelah metode dipakai payment (kontrak adminUpdatePaymentMethod). Gambar QRIS
 * (`qr_image_file_id`, ADR-026) juga identitas, diperiksa terpisah karena nilainya boleh tidak dikirim (tetap).
 */
const IDENTITY_FIELDS = ["kind", "provider", "account_number", "account_holder"] as const;

const IN_USE_LOCKED =
  "Metode ini sudah dipakai pembayaran sehingga rekeningnya tidak dapat diubah. Nonaktifkan lalu buat metode baru.";
const QR_REQUIRED = "Gambar QRIS wajib diunggah.";
const QR_ONLY_FOR_QRIS = "Gambar QR hanya untuk metode QRIS.";

/** Gambar QR efektif: tidak dikirim = gambar saat ini (POST: tanpa gambar), null = tanpa gambar, UUID = baru. */
function effectiveQrImage(input: PaymentMethodInput, current: string | null): string | null {
  return input.qr_image_file_id === undefined ? current : input.qr_image_file_id;
}

/** qris wajib bergambar, jenis lain tanpa gambar (payment_methods_qr_image_chk, ADR-026). */
function assertQrImageMatchesKind(kind: PaymentMethodInput["kind"], image: string | null): void {
  if (kind === "qris" && !image) throw fieldError("qr_image_file_id", QR_REQUIRED);
  if (kind !== "qris" && image) throw fieldError("qr_image_file_id", QR_ONLY_FOR_QRIS);
}

/** Jejak gambar untuk audit: id + sha256 berkas (bukan isi), agar QR yang disahkan bendahara dapat dicocokkan. */
interface QrImageAudit {
  id: string;
  sha256: string | null;
}

/**
 * Metode bayar oleh pengurus settings.manage (F-15, AC F15-3, F15-4, D13): perubahan diaudit di transaksi yang sama,
 * If-Match untuk ubah/hapus; tanpa reautentikasi sejak keputusan PO 2026-10-15 (ADR-025). Metode yang sudah dirujuk
 * payment hanya dapat dinonaktifkan dan identitas rekeningnya (termasuk gambar QRIS) tetap; baris metode dikunci
 * FOR UPDATE sehingga tidak ada payment baru yang menyalin isi lama (pembuatan payment mengunci FOR SHARE).
 *
 * Metode qris (ADR-026): gambar `payment_qr` milik pengunggah dilampirkan (`FilesService.attach`) di transaksi yang
 * sama dengan INSERT/UPDATE; gambar yang diganti/dihapus dan gambar metode yang dihapus dibuang (`discard`, objek
 * storage dihapus setelah commit). Audit mencatat id dan sha256 gambar.
 */
@Injectable()
export class AdminPaymentMethodsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly views: PaymentViews,
  ) {}

  async list(query: unknown): Promise<components["schemas"]["AdminPaymentMethodPage"]> {
    const page = parsePageQuery(query);
    const filters = validateQuery(methodListQuery, query);
    const where = filters.active === undefined ? undefined : eq(paymentMethods.active, filters.active);
    const after = page.cursor ? decodeCursor(page.cursor, methodCursorSchema) : null;
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
      toItem: (row) => this.toAdminMethod(row.method, row.inUse),
    });
  }

  async get(methodId: string, db: DbOrTx = this.db): Promise<AdminPaymentMethod> {
    const [row] = await db
      .select({ method: paymentMethods, inUse: this.inUseSql() })
      .from(paymentMethods)
      .where(eq(paymentMethods.id, methodId))
      .limit(1);
    if (!row) throw notFound("Metode pembayaran tidak ditemukan.");
    return this.toAdminMethod(row.method, row.inUse);
  }

  /** Metode baru; gambar QRIS (wajib untuk qris) dilampirkan di transaksi yang sama (ADR-026). */
  async create(auth: AuthContext, input: PaymentMethodInput): Promise<AdminPaymentMethod> {
    const image = effectiveQrImage(input, null);
    assertQrImageMatchesKind(input.kind, image);
    const id = await this.db.transaction(async (tx) => {
      const attached = image
        ? await this.files.attach(tx, image, auth.userId, "payment_qr", { field: "qr_image_file_id" })
        : null;
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
          qrImageFileId: attached?.id ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await this.audit.write(tx, {
        action: "payment_method.created",
        entityType: "payment_method",
        entityId: row!.id,
        after: auditView(row!, attached),
      });
      return row!.id;
    });
    return this.get(id);
  }

  /**
   * Penggantian penuh (AC F15-3, F15-4): identitas rekening metode in_use, termasuk gambar QRIS, tidak dapat diubah
   * (400 per field). Gambar baru dilampirkan dan gambar lama dibuang di transaksi yang sama (ADR-026).
   */
  async update(
    auth: AuthContext,
    methodId: string,
    expectedVersion: number,
    input: PaymentMethodInput,
  ): Promise<AdminPaymentMethod> {
    await this.db.transaction(async (tx) => {
      const current = await this.lockMethod(tx, methodId);
      if (current.version !== expectedVersion) throw versionConflict(await this.get(methodId, tx));
      const image = effectiveQrImage(input, current.qrImageFileId);
      if (await this.inUse(tx, methodId)) {
        const before = {
          kind: current.kind,
          provider: current.provider,
          account_number: current.accountNumber,
          account_holder: current.accountHolder,
        };
        const changed: string[] = IDENTITY_FIELDS.filter((field) => before[field] !== input[field]);
        if (image !== current.qrImageFileId) changed.push("qr_image_file_id");
        if (changed.length > 0)
          throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
            fieldErrors: Object.fromEntries(changed.map((field) => [field, [IN_USE_LOCKED]])),
          });
      }
      assertQrImageMatchesKind(input.kind, image);
      const replaced = image !== current.qrImageFileId;
      const attached =
        replaced && image
          ? await this.files.attach(tx, image, auth.userId, "payment_qr", { field: "qr_image_file_id" })
          : null;
      const previous = await this.qrImageAudit(tx, current.qrImageFileId);
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
          qrImageFileId: image,
          version: sql`${paymentMethods.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.version, expectedVersion)))
        .returning();
      // Gambar lama tidak lagi dirujuk metode ini dan tidak pernah dirujuk payment (metode in_use tidak boleh
      // mengganti gambar), sehingga aman dibuang; objek storage dihapus setelah commit.
      if (replaced && current.qrImageFileId) await this.files.discard(tx, current.qrImageFileId);
      await this.audit.write(tx, {
        action: "payment_method.updated",
        entityType: "payment_method",
        entityId: methodId,
        before: auditView(current, previous),
        after: auditView(updated!, replaced ? attached : previous),
      });
    });
    return this.get(methodId);
  }

  /** Hapus hanya metode yang belum pernah dipakai; selain itu 400 (nonaktifkan saja). Gambar QRIS ikut dibuang. */
  async delete(methodId: string, expectedVersion: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await this.lockMethod(tx, methodId);
      if (current.version !== expectedVersion) throw versionConflict(await this.get(methodId, tx));
      if (await this.inUse(tx, methodId))
        throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          fieldErrors: { _: ["Metode sudah dipakai pembayaran, nonaktifkan saja agar histori tetap utuh."] },
        });
      const image = await this.qrImageAudit(tx, current.qrImageFileId);
      await tx.delete(paymentMethods).where(eq(paymentMethods.id, methodId));
      if (current.qrImageFileId) await this.files.discard(tx, current.qrImageFileId);
      await this.audit.write(tx, {
        action: "payment_method.deleted",
        entityType: "payment_method",
        entityId: methodId,
        before: auditView(current, image),
      });
    });
  }

  private async lockMethod(tx: DbOrTx, methodId: string): Promise<PaymentMethodRow> {
    const [row] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, methodId)).for("update");
    if (!row) throw notFound("Metode pembayaran tidak ditemukan.");
    return row;
  }

  /** Id + sha256 gambar QRIS untuk audit (null bila metode tanpa gambar). */
  private async qrImageAudit(db: DbOrTx, fileId: string | null): Promise<QrImageAudit | null> {
    if (!fileId) return null;
    const [row] = await db.select({ sha256: files.sha256 }).from(files).where(eq(files.id, fileId)).limit(1);
    return { id: fileId, sha256: row?.sha256 ?? null };
  }

  private toAdminMethod(row: PaymentMethodRow, inUse: boolean): AdminPaymentMethod {
    return {
      id: row.id,
      kind: row.kind,
      provider: row.provider,
      account_number: row.accountNumber,
      account_holder: row.accountHolder,
      instructions: row.instructions,
      qr_image_url: this.views.qrImageUrl(row.kind, row.qrImageFileId),
      qr_image_file_id: row.qrImageFileId,
      active: row.active,
      sort_order: row.sortOrder,
      in_use: inUse,
      version: String(row.version),
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  /**
   * PERNAH dirujuk payment (kontrak AdminPaymentMethod.in_use "Pernah dirujuk payment"): sebagai metode yang tertaut
   * (`payment_method_id`), sebagai snapshot rekening tujuan (`method_snapshot.id`, termasuk payment yang tautannya
   * sudah kosong), atau sebagai metode yang ditinggalkan saat anggota mengganti rekening sebelum bukti
   * (`method_snapshot.previous_method_ids`, PRD 4.3). Rujukan ini permanen, sehingga identitas rekening tetap terkunci
   * dan metode hanya dapat dinonaktifkan, tidak dihapus (AC F15-3).
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

/**
 * Payment pernah merujuk metode lewat payment_method_id, snapshot `method_snapshot.id`, atau
 * `method_snapshot.previous_method_ids` (StoredMethodSnapshot di payment-rules.ts).
 */
function referencesMethod(methodId: SQL | typeof paymentMethods.id): SQL {
  return or(
    eq(payments.paymentMethodId, methodId),
    sql`(${payments.methodSnapshot} ->> 'id') = (${methodId})::text`,
    sql`coalesce(${payments.methodSnapshot} -> 'previous_method_ids', '[]'::jsonb) @> jsonb_build_array((${methodId})::text)`,
  )!;
}

function normalizeInstructions(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Audit metode (AC F17-1): rekening ORGANISASI, tetapi nomor lengkap tidak disalin (kunci account_number dibuang
 * sanitizer); empat digit terakhir cukup untuk akuntabilitas perubahan. Gambar QRIS dicatat sebagai id + sha256 berkas
 * (ADR-026) agar QR yang pernah disahkan dapat dicocokkan dengan sidik jari pada bukti gerbang go-live.
 */
function auditView(row: PaymentMethodRow, image: QrImageAudit | null = null) {
  return {
    kind: row.kind,
    provider: row.provider,
    account_suffix: row.accountNumber.slice(-4),
    account_holder: row.accountHolder,
    instructions: row.instructions,
    active: row.active,
    sort_order: row.sortOrder,
    qr_image_file_id: row.qrImageFileId,
    qr_image_sha256: row.qrImageFileId && image?.id === row.qrImageFileId ? image.sha256 : null,
    version: row.version,
  };
}
