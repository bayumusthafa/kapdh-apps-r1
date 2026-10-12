import { id as localeId } from "date-fns/locale";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/**
 * Format tampilan web admin (ARCHITECTURE §2 aturan 5 dan 6).
 * - Uang dari API berupa string desimal `Money` ("60000.00"). Semua fungsi di sini bekerja pada string; tidak ada
 *   aritmetika floating point atas uang di klien.
 * - Waktu disimpan UTC dan ditampilkan dalam Asia/Jakarta (`… WIB`) kecuali event menetapkan zona sendiri (PRD 2.1).
 */

export const DEFAULT_TIME_ZONE = "Asia/Jakarta";

/** Batas numeric(14,2): maksimal 12 digit bilangan bulat. */
export const MONEY_MAX_INTEGER_DIGITS = 12;

const MONEY_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** "60000.00" → "Rp60.000"; "60000.50" → "Rp60.000,50". Nilai tidak valid → "-". */
export function formatRupiah(amount: string | null | undefined): string {
  if (amount == null) return "-";
  const m = MONEY_RE.exec(amount.trim());
  if (!m) return "-";
  const [, sign, rawInt = "0", rawFrac = ""] = m;
  const int = groupThousands(rawInt.replace(/^0+(?=\d)/, ""));
  const frac = rawFrac.padEnd(2, "0");
  return `${sign ? "-" : ""}Rp${int}${frac === "00" ? "" : `,${frac}`}`;
}

/**
 * Teks isian pengguna → `Money`. Menerima "60000", "60.000", "60.000,5", "Rp 60.000". Mengembalikan null bila
 * kosong atau tidak valid (termasuk lebih dari 12 digit bilangan bulat).
 */
export function parseRupiahInput(text: string): string | null {
  const cleaned = text.replace(/^\s*rp\.?/i, "").replace(/\s/g, "");
  if (cleaned === "") return null;
  const m = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const int = (m[1] ?? "").replace(/\./g, "").replace(/^0+(?=\d)/, "");
  if (int.length > MONEY_MAX_INTEGER_DIGITS) return null;
  return `${int}.${(m[2] ?? "").padEnd(2, "0")}`;
}

/** `Money` → teks isian tanpa awalan "Rp": "60000.00" → "60.000"; "60000.50" → "60.000,50". */
export function formatRupiahInput(amount: string | null | undefined): string {
  const formatted = formatRupiah(amount);
  return formatted === "-" ? "" : formatted.replace("Rp", "");
}

const ZONE_ABBREVIATION: Record<string, string> = {
  "Asia/Jakarta": "WIB",
  "Asia/Pontianak": "WIB",
  "Asia/Makassar": "WITA",
  "Asia/Jayapura": "WIT",
};

/** Singkatan zona Indonesia (WIB/WITA/WIT); zona lain ditampilkan dengan nama IANA. */
export function zoneLabel(timeZone: string = DEFAULT_TIME_ZONE): string {
  return ZONE_ABBREVIATION[timeZone] ?? timeZone;
}

function toDate(iso: string | Date): Date | null {
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatIn(iso: string | Date | null | undefined, pattern: string, timeZone: string): string | null {
  if (iso == null || iso === "") return null;
  const d = toDate(iso);
  return d ? formatInTimeZone(d, timeZone, pattern, { locale: localeId }) : null;
}

/** "12 Okt 2026, 14.20 WIB" */
export function formatDateTime(
  iso: string | Date | null | undefined,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  const text = formatIn(iso, "d MMM yyyy, HH.mm", timeZone);
  return text ? `${text} ${zoneLabel(timeZone)}` : "-";
}

/** "12 Okt 2026" */
export function formatDate(
  iso: string | Date | null | undefined,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  return formatIn(iso, "d MMM yyyy", timeZone) ?? "-";
}

/** Bentuk ringkas untuk sel tabel: "12 Okt, 14.20" (zona bawaan WIB disebut di judul kolom). */
export function formatShortDateTime(
  iso: string | Date | null | undefined,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  return formatIn(iso, "d MMM, HH.mm", timeZone) ?? "-";
}

/**
 * Usia antrean ringkas sesuai prototipe screen_8: "baru saja", "14 menit", "2 jam", "3 hari".
 * `now` berasal dari pemanggil (hook useNow) agar mudah diuji dan diperbarui berkala.
 */
export function formatRelativeAge(iso: string | Date | null | undefined, now: Date): string {
  if (iso == null || iso === "") return "-";
  const d = toDate(iso);
  if (!d) return "-";
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} menit`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam`;
  return `${Math.floor(hours / 24)} hari`;
}

/** ISO UTC → nilai `<input type="datetime-local">` pada zona tertentu ("2026-10-12T14:20"). */
export function toZonedInputValue(
  iso: string | null | undefined,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  return formatIn(iso, "yyyy-MM-dd'T'HH:mm", timeZone) ?? "";
}

/** Nilai `datetime-local` yang dibaca sebagai jam dinding zona tertentu → ISO UTC. Kosong/tidak valid → null. */
export function fromZonedInputValue(local: string, timeZone: string = DEFAULT_TIME_ZONE): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(local)) return null;
  const d = fromZonedTime(local, timeZone);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
