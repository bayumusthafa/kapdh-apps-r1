import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import type { Db } from "../../core/db/types.js";
import { unauthenticated, versionConflict } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import type { AccountStatus } from "../../core/membership/effective-status.js";
import { DB } from "../../core/tokens.js";
import { DeletionDisclosureService } from "./deletion-disclosure.service.js";
import { toAccountDeletion } from "./deletion-policy.js";
import { DeletionRequestService } from "./deletion-request.service.js";

type Disclosure = components["schemas"]["AccountDeletionDisclosure"];
type AccountDeletion = components["schemas"]["AccountDeletion"];

/** Pesan 409 bila pengungkapan berubah sejak ditampilkan (kontrak requestAccountDeletion/confirmWebDeletion). */
export const DISCLOSURE_CHANGED =
  "Informasi penghapusan akun berubah (mis. tiket, refund atau pembayaran baru). Baca ulang lalu konfirmasi kembali.";

/**
 * Penghapusan akun dari aplikasi (F-14, AC F14-1; kontrak getAccountDeletionDisclosure dan requestAccountDeletion).
 * Reautentikasi maksimal 10 menit (X-Reauth-Token) diperiksa AuthGuard; konfirmasi eksplisit dan versi pengungkapan
 * diperiksa di sini. Anggota suspended memakai jalur yang sama tanpa akses komunitas (deletion-only, F-14).
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly disclosure: DeletionDisclosureService,
    private readonly requests: DeletionRequestService,
  ) {}

  async disclosureFor(auth: AuthContext): Promise<Disclosure> {
    const [user] = await this.db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, auth.userId));
    if (!user || user.status !== "active") throw unauthenticated();
    return this.disclosure.compute(this.db, { id: user.id, status: user.status as AccountStatus });
  }

  /**
   * Satu transaksi dengan baris users terkunci (AC F14-1). Permintaan bersamaan dari sesi mana pun milik akun ini (dua
   * perangkat, atau ulangan dari sesi yang sama) yang sudah lolos AuthGuard: transaksi kedua menunggu kunci lalu
   * melihat akun sudah deletion_pending dan mengembalikan permintaan terbuka yang sama. AuthGuard menilai
   * @MemberAccess dari snapshot pemeriksaan sesi, sehingga commit pertama tidak membuat yang kedua ditolak 403.
   */
  async request(auth: AuthContext, acknowledgedVersion: string): Promise<AccountDeletion> {
    return this.db.transaction(async (tx) => {
      const user = await this.requests.lockUser(tx, auth.userId);
      if (user?.status === "deletion_pending") {
        const open = await this.requests.openRequest(tx, user.id);
        if (open) return toAccountDeletion(open);
      }
      if (!user || user.status !== "active" || user.sessionVersion !== auth.sessionVersion)
        throw unauthenticated();
      const current = await this.disclosure.compute(tx, { id: user.id, status: "active" });
      if (current.version !== acknowledgedVersion) throw versionConflict(current, DISCLOSURE_CHANGED);
      const deletion = await this.requests.create(tx, user, {
        source: "app",
        expectedStatus: "active",
        actor: { kind: "alumni", userId: user.id, adminId: null, adminRole: null },
      });
      return toAccountDeletion(deletion);
    });
  }
}
