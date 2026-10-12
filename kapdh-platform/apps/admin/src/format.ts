const rupiah = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});
const dateTime = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Nominal dari API berupa string desimal; jangan dihitung sebagai float di klien. Hanya untuk tampilan. */
export function formatRupiah(amount: string): string {
  return rupiah.format(Number(amount)).replace(/\s/g, "");
}

export function formatJakarta(iso: string | null | undefined): string {
  return iso ? `${dateTime.format(new Date(iso))} WIB` : "-";
}

export const PAYMENT_TYPE_LABEL = {
  registration: "Pendaftaran",
  renewal: "Perpanjangan",
  ticket: "Tiket event",
} as const;
