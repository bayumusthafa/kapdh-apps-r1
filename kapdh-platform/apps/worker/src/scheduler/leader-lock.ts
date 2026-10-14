import { ADVISORY_LOCK_KEYS } from "@kapdh/api/worker";
import postgres from "postgres";

type Sql = postgres.Sql;

/** Pemilihan leader penjadwal: hanya pemegang kunci yang menjadwalkan job (ARCHITECTURE §4.8, PRD 5.1). */
export interface LeaderLock {
  /**
   * True bila proses ini memegang kunci (mengambilnya bila bebas). Dipanggil setiap tick, sehingga kunci yang hilang
   * (koneksi putus → PostgreSQL melepas kunci sesi) terdeteksi sebelum tick berikutnya dijadwalkan.
   */
  tryAcquire(): Promise<boolean>;
  /** Melepas kunci bila dipegang (shutdown, setelah job terjadwal yang berjalan selesai). */
  release(): Promise<void>;
  /** Menutup koneksi khusus kunci. */
  close(): Promise<void>;
}

const LOW_32 = 0xffffffffn;

/**
 * Kunci advisory SESI PostgreSQL pada koneksi khusus (pool 1 koneksi, terpisah dari pool kerja): kunci melekat pada
 * backend; bila proses worker mati atau koneksinya putus, PostgreSQL melepasnya dan instance lain mengambil alih.
 * Kepemilikan diperiksa lewat `pg_locks` untuk backend saat ini, sehingga koneksi yang tersambung ulang (backend baru,
 * kunci lama sudah lepas) tidak dianggap leader, dan `pg_try_advisory_lock` tidak pernah dipanggil berulang pada kunci
 * yang sudah dipegang (kunci sesi bersifat re-entrant dan bertumpuk).
 */
export class PgAdvisoryLeaderLock implements LeaderLock {
  private readonly key: bigint;

  constructor(
    private readonly sql: Sql,
    key: number | bigint = ADVISORY_LOCK_KEYS.workerSchedulerLeader,
  ) {
    this.key = BigInt(key);
  }

  async tryAcquire(): Promise<boolean> {
    // Kunci bigint tampil di pg_locks sebagai classid = 32 bit atas, objid = 32 bit bawah, objsubid = 1.
    const high = (this.key >> 32n).toString();
    const low = (this.key & LOW_32).toString();
    const rows = await this.sql<{ leader: boolean }[]>`
      select case
        when exists (
          select 1 from pg_locks
          where locktype = 'advisory' and pid = pg_backend_pid() and granted
            and classid = ${high}::oid and objid = ${low}::oid and objsubid = 1
        ) then true
        else pg_try_advisory_lock(${this.key.toString()}::bigint)
      end as leader`;
    return rows[0]?.leader === true;
  }

  async release(): Promise<void> {
    // Satu koneksi khusus hanya memegang kunci ini; unlock_all juga membersihkan tumpukan bila ada.
    await this.sql`select pg_advisory_unlock_all()`;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

export interface LeaderConnectionOptions {
  key?: number | bigint;
  applicationName?: string;
}

/**
 * Koneksi khusus kunci leader dari DATABASE_URL (role kapdh_worker; advisory lock tidak membutuhkan grant tambahan):
 *   - satu koneksi tanpa batas umur (`max_lifetime: 0`) dan tanpa idle timeout, karena rotasi koneksi pool akan
 *     melepas kunci sesi dan memicu pergantian leader yang tidak perlu;
 *   - keepalive TCP sisi server diperpendek agar PostgreSQL cepat melepas kunci milik worker yang hilang dari
 *     jaringan (instance lain dapat mengambil alih), dan statement_timeout menjaga tick tidak menggantung.
 * URL koneksi (berisi sandi) tidak pernah dicatat.
 */
export function connectLeaderLock(url: string, options: LeaderConnectionOptions = {}): PgAdvisoryLeaderLock {
  const sql = postgres(url, {
    max: 1,
    max_lifetime: 0,
    idle_timeout: 0,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
    connection: {
      application_name: options.applicationName ?? "kapdh-worker-leader",
      statement_timeout: 5_000,
      tcp_keepalives_idle: 30,
      tcp_keepalives_interval: 10,
    },
  });
  return new PgAdvisoryLeaderLock(sql, options.key);
}
