import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readAll, type StorageDriver } from "@kapdh/storage";
import { z } from "zod";

/**
 * Deletion ledger EKSTERNAL (AC F14-6, D2, PRD 5.5): satu objek JSON per permintaan penghapusan di StorageDriver,
 * `ledger/account-deletions/<yyyy>/<mm>/<nomor-permintaan>.json` (tahun/bulan UTC permintaan; nomor huruf kecil agar
 * aman sebagai object key). Objek ditulis job saat permintaan mulai diproses (`state: requested`) dan ditimpa dengan
 * versi lengkap saat selesai (`state: completed`, berisi object key berkas yang dihapus). Isinya HANYA id dan object
 * key (bentuk `<purpose>/<yyyy>/<mm>/<uuidv7>`), tanpa nama, email, telepon atau isi apa pun, sehingga ledger dapat
 * disimpan bersama manifest backup. Setelah restore backup yang dibuat sebelum penghapusan, runbook menjalankan
 * `node dist/modules/account/ledger-reapply.cli.js --dir <salinan ledger terbaru>` SEBELUM layanan dibuka; setiap
 * entri diterapkan ulang oleh {@link DeletionLedgerService.reapply}.
 *
 * Karena salinan di StorageDriver ikut hilang bersama VPS (volume /data/files), setiap entri JUGA ditambahkan secara
 * sinkron ke bucket deletion ledger luar VPS yang append-only ({@link appendLedgerEntry}, `OffsiteDeletionLedger`;
 * audit D5-07). Runbook restore menyalin bucket itu (rclone) lalu memberikannya ke CLI sebagai `--dir` tambahan.
 *
 * `account_deletions.ledger` hanyalah salinan kerja job (inventaris id untuk melanjutkan langkah), bukan sumber
 * pemulihan, karena backup yang lebih tua dari permintaan tidak memuat baris itu.
 *
 * Setiap entri juga membawa `member_seq_floor`: N tertinggi (alumni.member_seq) yang sudah dialokasikan saat entri
 * ditulis, sehingga N anggota yang dihapus SETELAH titik backup tidak dialokasikan ulang sesudah restore (PRD 3.5, 6.4).
 * Kepala ledger ({@link LEDGER_HEAD_KEY}, di luar folder entri) menunjuk permintaan terbaru dan floor tertinggi; readiness
 * API gagal selama database belum mengenal permintaan itu (restore database tanpa penerapan ulang ledger, AC F14-6).
 */
export const LEDGER_PREFIX = "ledger/account-deletions";

/**
 * Kepala deletion ledger: permintaan terbaru (requested_at, lalu deletion_id) yang pernah ditulis ke ledger dan floor
 * N tertinggi. Disimpan DI LUAR folder entri sehingga salinan folder untuk CLI tetap satu berkas per permintaan.
 */
export const LEDGER_HEAD_KEY = "ledger/account-deletions-head.json";

const requestNumberSchema = z.string().regex(/^DEL-[0-9]{4}-[0-9A-Z]{4,}$/);

export const ledgerEntrySchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("kapdh.account_deletion"),
    deletion_id: z.uuid(),
    request_number: requestNumberSchema,
    user_id: z.uuid(),
    source: z.enum(["app", "web"]),
    requested_at: z.iso.datetime({ offset: true }),
    state: z.enum(["requested", "completed"]),
    completed_at: z.union([z.iso.datetime({ offset: true }), z.null()]),
    object_keys: z.array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/)
        .max(512),
    ),
    /**
     * N tertinggi yang sudah dialokasikan saat entri ditulis (bukan N milik akun ini secara khusus; termasuk N akun ini
     * bila ada). Opsional agar entri lama tetap terbaca.
     */
    member_seq_floor: z.number().int().nonnegative().optional(),
    written_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const ledgerHeadSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("kapdh.account_deletion_ledger_head"),
    deletion_id: z.uuid(),
    request_number: requestNumberSchema,
    user_id: z.uuid(),
    requested_at: z.iso.datetime({ offset: true }),
    member_seq_floor: z.number().int().nonnegative(),
    written_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type LedgerHead = z.infer<typeof ledgerHeadSchema>;

/** Urutan permintaan di ledger: waktu permintaan, lalu deletion_id (uuidv7). */
function compareRequests(
  a: Pick<LedgerEntry, "requested_at" | "deletion_id">,
  b: Pick<LedgerEntry, "requested_at" | "deletion_id">,
): number {
  return (
    Date.parse(a.requested_at) - Date.parse(b.requested_at) || a.deletion_id.localeCompare(b.deletion_id)
  );
}

