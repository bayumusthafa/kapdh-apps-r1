import { Inject, Injectable } from "@nestjs/common";
import { accountDeletions, users } from "@kapdh/database";
import type { StorageDriver } from "@kapdh/storage";
import { eq } from "drizzle-orm";
import type { Db } from "../../core/db/types.js";
import { DB, STORAGE } from "../../core/tokens.js";
import { readLedgerHead } from "./deletion-ledger.js";

export type LedgerGateState = "ok" | "fail" | "skipped";

/** Hasil `ok` dipercaya selama ini tanpa membaca ulang storage/database (probe readiness berjalan tiap beberapa detik). */
const OK_CACHE_MS = 30_000;

/**
 * Gerbang readiness deletion ledger (AC F14-6, PRD 9.2 skenario 8): API tidak siap melayani selama database belum
 * mengenal permintaan penghapusan TERBARU di kepala ledger storage. Setelah database dipulihkan dari backup yang lebih
 * tua dari penghapusan terakhir, baris account_deletions permintaan itu tidak ada (atau akunnya muncul kembali), jadi
 * GET /health/ready menjawab 503 sampai `account:ledger-reapply` dijalankan (penerapan ulang mencatat setiap permintaan,
 * termasuk akun yang tidak ada di backup). Kepala yang rusak juga `fail` (diperbaiki dengan menjalankan penerapan
 * ulang). Tanpa storage → `skipped`.
 *
 * Batas: bila database DAN storage dipulihkan dari backup yang sama, kepala ledger ikut tua sehingga gerbang ini tidak
 * dapat mendeteksinya; runbook restore (docs/runbooks/restore-backup.md) tetap mewajibkan penerapan ulang dari salinan
 * ledger terbaru sebelum layanan dibuka.
 */
@Injectable()
export class DeletionLedgerGate {
  private verifiedAt: number | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: StorageDriver | null,
  ) {}

  async check(): Promise<LedgerGateState> {
    if (!this.storage) return "skipped";
    if (this.verifiedAt !== null && performance.now() - this.verifiedAt < OK_CACHE_MS) return "ok";
    const state = await this.evaluate(this.storage);
    this.verifiedAt = state === "ok" ? performance.now() : null;
    return state;
  }

  private async evaluate(storage: StorageDriver): Promise<LedgerGateState> {
    const head = await readLedgerHead(storage).catch(() => "corrupt" as const);
    if (head === "corrupt") return "fail";
    if (!head) return "ok";
    const [known] = await this.db
      .select({ id: accountDeletions.id })
      .from(accountDeletions)
      .where(eq(accountDeletions.id, head.deletion_id))
      .limit(1);
    if (known) return "ok";
    // Baris permintaan tidak ada tetapi akun sudah terhapus (mis. data lama dibersihkan): tetap konsisten.
    const [user] = await this.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, head.user_id))
      .limit(1);
    return user?.status === "deleted" ? "ok" : "fail";
  }
}
