import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumniProfessions, alumniSkills, masterProfessions, masterSkills } from "@kapdh/database";
import { and, count, eq, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import { isFkViolation, isUniqueViolation } from "../../core/db/errors.js";
import type { Db, DbOrTx } from "../../core/db/types.js";
import { AppException, notFound, versionConflict } from "../../core/errors/app-exception.js";
import { decodeCursor, encodeCursor, parsePageQuery } from "../../core/pagination/cursor.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { queryBool, UUID_PATTERN, validate, validateQuery } from "../../core/validation/validate.js";
import { escapeLike, hasControlChar, hasNul } from "./directory.query.js";

type AdminMasterItem = components["schemas"]["AdminMasterItem"];
type AdminMasterPage = components["schemas"]["AdminMasterPage"];
export type MasterKind = components["schemas"]["MasterKind"];
type AdminMasterSort = components["schemas"]["AdminMasterSort"];

/**
 * master_professions dan master_skills berstruktur identik (PRD 6.2: id, label, active, sort_order, version,
 * created_at, updated_at). Tabel keahlian diperlakukan dengan tipe tabel profesi agar satu implementasi melayani
 * kedua jenis; kolom tetap merujuk objek tabelnya sendiri sehingga SQL yang dihasilkan menyebut tabel yang benar.
 */
type MasterTable = typeof masterProfessions;
type MasterRow = typeof masterProfessions.$inferSelect;

interface MasterSpec {
  table: MasterTable;
  /** Jumlah alumni pemakai: subkueri berkorelasi pada tabel relasi (indeks *_profession_id_idx / *_skill_id_idx). */
  usage: SQL<number>;
  /** entity_type audit (AC F17-1). */
  entityType: "master_profession" | "master_skill";
  /** Indeks unik label tanpa membedakan huruf besar/kecil. */
  labelKey: string;
}

const MASTERS: Readonly<Record<MasterKind, MasterSpec>> = {
  professions: {
    table: masterProfessions,
    usage:
      sql<number>`(select count(*) from ${alumniProfessions} where ${alumniProfessions.professionId} = ${masterProfessions.id})`.mapWith(
        Number,
      ),
    entityType: "master_profession",
    labelKey: "master_professions_label_key",
  },
  skills: {
    table: masterSkills as unknown as MasterTable,
    usage:
      sql<number>`(select count(*) from ${alumniSkills} where ${alumniSkills.skillId} = ${masterSkills.id})`.mapWith(
        Number,
      ),
    entityType: "master_skill",
    labelKey: "master_skills_label_key",
  },
};

const MASTER_KINDS: readonly MasterKind[] = ["professions", "skills"];

/** Path `{kind}` (MasterKindPath); nilai lain 400 VALIDATION_ERROR pada field kind. */
export function parseMasterKind(raw: unknown): MasterKind {
  if (typeof raw === "string" && (MASTER_KINDS as readonly string[]).includes(raw)) return raw as MasterKind;
  throw new AppException(400, "VALIDATION_ERROR", "Jenis master tidak valid.", {
    fieldErrors: { kind: ["Jenis master hanya professions atau skills"] },
  });
}

/** Label: spasi tepi dipangkas lalu 1..100 karakter, tanpa karakter kontrol (master_*_label_chk). */
const labelSchema = z
  .string({ message: "Label wajib berupa teks" })
  .trim()
  .min(1, "Label wajib diisi")
  .max(100, "Label maksimal 100 karakter")
  .refine((value) => !/\p{Cc}/u.test(value), "Label tidak boleh memuat karakter kontrol");
const sortOrderSchema = z
  .number({ message: "Urutan harus berupa angka" })
  .int("Urutan harus bilangan bulat")
  .min(-32768, "Minimal -32768")
  .max(32767, "Maksimal 32767");

const createSchema = z.strictObject({
  label: labelSchema,
  active: z.boolean({ message: "Gunakan true atau false" }).default(true),
  sort_order: sortOrderSchema.default(0),
});

const updateSchema = z
  .strictObject({
    label: labelSchema.optional(),
    active: z.boolean({ message: "Gunakan true atau false" }).optional(),
    sort_order: sortOrderSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Kirim minimal satu perubahan.", path: ["_"] });

const listQuerySchema = z.object({
  // Teks bebas tanpa karakter kontrol, sama dengan aturan label (NUL → PostgreSQL 22021; harus 400, PRD 5.2).
  q: z
    .string({ message: "Kata kunci tidak valid" })
    .trim()
    .min(1, "Kata kunci wajib diisi")
    .max(100)
    .refine((value) => !hasControlChar(value), "Kata kunci tidak boleh memuat karakter kontrol")
    .optional(),
  active: queryBool().optional(),
  sort: z
    .enum(["manual", "label_asc", "label_desc", "usage_desc"], {
      message: "Gunakan manual, label_asc, label_desc atau usage_desc",
    })
    .optional(),
});

/**
 * Isi cursor dibatasi pada nilai yang dapat dihasilkan server dan diterima kolomnya (cursor rusak/dimanipulasi → 400
 * field `cursor`, bukan galat database 500): sort_order dalam rentang smallint (22003 bila di luar), label terurut
 * tanpa NUL (22021), jumlah pemakaian bilangan bulat aman >= 0.
 */
const uuidValue = z.string().regex(UUID_PATTERN);
const cursorLabel = z
  .string()
  .max(1000)
  .refine((value) => !hasNul(value));
const cursorSortOrder = z.number().int().min(-32768).max(32767);
const cursorUsage = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positionSchema = z.discriminatedUnion("s", [
  z.object({ s: z.literal("manual"), o: cursorSortOrder, l: cursorLabel, id: uuidValue }),
  z.object({ s: z.literal("label_asc"), l: cursorLabel, id: uuidValue }),
  z.object({ s: z.literal("label_desc"), l: cursorLabel, id: uuidValue }),
  z.object({ s: z.literal("usage_desc"), u: cursorUsage, l: cursorLabel, id: uuidValue }),
]);
type MasterPosition = z.infer<typeof positionSchema>;

interface KeysetKey {
  expr: SQL | MasterTable["id"] | MasterTable["sortOrder"];
  value: unknown;
  direction: "asc" | "desc";
}

/** (k1 > v1) OR (k1 = v1 AND k2 > v2) OR … dengan arah campuran; urutan sama dengan ORDER BY. */
function keysetAfter(keys: KeysetKey[]): SQL {
  const branches = keys.map((key, index) => {
    const equalities = keys.slice(0, index).map((prev) => sql`${prev.expr} = ${prev.value}`);
    const step = key.direction === "asc" ? sql`${key.expr} > ${key.value}` : sql`${key.expr} < ${key.value}`;
    return and(...equalities, step)!;
  });
  return or(...branches)!;
}

const invalidCursor = () =>
  new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
    fieldErrors: { cursor: ["Cursor tidak valid. Muat ulang daftar dari awal."] },
  });

const duplicateLabel = () =>
  new AppException(409, "VALIDATION_ERROR", "Label sudah ada pada daftar master ini.", {
    fieldErrors: {
      label: [
        "Label sudah dipakai (termasuk master nonaktif). Aktifkan kembali master yang lama bila diperlukan.",
      ],
    },
  });

const masterInUse = (current: AdminMasterItem) =>
  new AppException(
    409,
    "VALIDATION_ERROR",
    `Master masih dipakai ${current.usage_count} alumni sehingga tidak dapat dihapus. Nonaktifkan agar label lama tetap tampil.`,
    {
      fieldErrors: {
        _: [
          "Master yang masih dipakai tidak dapat dihapus; nonaktifkan sebagai gantinya (label historis tetap tampil).",
        ],
      },
      current,
    },
  );

/**
 * Pengelolaan master profesi dan keahlian oleh pengurus (F-15, guideline hal. 16 "Manajemen Skill & Profesi";
 * AC F10-4, F15-4, F17-1). Master terpakai tidak dapat dihapus (FK RESTRICT) dan dinonaktifkan sebagai gantinya,
 * sehingga profil lama tetap menampilkan label historisnya. Setiap perubahan diaudit dalam transaksi yang sama.
 */
@Injectable()
export class MastersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** GET /admin/masters/{kind}: aktif dan nonaktif, jumlah pemakaian, filter, paging keyset dan total. */
  async list(kind: MasterKind, query: unknown): Promise<AdminMasterPage> {
    const { table, usage } = MASTERS[kind];
    const page = parsePageQuery(query);
    const params = validateQuery(listQuerySchema, query);
    const sort: AdminMasterSort = params.sort ?? "manual";
    const after = page.cursor ? decodeCursor(page.cursor, positionSchema) : null;
    if (after && after.s !== sort) throw invalidCursor();

    const label = sql<string>`lower(${table.label})`;
    const filters: SQL[] = [];
    if (params.q !== undefined)
      filters.push(sql`${label} like lower(${`%${escapeLike(params.q)}%`}) escape '\\'`);
    if (params.active !== undefined) filters.push(eq(table.active, params.active));
    const where = filters.length > 0 ? and(...filters) : undefined;

    const order: KeysetKey[] = (() => {
      switch (sort) {
        case "manual":
          return [
            { expr: table.sortOrder, value: after?.s === "manual" ? after.o : null, direction: "asc" },
            { expr: label, value: after?.l, direction: "asc" },
            { expr: table.id, value: after?.id, direction: "asc" },
          ];
        case "label_asc":
          return [
            { expr: label, value: after?.l, direction: "asc" },
            { expr: table.id, value: after?.id, direction: "asc" },
          ];
        case "label_desc":
          return [
            { expr: label, value: after?.l, direction: "desc" },
            { expr: table.id, value: after?.id, direction: "desc" },
          ];
        case "usage_desc":
          return [
            { expr: usage, value: after?.s === "usage_desc" ? after.u : null, direction: "desc" },
            { expr: label, value: after?.l, direction: "asc" },
            { expr: table.id, value: after?.id, direction: "asc" },
          ];
      }
    })();

    return this.db.transaction(
      async (tx) => {
        const found = await tx
          .select({ row: table, usage, sortLabel: label })
          .from(table)
          .where(after ? and(where, keysetAfter(order)) : where)
          .orderBy(
            ...order.map((key) => (key.direction === "asc" ? sql`${key.expr} asc` : sql`${key.expr} desc`)),
          )
          .limit(page.limit + 1);
        const [counted] = await tx.select({ total: count() }).from(table).where(where);
        const hasMore = found.length > page.limit;
        const pageRows = hasMore ? found.slice(0, page.limit) : found;
        const last = pageRows[pageRows.length - 1];
        let position: MasterPosition | null = null;
        if (hasMore && last) {
          const base = { l: last.sortLabel, id: last.row.id };
          if (sort === "manual") position = { s: "manual", o: last.row.sortOrder, ...base };
          else if (sort === "usage_desc") position = { s: "usage_desc", u: last.usage, ...base };
          else position = { s: sort, ...base };
        }
        return {
          items: pageRows.map(({ row, usage: used }) => toItem(kind, row, used)),
          next_cursor: position ? encodeCursor(position) : null,
          total: Number(counted?.total ?? 0),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /** GET /admin/masters/{kind}/{masterId}: detail untuk formulir ubah (version dan usage_count). */
  async get(kind: MasterKind, masterId: string): Promise<AdminMasterItem> {
    const current = await this.load(this.db, kind, masterId);
    if (!current) throw notFound("Master tidak ditemukan.");
    return current;
  }

  /** POST /admin/masters/{kind}: label unik per jenis tanpa membedakan huruf besar/kecil; audit master.created. */
  async create(kind: MasterKind, raw: unknown): Promise<AdminMasterItem> {
    const { table, entityType, labelKey } = MASTERS[kind];
    const body = validate(createSchema, raw);
    const now = this.clock.now();
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(table)
          .values({
            id: uuidv7(),
            label: body.label,
            active: body.active,
            sortOrder: body.sort_order,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await this.audit.write(tx, {
          action: "master.created",
          entityType,
          entityId: row!.id,
          after: snapshot(kind, row!),
        });
        return toItem(kind, row!, 0);
      });
    } catch (error) {
      if (isUniqueViolation(error, labelKey)) throw duplicateLabel();
      throw error;
    }
  }

  /**
   * PATCH /admin/masters/{kind}/{masterId} (AC F10-4, F15-4): baris dikunci lalu versi If-Match dibandingkan; versi
   * berbeda → 409 VERSION_CONFLICT dengan `current`. Menonaktifkan hanya menghentikan pemilihan baru; label historis
   * pada profil tetap tampil. Audit master.updated dengan before/after.
   */
  async update(
    kind: MasterKind,
    masterId: string,
    ifMatch: string | undefined,
    raw: unknown,
  ): Promise<AdminMasterItem> {
    const { table, entityType, labelKey } = MASTERS[kind];
    const expected = parseIfMatch(ifMatch);
    const body = validate(updateSchema, raw);
    const now = this.clock.now();
    try {
      return await this.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(table).where(eq(table.id, masterId)).for("update");
        if (!locked) throw notFound("Master tidak ditemukan.");
        const used = await this.usageOf(tx, kind, masterId);
        if (locked.version !== expected) throw versionConflict(toItem(kind, locked, used));
        const next = {
          label: body.label ?? locked.label,
          active: body.active ?? locked.active,
          sortOrder: body.sort_order ?? locked.sortOrder,
        };
        // Tidak ada perubahan nyata: kembalikan keadaan sekarang tanpa menaikkan versi maupun audit.
        if (
          next.label === locked.label &&
          next.active === locked.active &&
          next.sortOrder === locked.sortOrder
        )
          return toItem(kind, locked, used);
        const [row] = await tx
          .update(table)
          .set({ ...next, version: sql`${table.version} + 1`, updatedAt: now })
          .where(and(eq(table.id, masterId), eq(table.version, expected)))
          .returning();
        await this.audit.write(tx, {
          action: "master.updated",
          entityType,
          entityId: masterId,
          before: snapshot(kind, locked),
          after: snapshot(kind, row!),
        });
        return toItem(kind, row!, used);
      });
    } catch (error) {
      if (isUniqueViolation(error, labelKey)) throw duplicateLabel();
      throw error;
    }
  }

  /**
   * DELETE /admin/masters/{kind}/{masterId} (AC F10-4): hanya master yang belum pernah dipakai. Baris master dikunci
   * FOR UPDATE sehingga pemasangan profesi/keahlian bersamaan (FK mengambil KEY SHARE pada baris master) menunggu
   * keputusan ini; master terpakai → 409 VALIDATION_ERROR dengan `current` dan saran menonaktifkan.
   */
  async remove(kind: MasterKind, masterId: string, ifMatch: string | undefined): Promise<void> {
    const { table, entityType } = MASTERS[kind];
    const expected = parseIfMatch(ifMatch);
    try {
      await this.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(table).where(eq(table.id, masterId)).for("update");
        if (!locked) throw notFound("Master tidak ditemukan.");
        const used = await this.usageOf(tx, kind, masterId);
        if (locked.version !== expected) throw versionConflict(toItem(kind, locked, used));
        if (used > 0) throw masterInUse(toItem(kind, locked, used));
        await tx.delete(table).where(and(eq(table.id, masterId), eq(table.version, expected)));
        await this.audit.write(tx, {
          action: "master.deleted",
          entityType,
          entityId: masterId,
          before: snapshot(kind, locked),
        });
      });
    } catch (error) {
      // Jaring pengaman FK RESTRICT (23503 PostgreSQL 17 / 23001 PGlite): tetap 409 dengan keadaan terbaru.
      if (isFkViolation(error)) {
        const current = await this.load(this.db, kind, masterId);
        if (!current) throw notFound("Master tidak ditemukan.");
        throw masterInUse(current);
      }
      throw error;
    }
  }

  private async load(db: DbOrTx, kind: MasterKind, masterId: string): Promise<AdminMasterItem | null> {
    const { table, usage } = MASTERS[kind];
    const [found] = await db.select({ row: table, usage }).from(table).where(eq(table.id, masterId)).limit(1);
    return found ? toItem(kind, found.row, found.usage) : null;
  }

  private async usageOf(db: DbOrTx, kind: MasterKind, masterId: string): Promise<number> {
    const { table, usage } = MASTERS[kind];
    const [found] = await db.select({ usage }).from(table).where(eq(table.id, masterId)).limit(1);
    return found?.usage ?? 0;
  }
}

function toItem(kind: MasterKind, row: MasterRow, usageCount: number): AdminMasterItem {
  return {
    id: row.id,
    kind,
    label: row.label,
    active: row.active,
    sort_order: row.sortOrder,
    usage_count: Number(usageCount),
    version: String(row.version),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Isi audit before/after (tanpa data pribadi). */
function snapshot(kind: MasterKind, row: MasterRow) {
  return { kind, label: row.label, active: row.active, sort_order: row.sortOrder, version: row.version };
}
