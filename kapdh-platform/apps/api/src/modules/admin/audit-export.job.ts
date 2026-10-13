import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { auditLogs } from "@kapdh/database";
import { and, count, desc, eq, inArray, lte } from "drizzle-orm";
import { Readable } from "node:stream";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { ADVISORY_LOCK_NAMESPACES, advisoryXactLockFor } from "../../core/db/locks.js";
import type { Db, Tx } from "../../core/db/types.js";
import { FilesService } from "../../core/files/files.service.js";
import type { JobContext, OutboxEvent } from "../../core/jobs/job-registry.js";
import { JobRegistry } from "../../core/jobs/job-registry.js";
import { safeError } from "../../core/logging/safe-error.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { type AuditFilter, AuditFilterSchema, auditFilterSql, compactFilter } from "./audit-filter.js";
import { auditKeysetAfter, auditRowsQuery, type AuditRowWithPayload } from "./audit.service.js";
import {
  AUDIT_EXPORT_MAX_ATTEMPTS,
  AUDIT_EXPORT_RETENTION_MS,
  AUDIT_EXPORT_ROW_LIMIT,
  AUDIT_EXPORT_TIMEOUT_MS,
  EXPORT_COMPLETED,
  EXPORT_ENTITY,
  EXPORT_FAILED,
  EXPORT_REQUESTED,
} from "./audit-export.shared.js";
import { AUDIT_CSV_HEADER, auditCsvRow, csvRow } from "./csv.js";

/** Ukuran batch keyset saat menulis CSV (memori terbatas walau ekspor besar). */
const BATCH = 500;

type FailureReason = "row_limit_exceeded" | "processing_failed" | "timed_out";

/** Galat terkendali di dalam transaksi job: membatalkan berkas lalu (opsional) menulis entri gagal. */
class ExportStop extends Error {
  constructor(readonly reason: FailureReason | null) {
    super(reason ?? "stopped");
    this.name = "ExportStop";
  }
}

interface ExportRequest {
  exportId: string;
  requestedAt: Date;
  ownerUserId: string | null;
  filters: AuditFilter | null;
}

/**
 * Job `audit.export` (ARCHITECTURE §4.8, topik `audit.export.requested`; AC F17-3, F17-4; kontrak C7 AuditExport).
 *
 * Satu transaksi per percobaan: pg_advisory_xact_lock atas id ekspor, periksa ulang bahwa belum ada entri terminal dan
 * batas waktu belum lewat, hitung hasil filter (lebih dari batas baris = gagal `row_limit_exceeded`, tidak pernah
 * dipotong diam-diam), tulis CSV per batch keyset dengan filter yang SAMA dengan pencarian (penyamaran kolom privat +
 * netralisasi formula), simpan sebagai berkas privat `audit_export` milik akun login peminta dengan kedaluwarsa, lalu
 * entri `audit.export.completed` {file_id, row_count} di transaksi yang sama. Tepat satu entri terminal per ekspor.
 * Job yang dimulai atau selesai setelah batas waktu berhenti tanpa berkas (status turunan failed/timed_out).
 * Galat sementara diulang lewat retry outbox; setelah AUDIT_EXPORT_MAX_ATTEMPTS ditulis `processing_failed`.
 */
