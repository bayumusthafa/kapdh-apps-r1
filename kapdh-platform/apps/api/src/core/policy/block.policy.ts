import { Inject, Injectable } from "@nestjs/common";
import { blocks } from "@kapdh/database";
import { and, eq, or } from "drizzle-orm";
import { ADVISORY_LOCK_NAMESPACES, advisoryXactLockFor } from "../db/locks.js";
import type { Db, DbOrTx, Tx } from "../db/types.js";
import { DB } from "../tokens.js";

/**
 * Kebijakan blokir dua arah (PRD 3.12, ARCHITECTURE §3.5; AC F12-1): blokir dari salah satu pihak menolak kirim direct
 * dan undangan grup dari pihak mana pun, walau socket/room sudah ada.
 *
 * Race blokir vs kirim: modul chat/moderation memanggil {@link lockPair} di dalam transaksinya sebelum memeriksa
 * blokir (kirim direct/undang) dan sebelum membuat/menghapus blokir, sehingga keputusan diserialisasi per pasangan.
 */
@Injectable()
export class BlockPolicy {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** true bila `a` memblokir `b` ATAU `b` memblokir `a`. Di dalam transaksi, berikan `tx` agar membaca keadaan yang sama. */
  async isBlockedEitherWay(a: string, b: string, tx: DbOrTx = this.db): Promise<boolean> {
    if (a === b) return false;
    const [row] = await tx
      .select({ blockerId: blocks.blockerId })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
          and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Semua pengguna yang memblokir atau diblokir `userId` (filter undangan/daftar). */
  async blockedEitherWay(userId: string, tx: DbOrTx = this.db): Promise<Set<string>> {
    const found = await tx
      .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
      .from(blocks)
      .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
    return new Set(found.map((row) => (row.blockerId === userId ? row.blockedId : row.blockerId)));
  }

  /** Kunci advisory transaksi untuk pasangan (urutan argumen tidak berpengaruh). */
  async lockPair(tx: Tx, a: string, b: string): Promise<void> {
    const [low, high] = a < b ? [a, b] : [b, a];
    await advisoryXactLockFor(tx, ADVISORY_LOCK_NAMESPACES.blockPair, `${low}:${high}`);
  }
}