const maxFloor = (...values: (number | undefined)[]) =>
  values.reduce<number | undefined>(
    (acc, value) => (value === undefined ? acc : Math.max(acc ?? 0, value)),
    undefined,
  );

/** Kepala ledger di storage, atau null bila belum pernah ada penghapusan. Kepala rusak melempar. */
export async function readLedgerHead(storage: StorageDriver): Promise<LedgerHead | null> {
  if (!(await storage.exists(LEDGER_HEAD_KEY))) return null;
  const text = (await readAll(await storage.get(LEDGER_HEAD_KEY))).toString("utf8");
  return ledgerHeadSchema.parse(JSON.parse(text));
}

/**
 * Memajukan kepala ledger secara monoton dengan satu entri: permintaan terbaru dan floor N tertinggi. Kepala yang rusak
 * ditimpa. Tulisan bersamaan dua job dapat membuat kepala tertinggal satu permintaan (tanpa compare-and-swap di
 * StorageDriver); kepala yang tertinggal hanya melonggarkan pemeriksaan readiness, tidak pernah menahannya secara keliru,
 * dan tulisan ledger berikutnya memajukannya lagi.
 */
export async function advanceLedgerHead(
  storage: StorageDriver,
  entry: LedgerEntry,
  writtenAt: Date,
): Promise<void> {
  const current = await readLedgerHead(storage).catch(() => null);
  const latest = !current || compareRequests(entry, current) > 0 ? entry : current;
  const floor = maxFloor(current?.member_seq_floor, entry.member_seq_floor) ?? 0;
  if (current && latest === current && floor === current.member_seq_floor) return;
  const head: LedgerHead = ledgerHeadSchema.parse({
    v: 1,
    kind: "kapdh.account_deletion_ledger_head",
    deletion_id: latest.deletion_id,
    request_number: latest.request_number,
    user_id: latest.user_id,
    requested_at: latest.requested_at,
    member_seq_floor: floor,
    written_at: writtenAt.toISOString(),
  });
  await storage.put(LEDGER_HEAD_KEY, Buffer.from(`${JSON.stringify(head, null, 2)}\n`, "utf8"), {
    contentType: "application/json",
  });
}

/** Object key ledger untuk satu permintaan. */
export function ledgerObjectKey(requestNumber: string, requestedAt: Date): string {
  const year = requestedAt.getUTCFullYear().toString().padStart(4, "0");
  const month = String(requestedAt.getUTCMonth() + 1).padStart(2, "0");
  return `${LEDGER_PREFIX}/${year}/${month}/${requestNumber.toLowerCase()}.json`;
}

export async function writeLedgerEntry(storage: StorageDriver, entry: LedgerEntry): Promise<string> {
  const parsed = ledgerEntrySchema.parse(entry);
  const key = ledgerObjectKey(parsed.request_number, new Date(parsed.requested_at));
  await storage.put(key, Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8"), {
    contentType: "application/json",
  });
  return key;
}

/**
 * Menulis entri secara monoton terhadap entri yang sudah tersimpan untuk permintaan yang sama: entri `completed` tidak
 * pernah ditimpa `requested`, dan object key yang sudah tercatat tidak pernah hilang (gabungan). Melindungi pemulihan
 * (AC F14-6) dari penulisan oleh eksekusi job yang tertinggal. Objek yang rusak ditimpa entri sah.
 */
export async function writeLedgerEntryMonotonic(storage: StorageDriver, entry: LedgerEntry): Promise<string> {
  const key = ledgerObjectKey(entry.request_number, new Date(entry.requested_at));
  const stored = (await storage.exists(key)) ? await readLedgerObject(storage, key).catch(() => null) : null;
  let written: LedgerEntry;
  if (!stored || stored.deletion_id !== entry.deletion_id) written = entry;
  else if (stored.state === "completed" && entry.state === "requested") written = stored;
  else {
    const floor = maxFloor(stored.member_seq_floor, entry.member_seq_floor);
    written = {
      ...entry,
      object_keys: [...new Set([...stored.object_keys, ...entry.object_keys])].sort(),
      ...(floor === undefined ? {} : { member_seq_floor: floor }),
    };
  }
  if (written !== stored) await writeLedgerEntry(storage, written);
  // Kepala ledger dimajukan SETELAH entri tersimpan (readiness API, AC F14-6).
  await advanceLedgerHead(storage, written, new Date(entry.written_at));
  return key;
}

export async function readLedgerObject(storage: StorageDriver, key: string): Promise<LedgerEntry> {
  return parseLedgerEntry((await readAll(await storage.get(key))).toString("utf8"));
}