@Injectable()
export class AuditExportJob implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly jobs: JobRegistry,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerTopicHandler({
      topic: "audit.export.requested",
      handle: (event, ctx) => this.handle(event, ctx),
    });
  }

  async handle(event: OutboxEvent<"audit.export.requested">, ctx: JobContext): Promise<void> {
    const request = await this.loadRequest(event.payload.export_id);
    if (!request) {
      ctx.logger.warn({ export_id: event.payload.export_id }, "permintaan ekspor audit tidak ditemukan; dilewati");
      return;
    }
    try {
      await this.run(request);
    } catch (error) {
      if (error instanceof ExportStop) {
        if (error.reason) await this.fail(request, error.reason);
        return;
      }
      ctx.logger.error(
        { export_id: request.exportId, attempts: event.attempts, error: safeError(error) },
        "ekspor audit gagal",
      );
      if (event.attempts >= AUDIT_EXPORT_MAX_ATTEMPTS) {
        await this.fail(request, "processing_failed");
        return;
      }
      throw error;
    }
  }

  private async loadRequest(exportId: string): Promise<ExportRequest | null> {
    const [row] = await this.db
      .select({ createdAt: auditLogs.createdAt, actorUserId: auditLogs.actorUserId, after: auditLogs.after })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, EXPORT_ENTITY),
          eq(auditLogs.entityId, exportId),
          eq(auditLogs.action, EXPORT_REQUESTED),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    if (!row) return null;
    const stored = (row.after as { filters?: unknown } | null)?.filters ?? {};
    const parsed = AuditFilterSchema.safeParse(stored);
    return {
      exportId,
      requestedAt: row.createdAt,
      ownerUserId: row.actorUserId,
      filters: parsed.success ? compactFilter(parsed.data) : null,
    };
  }

  /** true bila entri terminal sudah ada (diperiksa di bawah kunci advisory). */
  private async hasTerminal(tx: Tx, exportId: string): Promise<boolean> {
    const [row] = await tx
      .select({ n: count() })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, EXPORT_ENTITY),
          eq(auditLogs.entityId, exportId),
          inArray(auditLogs.action, [EXPORT_COMPLETED, EXPORT_FAILED]),
        ),
      );
    return Number(row?.n ?? 0) > 0;
  }

  private deadlinePassed(request: ExportRequest): boolean {
    return this.clock.now().getTime() > request.requestedAt.getTime() + AUDIT_EXPORT_TIMEOUT_MS;
  }

  private async run(request: ExportRequest): Promise<void> {
    if (!request.filters) throw new ExportStop("processing_failed");
    const filters = request.filters;
    const stored: { objectKey: string | null } = { objectKey: null };
    try {
      await this.db.transaction(async (tx) => {
        await advisoryXactLockFor(tx, ADVISORY_LOCK_NAMESPACES.auditExport, request.exportId);
        if (await this.hasTerminal(tx, request.exportId)) throw new ExportStop(null);
        if (this.deadlinePassed(request)) throw new ExportStop(null);

        // Batas atas waktu: baris yang dibuat setelah job dimulai tidak ikut, sehingga hitungan dan isi berkas sama.
        const cutoff = this.clock.now();
        const where = and(auditFilterSql(filters), lte(auditLogs.createdAt, cutoff));
        const [total] = await tx.select({ n: count() }).from(auditLogs).where(where);
        if (Number(total?.n ?? 0) > AUDIT_EXPORT_ROW_LIMIT) throw new ExportStop("row_limit_exceeded");

        let rowCount = 0;
        const generate = async function* (): AsyncGenerator<Buffer> {
          yield Buffer.from(csvRow([...AUDIT_CSV_HEADER]), "utf8");
          let after: { created_at: Date; id: string } | null = null;
          for (;;) {
            const rows: AuditRowWithPayload[] = await auditRowsQuery(tx)
              .where(and(where, after ? auditKeysetAfter(after, "desc") : undefined))
              .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
              .limit(BATCH);
            if (rows.length === 0) return;
            const chunk = rows.map((row) => auditCsvRow(row)).join("");
            rowCount += rows.length;
            if (rowCount > AUDIT_EXPORT_ROW_LIMIT) throw new ExportStop("row_limit_exceeded");
            yield Buffer.from(chunk, "utf8");
            const last = rows[rows.length - 1]!;
            after = { created_at: last.createdAt, id: last.id };
            if (rows.length < BATCH) return;
          }
        };

        const file = await this.files.storeGenerated({
          ownerUserId: request.ownerUserId,
          purpose: "audit_export",
          mime: "text/csv",
          body: Readable.from(generate()),
          expiresAt: new Date(this.clock.now().getTime() + AUDIT_EXPORT_RETENTION_MS),
          tx,
        });
        stored.objectKey = file.objectKey;
        // Job yang selesai setelah batas waktu berhenti tanpa berkas (kontrak C7).
        if (this.deadlinePassed(request)) throw new ExportStop(null);
        await this.audit.write(tx, {
          action: EXPORT_COMPLETED,
          entityType: EXPORT_ENTITY,
          entityId: request.exportId,
          after: { file_id: file.id, row_count: rowCount },
        });
      });
    } catch (error) {
      // Baris berkas ikut batal bersama transaksi; objek storage dibuang agar tidak ada berkas yatim.
      if (stored.objectKey) await this.files.deleteStoredObject(stored.objectKey);
      throw unwrapStop(error);
    }
  }

  /** Menulis tepat satu entri `audit.export.failed` (dilewati bila sudah ada entri terminal atau lewat batas waktu). */
  private async fail(request: ExportRequest, reason: FailureReason): Promise<void> {
    await this.db.transaction(async (tx) => {
      await advisoryXactLockFor(tx, ADVISORY_LOCK_NAMESPACES.auditExport, request.exportId);
      if (await this.hasTerminal(tx, request.exportId)) return;
      // Lewat batas waktu tanpa entri terminal sudah berstatus failed/timed_out (turunan); tidak ditimpa.
      if (reason !== "timed_out" && this.deadlinePassed(request)) return;
      await this.audit.write(tx, {
        action: EXPORT_FAILED,
        entityType: EXPORT_ENTITY,
        entityId: request.exportId,
        after: { failure_reason: reason },
      });
    });
  }
}

/** Galat dari stream (storage.put) dapat membungkus ExportStop; ambil penyebab aslinya. */
function unwrapStop(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof ExportStop) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}
