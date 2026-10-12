import { type ComponentProps, useEffect, useState } from "react";
import {
  DEFAULT_TIME_ZONE,
  formatRupiahInput,
  fromZonedInputValue,
  parseRupiahInput,
  toZonedInputValue,
  zoneLabel,
} from "../../lib/format";
import { Input } from "./Input";

/**
 * Isian tanggal-waktu. Admin mengetik jam dinding zona event (bawaan WIB, Asia/Jakarta); nilai yang disimpan dan
 * dikirim ke API selalu ISO 8601 UTC (ARCHITECTURE §2.6). Zona ditampilkan di dalam kotak agar tidak ambigu.
 */
export interface DateTimeFieldProps extends Omit<
  ComponentProps<"input">,
  "value" | "onChange" | "type" | "min" | "max" | "size"
> {
  value: string | null;
  onValueChange: (iso: string | null) => void;
  timeZone?: string;
  /** Batas bawah/atas dalam ISO UTC. */
  min?: string | null;
  max?: string | null;
}

export function DateTimeField({
  value,
  onValueChange,
  timeZone = DEFAULT_TIME_ZONE,
  min,
  max,
  ...props
}: DateTimeFieldProps) {
  const [text, setText] = useState(() => toZonedInputValue(value, timeZone));
  useEffect(() => {
    // Sinkronkan bila nilai berubah dari luar (reset formulir, muat ulang versi terbaru).
    const external = toZonedInputValue(value, timeZone);
    setText((current) => (fromZonedInputValue(current, timeZone) === value ? current : external));
  }, [value, timeZone]);
  return (
    <Input
      type="datetime-local"
      value={text}
      min={min ? toZonedInputValue(min, timeZone) : undefined}
      max={max ? toZonedInputValue(max, timeZone) : undefined}
      trailing={
        <span aria-hidden="true" className="pr-3 text-xs font-semibold text-text-muted">
          {zoneLabel(timeZone)}
        </span>
      }
      onChange={(e) => {
        setText(e.target.value);
        onValueChange(fromZonedInputValue(e.target.value, timeZone));
      }}
      {...props}
    />
  );
}

/**
 * Isian nominal Rupiah. Nilai keluar berupa string desimal `Money` ("60000.00") tanpa floating point
 * (ARCHITECTURE §2.5). Teks yang tidak dapat dibaca diteruskan apa adanya sehingga validasi zod
 * (`moneySchema`) menandainya tidak valid; kosong menjadi "".
 */
function toMoneyValue(text: string): string {
  return parseRupiahInput(text) ?? text.trim();
}

export interface MoneyFieldProps extends Omit<
  ComponentProps<"input">,
  "value" | "onChange" | "type" | "size"
> {
  value: string;
  onValueChange: (value: string) => void;
}

export function MoneyField({ value, onValueChange, onBlur, ...props }: MoneyFieldProps) {
  const [text, setText] = useState(() => formatRupiahInput(value));
  useEffect(() => {
    // Teks yang sedang diketik dipertahankan bila sudah mewakili nilai; selain itu (reset dari luar) diformat ulang.
    setText((current) => (toMoneyValue(current) === value ? current : formatRupiahInput(value) || value));
  }, [value]);
  return (
    <Input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={text}
      leading={<span className="font-semibold">Rp</span>}
      onChange={(e) => {
        setText(e.target.value);
        onValueChange(toMoneyValue(e.target.value));
      }}
      onBlur={(e) => {
        const parsed = parseRupiahInput(text);
        if (parsed) setText(formatRupiahInput(parsed));
        onBlur?.(e);
      }}
      {...props}
    />
  );
}
