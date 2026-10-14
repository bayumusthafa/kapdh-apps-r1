/**
 * Format tampilan situs publik (ARCHITECTURE §2 butir 5-6): waktu ditampilkan di Asia/Jakarta dengan label WIB
 * kecuali event memakai zona sendiri; uang adalah string desimal dan tidak pernah dihitung sebagai float.
 */

export const JAKARTA = "Asia/Jakarta";

const ZONE_LABELS: Record<string, string> = {
  "Asia/Jakarta": "WIB",
  "Asia/Pontianak": "WIB",
  "Asia/Makassar": "WITA",
  "Asia/Jayapura": "WIT",
};

export function zoneLabel(timeZone: string): string {
  return ZONE_LABELS[timeZone] ?? timeZone;
}

function toDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("id-ID", { timeZone });
    return timeZone;
  } catch {
    return JAKARTA;
  }
}

/** "12 Oktober 2026"; "-" bila tanggal tidak valid. */
export function formatDate(iso: string, timeZone: string = JAKARTA): string {
  const d = toDate(iso);
  if (!d) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: safeZone(timeZone),
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

/** "12 Okt 2026, 14.05 WIB"; "-" bila tanggal tidak valid. */
export function formatDateTime(iso: string, timeZone: string = JAKARTA): string {
  const d = toDate(iso);
  if (!d) return "-";
  const zone = safeZone(timeZone);
  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: zone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}.${get("minute")} ${zoneLabel(zone)}`;
}

const MONEY_RE = /^(\d+)\.(\d{2})$/;

/** Money "60000.00" -> "Rp60.000"; "1500.50" -> "Rp1.500,50" (PRD 6.1, tanpa aritmetika float). */
export function formatMoney(value: string): string {
  const m = MONEY_RE.exec(value);
  if (!m) return "-";
  const whole = m[1]!.replace(/^0+(?=\d)/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return m[2] === "00" ? `Rp${grouped}` : `Rp${grouped},${m[2]}`;
}

/** Hitung mundur "m:ss" untuk OTP, kirim ulang dan batas 429. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Lama jeda dalam kalimat untuk pesan yang diumumkan sekali (N-11): "45 detik", "2 menit", "1 jam"; dibulatkan ke
 * atas agar tidak menjanjikan waktu lebih cepat daripada jeda server.
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(1, Math.ceil(totalSeconds));
  if (s < 60) return `${s} detik`;
  if (s < 3600) return `${Math.ceil(s / 60)} menit`;
  return `${Math.ceil(s / 3600)} jam`;
}

/** Detik tersisa sampai `targetIso` menurut jam `nowMs`, dibatasi [0, maxSeconds] (jam perangkat bisa menyimpang). */
export function secondsUntil(targetIso: string, nowMs: number, maxSeconds: number): number {
  const at = Date.parse(targetIso);
  if (Number.isNaN(at)) return 0;
  return Math.min(Math.max(Math.ceil((at - nowMs) / 1000), 0), maxSeconds);
}
