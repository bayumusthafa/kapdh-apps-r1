/** Format tanggal tampilan Asia/Jakarta untuk teks notifikasi (PRD 2.1: pengguna melihat tanggal WIB). */
const DATE_WIB = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** Contoh: `13 Oktober 2027`. */
export function formatDateWib(instant: Date): string {
  return DATE_WIB.format(instant);
}
