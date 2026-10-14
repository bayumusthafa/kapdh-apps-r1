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
 */
export const LEDGER_PREFIX = "ledger/account-deletions";

export const ledgerEntrySchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("kapdh.account_deletion"),
    deletion_id: z.uuid(),
    request_number: z.string().regex(/^DEL-[0-9]{4}-[0-9A-Z]{4,}$/),
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
    written_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

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
  if (!stored || stored.deletion_id !== entry.deletion_id) return writeLedgerEntry(storage, entry);
  if (stored.state === "completed" && entry.state === "requested") return key;
  return writeLedgerEntry(storage, {
    ...entry,
    object_keys: [...new Set([...stored.object_keys, ...entry.object_keys])].sort(),
  });
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
 * Menggabungkan entri per deletion_id: entri `completed` mengalahkan `requested`, dan object key dari SEMUA entri
 * permintaan yang sama digabung (salinan ledger dari beberapa sumber, mis. store luar VPS yang append-only berisi
 * beberapa versi entri, ditambah salinan ledger di backup berkas). Entri dengan deletion_id sama tetapi akun/nomor
 * permintaan berbeda berarti ledger rusak: dilempar, tidak pernah dipilih diam-diam (AC F14-6).
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
    byId.set(entry.deletion_id, {
      ...base,
      object_keys: [...new Set([...current.object_keys, ...entry.object_keys])].sort(),
    });
  }
  return [...byId.values()].sort(
    (a, b) => a.requested_at.localeCompare(b.requested_at) || a.deletion_id.localeCompare(b.deletion_id),
  );
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