/** Mengurai satu entri; melempar bila bukan entri ledger sah (berkas rusak tidak boleh diabaikan diam-diam). */
export function parseLedgerEntry(json: string): LedgerEntry {
  return ledgerEntrySchema.parse(JSON.parse(json));
}

/**
 * Membaca semua entri `*.json` di bawah direktori salinan ledger (mis. folder STORAGE_LOCAL_ROOT/ledger/account-deletions
 * atau hasil sinkron bucket S3 dari manifest backup terbaru), rekursif. Entri dengan deletion_id sama digabung ke versi
 * paling lengkap (completed mengalahkan requested). Urut menurut waktu permintaan.
 */
export function readLedgerDirectory(dir: string): LedgerEntry[] {
  const files: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".json")) files.push(full);
    }
  };
  walk(dir);
  return mergeLedgerEntries(files.map((file) => parseLedgerEntry(readFileSync(file, "utf8"))));
}

/**
 * Menggabungkan entri per deletion_id: entri `completed` mengalahkan `requested`, object key dari SEMUA entri
 * permintaan yang sama digabung, dan floor N tertinggi dipertahankan (salinan ledger dari beberapa sumber, mis. store
 * luar VPS yang append-only berisi beberapa versi entri, ditambah salinan ledger di backup berkas). Entri dengan
 * deletion_id sama tetapi akun/nomor permintaan berbeda berarti ledger rusak: dilempar, tidak pernah dipilih diam-diam
 * (AC F14-6).
 */
export function mergeLedgerEntries(entries: LedgerEntry[]): LedgerEntry[] {
  const byId = new Map<string, LedgerEntry>();
  for (const entry of entries) {
    const current = byId.get(entry.deletion_id);
    if (!current) {
      byId.set(entry.deletion_id, entry);
      continue;
    }
    if (current.user_id !== entry.user_id || current.request_number !== entry.request_number)
      throw new Error("Entri deletion ledger bertentangan untuk deletion_id yang sama");
    const base = current.state === "requested" && entry.state === "completed" ? entry : current;
    // Floor N tidak pernah turun saat versi entri digabung.
    const floor = maxFloor(current.member_seq_floor, entry.member_seq_floor);
    byId.set(entry.deletion_id, {
      ...base,
      object_keys: [...new Set([...current.object_keys, ...entry.object_keys])].sort(),
      ...(floor === undefined ? {} : { member_seq_floor: floor }),
    });
  }
  return [...byId.values()].sort(compareRequests);
}

/** Floor N tertinggi dari kumpulan entri ledger (0 bila tidak ada entri yang membawanya). */
export function ledgerMemberSeqFloor(entries: readonly LedgerEntry[]): number {
  return maxFloor(...entries.map((entry) => entry.member_seq_floor)) ?? 0;
}

// ------------------------------------------------------------------------------------ store luar VPS (D5-07)

/**
 * Prefix entri pada bucket deletion ledger LUAR VPS (DELETION_LEDGER_S3_*, AC F14-6, PRD 5.5, D9). Bucket khusus ini
 * terpisah dari STORAGE_DRIVER (volume /data/files di VPS) sehingga kehilangan VPS tidak ikut menghilangkan ledger.
 */
export const OFFSITE_LEDGER_PREFIX = "account-deletions";

/**
 * Object key APPEND-ONLY di store luar VPS: setiap penulisan memakai key baru
 * `account-deletions/<yyyy>/<mm>/<nomor-permintaan>/<state>-<uuidv7>.json`, tidak pernah menimpa atau menghapus objek
 * lain (cocok dengan bucket versioning + object lock). Pembaca menggabungkan semua versi lewat
 * {@link mergeLedgerEntries}.
 */
export function offsiteLedgerObjectKey(entry: LedgerEntry, writeId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(writeId)) throw new Error("writeId ledger harus UUID huruf kecil");
  const requestedAt = new Date(entry.requested_at);
  const year = requestedAt.getUTCFullYear().toString().padStart(4, "0");
  const month = String(requestedAt.getUTCMonth() + 1).padStart(2, "0");
  return `${OFFSITE_LEDGER_PREFIX}/${year}/${month}/${entry.request_number.toLowerCase()}/${entry.state}-${writeId}.json`;
}

/** Menambahkan satu entri tervalidasi ke store luar VPS dengan key baru; mengembalikan key. */
export async function appendLedgerEntry(
  storage: StorageDriver,
  entry: LedgerEntry,
  writeId: string,
): Promise<string> {
  const parsed = ledgerEntrySchema.parse(entry);
  const key = offsiteLedgerObjectKey(parsed, writeId);
  await storage.put(key, Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8"), {
    contentType: "application/json",
  });
  return key;
}
