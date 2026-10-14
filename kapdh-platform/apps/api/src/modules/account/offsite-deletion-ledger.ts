import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { type BaseEnv, deletionLedgerConfigured } from "@kapdh/config";
import { S3Driver, type StorageDriver } from "@kapdh/storage";
import { v7 as uuidv7 } from "uuid";
import { ENV } from "../../core/tokens.js";
import { appendLedgerEntry, type LedgerEntry } from "./deletion-ledger.js";

/**
 * Galat menulis entri ke deletion ledger luar VPS. `code` hanya nama galat penyedia yang aman (mis. AccessDenied),
 * sehingga `account_deletions.last_error` menjadi `ledger_open:OffsiteLedgerWriteError:AccessDenied` tanpa pesan
 * mentah (N-14) dan dapat dipakai sebagai sinyal alert (docs/runbooks/monitoring.md).
 */
export class OffsiteLedgerWriteError extends Error {
  override name = "OffsiteLedgerWriteError";
  readonly code: string | undefined;

  constructor(message: string, cause?: unknown) {
    super(message);
    // Nama galat penyedia S3 (AccessDenied, NoSuchBucket, InvalidRequest, ...); nama umum "Error" tidak informatif.
    const name = (cause as { name?: unknown } | null)?.name;
    this.code =
      typeof name === "string" && name !== "Error" && /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : undefined;
  }
}

/** Driver S3 bucket deletion ledger luar VPS dari env, atau null bila tidak dikonfigurasi. */
export function createOffsiteLedgerDriver(env: BaseEnv): S3Driver | null {
  if (!deletionLedgerConfigured(env)) return null;
  return new S3Driver({
    bucket: env.DELETION_LEDGER_S3_BUCKET!,
    region: env.DELETION_LEDGER_S3_REGION!,
    endpoint: env.DELETION_LEDGER_S3_ENDPOINT,
    forcePathStyle: env.DELETION_LEDGER_S3_FORCE_PATH_STYLE ?? false,
    accessKeyId: env.DELETION_LEDGER_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.DELETION_LEDGER_S3_SECRET_ACCESS_KEY!,
    // Bucket ledger memakai object lock/retensi; AWS mewajibkan Content-MD5 pada PutObject ke bucket seperti itu.
    contentMd5: true,
  });
}

/**
 * Deletion ledger DI LUAR VPS (AC F14-6, D2, D9, PRD 5.5; audit D5-07). Salinan ledger di StorageDriver
 * (`ledger/account-deletions/**`) berada di volume /data/files yang sama dengan unggahan dan hanya disalin keluar VPS
 * sekali sehari, sehingga hilangnya VPS menghilangkan entri penghapusan sesudah backup terakhir dan akun yang sudah
 * dihapus aktif kembali setelah restore. Karena itu langkah `ledger_open` dan `ledger_final` job penghapusan menulis
 * setiap entri ke bucket S3-compatible khusus ini SECARA SINKRON sebelum langkah dicatat selesai; galat penulisan
 * menggagalkan langkah (dicoba ulang dengan backoff) sehingga data pribadi tidak pernah dihapus tanpa jejak ledger di
 * luar VPS.
 *
 * Penulisan append-only: key baru per penulisan ({@link appendLedgerEntry}), tidak pernah menimpa, membaca atau
 * menghapus, sehingga kredensial worker cukup hak tulis objek dan bucket dapat memakai versioning + object lock.
 *
 * Tanpa konfigurasi (development/test) ledger hanya ditulis ke StorageDriver; di production tanpa konfigurasi langkah
 * ditolak (pertahanan berlapis selain validasi env worker di packages/config).
 */
@Injectable()
export class OffsiteDeletionLedger implements OnModuleDestroy {
  private readonly owned: S3Driver | null;
  private driver: StorageDriver | null;
  private readonly required: boolean;

  constructor(@Inject(ENV) env: BaseEnv) {
    this.owned = createOffsiteLedgerDriver(env);
    this.driver = this.owned;
    this.required = env.NODE_ENV === "production";
  }

  /** true bila store luar VPS terpasang. */
  get configured(): boolean {
    return this.driver !== null;
  }

  /** Uji: memasang store pengganti (MemoryDriver) atau melepasnya (null). */
  useDriver(driver: StorageDriver | null): void {
    this.driver = driver;
  }

  /**
   * Menambahkan entri. Mengembalikan object key, atau null bila store tidak dikonfigurasi di luar production.
   * Melempar {@link OffsiteLedgerWriteError} bila penulisan gagal atau store wajib tetapi tidak dikonfigurasi.
   */
  async append(entry: LedgerEntry): Promise<string | null> {
    const driver = this.driver;
    if (!driver) {
      if (this.required)
        throw new OffsiteLedgerWriteError(
          "Deletion ledger luar VPS wajib di production (DELETION_LEDGER_S3_*); langkah ditunda",
        );
      return null;
    }
    try {
      return await appendLedgerEntry(driver, entry, uuidv7());
    } catch (error) {
      throw new OffsiteLedgerWriteError("Entri deletion ledger gagal ditulis ke store luar VPS", error);
    }
  }

  onModuleDestroy(): void {
    this.owned?.destroy();
  }
}
