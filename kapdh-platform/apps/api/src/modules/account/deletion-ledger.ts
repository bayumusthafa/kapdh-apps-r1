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
    object_keys: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/).max(512)),
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

export function mergeLedgerEntries(entries: LedgerEntry[]): LedgerEntry[] {
  const byId = new Map<string, LedgerEntry>();
  for (const entry of entries) {
    const current = byId.get(entry.deletion_id);
    if (!current || (current.state === "requested" && entry.state === "completed")) byId.set(entry.deletion_id, entry);
  }
  return [...byId.values()].sort(
    (a, b) => a.requested_at.localeCompare(b.requested_at) || a.deletion_id.localeCompare(b.deletion_id),
  );
}
