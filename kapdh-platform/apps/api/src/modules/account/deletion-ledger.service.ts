import { Inject, Injectable } from "@nestjs/common";
import { accountDeletions, users } from "@kapdh/database";
import type { StorageDriver } from "@kapdh/storage";
import { eq, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { CLOCK, DB, ROOT_LOGGER, STORAGE } from "../../core/tokens.js";
import type { Clock } from "../../core/adapters/clock.js";
import { type LedgerEntry, mergeLedgerEntries } from "./deletion-ledger.js";
import { AccountDeletionProcessor } from "./deletion-processor.js";
import { DeletionRequestService } from "./deletion-request.service.js";
import { type DeletionStep, remainingPersonalData } from "./deletion-steps.js";

export interface ReapplySummary {
  entries: number;
  /** Akun yang datanya muncul kembali dari backup lalu dihapus ulang. */
  reapplied: string[];
  /** Akun yang di database pulihan sudah berstatus deleted. */
  alreadyDeleted: string[];
  /** Akun yang tidak ada di database pulihan (backup lebih tua dari pendaftarannya). */
  absent: string[];
  /** Penerapan ulang yang gagal (nomor permintaan); runbook TIDAK boleh membuka layanan. */
  failed: string[];
  objectsDeleted: number;
}

/** Langkah yang tidak diulang saat penerapan ulang: email sudah terkirim dan entri ledger sudah ada. */
function preDoneSteps(entry: LedgerEntry): DeletionStep[] {
  return entry.state === "completed"
    ? ["ledger_open", "notify_requested", "notify_completed", "ledger_final"]
    : ["ledger_open", "notify_requested"];
}

/**
 * Penerapan ulang deletion ledger eksternal setelah restore backup (AC F14-6, PRD 5.5, D2), dijalankan SEBELUM layanan
 * dibuka (CLI ledger-reapply). Per entri:
 * 1. objek storage yang tercatat di entri dihapus lagi (berkas dari backup berkas yang lebih tua);
 * 2. bila akun di database pulihan belum `deleted`: akun kembali deletion_pending (sesi lama tidak berlaku), baris
 *    permintaan dipulihkan dengan id/nomor yang sama (atau dibuat), lalu job penghapusan dijalankan sampai selesai
 *    dengan langkah yang sama (idempoten) tanpa email ulang;
 * 3. hasilnya diperiksa: tidak boleh ada sisa data pribadi.
 * Entri untuk permintaan yang belum selesai sebelum bencana (`requested`) diselesaikan sekarang termasuk email
 * penyelesaian dan entri ledger `completed`.
 */
@Injectable()
export class DeletionLedgerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORAGE) private readonly storage: StorageDriver | null,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly audit: AuditService,
    private readonly requests: DeletionRequestService,
    private readonly processor: AccountDeletionProcessor,
  ) {}

  async reapply(entries: LedgerEntry[]): Promise<ReapplySummary> {
    if (!this.storage) throw new Error("StorageDriver wajib tersedia untuk menerapkan ulang deletion ledger");
    const merged = mergeLedgerEntries(entries);
    const summary: ReapplySummary = {
      entries: merged.length,
      reapplied: [],
      alreadyDeleted: [],
      absent: [],
      failed: [],
      objectsDeleted: 0,
    };
    for (const entry of merged) {
      for (const key of entry.object_keys) {
        await this.storage.delete(key);
        summary.objectsDeleted++;
      }
      const [user] = await this.db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.id, entry.user_id));
      if (!user) {
        summary.absent.push(entry.request_number);
        continue;
      }
      if (user.status === "deleted") {
        summary.alreadyDeleted.push(entry.request_number);
        continue;
      }
      const deletionId = await this.restoreRequest(entry);
      const result = await this.processor.run(deletionId, { force: true });
      const residual = Object.values(await remainingPersonalData(this.db, entry.user_id)).some((n) => n > 0);
      if (result.outcome !== "completed" || residual) {
        summary.failed.push(entry.request_number);
        this.logger.error(
          { request_number: entry.request_number, outcome: result.outcome, residual },
          "penerapan ulang deletion ledger gagal; jangan buka layanan sebelum diselesaikan (AC F14-6)",
        );
      } else summary.reapplied.push(entry.request_number);
    }
    return summary;
  }

  /** Mengembalikan akun ke deletion_pending dan menyiapkan baris permintaan yang sama dengan entri ledger. */
  private async restoreRequest(entry: LedgerEntry): Promise<string> {
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const user = await this.requests.lockUser(tx, entry.user_id);
      if (!user) throw new Error("Akun hilang saat penerapan ulang ledger");
      const [existing] = await tx
        .select()
        .from(accountDeletions)
        .where(
          or(
            eq(accountDeletions.id, entry.deletion_id),
            eq(accountDeletions.requestNumber, entry.request_number),
          ),
        );
      const row =
        existing ??
        (await this.requests.openRequest(tx, user.id)) ??
        (await this.requests.insertRequest(tx, user.id, entry.source, new Date(entry.requested_at), {
          id: entry.deletion_id,
          requestNumber: entry.request_number,
        }));
      // Langkah berkas selalu diulang: backup berkas dapat lebih tua dari snapshot database (objek muncul lagi).
      const stepsDone = [
        ...new Set([...(row.stepsDone ?? []).filter((step) => step !== "files"), ...preDoneSteps(entry)]),
      ];
      await tx
        .update(accountDeletions)
        .set({
          status: "pending",
          completedAt: null,
          nextAttemptAt: null,
          lastError: null,
          stepsDone,
          ledger: { ...(row.ledger ?? {}), v: 1, restored: true },
          updatedAt: now,
        })
        .where(eq(accountDeletions.id, row.id));
      if (user.status !== "deletion_pending")
        await tx
          .update(users)
          .set({ status: "deletion_pending", sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now })
          .where(eq(users.id, user.id));
      await this.audit.write(tx, {
        action: "account.deletion_reapplied",
        entityType: "user",
        entityId: user.id,
        after: { request_number: entry.request_number, status: "deletion_pending" },
      });
      return row.id;
    });
  }
}
