import { Inject, Injectable } from "@nestjs/common";
import { accountDeletions, users } from "@kapdh/database";
import type { StorageDriver } from "@kapdh/storage";
import { and, eq, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { CLOCK, DB, ROOT_LOGGER, STORAGE } from "../../core/tokens.js";
import type { Clock } from "../../core/adapters/clock.js";
import { safeError } from "../../core/logging/safe-error.js";
import {
  advanceLedgerHead,
  type LedgerEntry,
  ledgerObjectKey,
  mergeLedgerEntries,
  readLedgerObject,
  writeLedgerEntry,
} from "./deletion-ledger.js";
import { deletionDeadline } from "./deletion-policy.js";
import { AccountDeletionProcessor } from "./deletion-processor.js";
import { DeletionRequestService } from "./deletion-request.service.js";
import { DELETION_STEPS, type DeletionStep, remainingPersonalData } from "./deletion-steps.js";

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
 * 0. entri ditulis kembali ke ledger di storage pulihan bila belum ada atau kurang lengkap;
 * 1. objek storage yang tercatat di entri dihapus lagi (berkas dari backup berkas yang lebih tua);
 * 2. bila akun di database pulihan belum `deleted`: akun kembali deletion_pending (sesi lama tidak berlaku), baris
 *    permintaan dipulihkan dengan id/nomor yang sama (atau dibuat), lalu job penghapusan dijalankan sampai selesai
 *    dengan langkah yang sama (idempoten) tanpa email ulang;
 * 3. hasilnya diperiksa: tidak boleh ada sisa data pribadi.
 * Entri untuk permintaan yang belum selesai sebelum bencana (`requested`) diselesaikan sekarang termasuk email
 * penyelesaian dan entri ledger `completed`.
 *
 * Akun yang TIDAK ADA di database pulihan (mendaftar setelah titik backup) tetap dicatat: baris account_deletions
 * `completed` dengan id/nomor yang sama (tanpa data pribadi, `ledger.absent`) dibuat agar database mengenal
 * permintaan itu (readiness API, AC F14-6) dan membawa `member_seq_floor`. Floor N dari entri ledger disimpan di baris
 * permintaan yang dipulihkan; MembershipKernel.allocateMemberNumber melompati N sampai di atas floor itu, sehingga N
 * anggota yang dihapus tidak pernah dialokasikan ulang (PRD 3.5, 6.4) walau worker tidak memegang hak sequence.
 * Kepala ledger di storage dimajukan untuk setiap entri.
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
      try {
        await this.reapplyEntry(this.storage, entry, summary);
      } catch (error) {
        // Galat satu entri tidak menghentikan entri lain, tetapi CLI keluar 1 sehingga layanan tidak dibuka.
        summary.failed.push(entry.request_number);
        this.logger.error(
          { request_number: entry.request_number, error: safeError(error) },
          "penerapan ulang deletion ledger gagal; jangan buka layanan sebelum diselesaikan (AC F14-6)",
        );
      }
    }
    return summary;
  }

  private async reapplyEntry(
    storage: StorageDriver,
    entry: LedgerEntry,
    summary: ReapplySummary,
  ): Promise<void> {
    // Ledger di storage pulihan berasal dari backup berkas lama: entri yang lebih baru ditulis kembali agar ledger
    // tetap lengkap untuk restore berikutnya.
    await this.restoreLedgerObject(storage, entry);
    for (const key of entry.object_keys) {
      await storage.delete(key);
      summary.objectsDeleted++;
    }
    const [user] = await this.db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, entry.user_id));
    if (!user) {
      await this.recordAbsent(entry);
      summary.absent.push(entry.request_number);
      return;
    }
    if (user.status === "deleted") {
      await this.recordFloor(entry);
      summary.alreadyDeleted.push(entry.request_number);
      return;
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

  /**
   * Menulis entri ke storage bila belum ada atau yang tersimpan kurang lengkap (requested < completed), lalu memajukan
   * kepala ledger (permintaan terbaru dan floor N) agar readiness dan restore berikutnya melihat ledger lengkap.
   */
  private async restoreLedgerObject(storage: StorageDriver, entry: LedgerEntry): Promise<void> {
    const key = ledgerObjectKey(entry.request_number, new Date(entry.requested_at));
    const stored = (await storage.exists(key))
      ? await readLedgerObject(storage, key).catch(() => null)
      : null;
    if (!stored || (stored.state === "requested" && entry.state === "completed"))
      await writeLedgerEntry(storage, entry);
    await advanceLedgerHead(storage, entry, this.clock.now());
  }

  /**
   * Akun tidak ada di database pulihan (mendaftar setelah titik backup): tidak ada data untuk dihapus, tetapi permintaan
   * dicatat sebagai baris account_deletions `completed` (id dan nomor dari ledger; account_deletions.user_id tanpa FK)
   * agar database mengenal permintaan itu dan floor N-nya. Idempoten: baris yang sudah ada hanya dilengkapi floor-nya.
   */
  private async recordAbsent(entry: LedgerEntry): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: accountDeletions.id })
        .from(accountDeletions)
        .where(
          or(
            eq(accountDeletions.id, entry.deletion_id),
            eq(accountDeletions.requestNumber, entry.request_number),
          ),
        );
      if (existing) return;
      const now = this.clock.now();
      const requestedAt = new Date(entry.requested_at);
      await tx.insert(accountDeletions).values({
        id: entry.deletion_id,
        requestNumber: entry.request_number,
        userId: entry.user_id,
        source: entry.source,
        status: "completed",
        stepsDone: [...DELETION_STEPS],
        requestedAt,
        deadlineAt: deletionDeadline(requestedAt),
        completedAt: entry.completed_at ? new Date(entry.completed_at) : now,
        ledger: {
          v: 1,
          restored: true,
          absent: true,
          ...(entry.member_seq_floor === undefined ? {} : { member_seq_floor: entry.member_seq_floor }),
        },
        createdAt: now,
        updatedAt: now,
      });
      await this.audit.write(tx, {
        action: "account.deletion_reapplied",
        entityType: "user",
        entityId: entry.user_id,
        after: { request_number: entry.request_number, status: "absent" },
      });
    });
    await this.recordFloor(entry);
  }

  /**
   * Menyimpan floor N entri ledger pada baris permintaannya (PRD 3.5, 6.4) bila lebih tinggi dari yang tersimpan;
   * MembershipKernel.allocateMemberNumber memperhitungkan floor tertinggi semua baris account_deletions.
   */
  private async recordFloor(entry: LedgerEntry): Promise<void> {
    if (entry.member_seq_floor === undefined) return;
    const floor = entry.member_seq_floor;
    await this.db
      .update(accountDeletions)
      .set({
        ledger: sql`${accountDeletions.ledger} || jsonb_build_object('member_seq_floor', ${floor}::bigint)`,
        updatedAt: this.clock.now(),
      })
      .where(
        and(
          or(
            eq(accountDeletions.id, entry.deletion_id),
            eq(accountDeletions.requestNumber, entry.request_number),
          ),
          sql`(coalesce((${accountDeletions.ledger}->>'member_seq_floor')::bigint, -1) < ${floor}::bigint)`,
        ),
      );
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
      const previous = row.ledger ?? {};
      const storedFloor =
        typeof previous.member_seq_floor === "number" ? previous.member_seq_floor : undefined;
      const floor =
        entry.member_seq_floor === undefined
          ? storedFloor
          : Math.max(storedFloor ?? 0, entry.member_seq_floor);
      await tx
        .update(accountDeletions)
        .set({
          status: "pending",
          completedAt: null,
          nextAttemptAt: null,
          lastError: null,
          stepsDone,
          // Floor N dari ledger eksternal ikut disimpan (PRD 3.5, 6.4; lihat MembershipKernel.allocateMemberNumber).
          ledger: {
            ...previous,
            v: 1,
            restored: true,
            ...(floor === undefined ? {} : { member_seq_floor: floor }),
          },
          updatedAt: now,
        })
        .where(eq(accountDeletions.id, row.id));
      if (user.status !== "deletion_pending")
        await tx
          .update(users)
          .set({
            status: "deletion_pending",
            sessionVersion: sql`${users.sessionVersion} + 1`,
            updatedAt: now,
          })
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
