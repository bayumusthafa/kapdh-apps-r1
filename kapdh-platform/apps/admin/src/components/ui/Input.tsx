import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Kontrol isian dasar. Tinggi 48 px untuk formulir dan 44 px (`size="sm"`) untuk bilah filter (N-11).
 * Border #8A8F87 memiliki kontras 3,3:1 terhadap putih; status galat dibaca dari aria-invalid (bukan warna saja,
 * pesan galat selalu tertulis di bawah kontrol, PRD 4.5).
 */
export type ControlSize = "md" | "sm";

export const controlClass = (size: ControlSize = "md") =>
  cn(
    "w-full rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-text-muted",
    "disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-text",
    "aria-invalid:border-danger aria-invalid:ring-1 aria-invalid:ring-danger",
    size === "md" ? "h-12" : "h-11",
  );

export interface InputProps extends Omit<ComponentProps<"input">, "size"> {
  size?: ControlSize;
  /** Ikon/teks di sisi kiri di dalam kotak (mis. ikon cari, "Rp"). Dekoratif. */
  leading?: ReactNode;
  /** Elemen di sisi kanan (mis. tombol tampilkan sandi). */
  trailing?: ReactNode;
}

export function Input({ size = "md", leading, trailing, className, ...props }: InputProps) {
  if (!leading && !trailing) return <input className={cn(controlClass(size), className)} {...props} />;
  return (
    <div className="relative flex w-full items-center">
      {leading ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 flex items-center text-sm text-text-muted [&_svg]:size-4"
        >
          {leading}
        </span>
      ) : null}
      <input
        className={cn(controlClass(size), leading ? "pl-10" : null, trailing ? "pr-12" : null, className)}
        {...props}
      />
      {trailing ? <span className="absolute right-0.5 flex items-center">{trailing}</span> : null}
    </div>
  );
}

export interface TextareaProps extends ComponentProps<"textarea"> {
  /** Tampilkan penghitung karakter bila maxLength diisi. */
  showCount?: boolean;
}

export function Textarea({ className, showCount, maxLength, value, ...props }: TextareaProps) {
  const length = typeof value === "string" ? value.length : undefined;
  return (
    <div className="flex flex-col gap-1">
      <textarea
        maxLength={maxLength}
        value={value}
        className={cn(
          "min-h-24 w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm text-text placeholder:text-text-muted",
          "resize-y disabled:cursor-not-allowed disabled:bg-disabled-bg",
          "aria-invalid:border-danger aria-invalid:ring-1 aria-invalid:ring-danger",
          className,
        )}
        {...props}
      />
      {showCount && maxLength && length !== undefined ? (
        <span className="self-end text-xs text-text-muted" aria-live="polite">
          {length}/{maxLength} karakter
        </span>
      ) : null}
    </div>
  );
}

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> extends Omit<
  ComponentProps<"select">,
  "size" | "onChange" | "value"
> {
  options: readonly SelectOption<V>[];
  value: V | "";
  onValueChange: (value: V) => void;
  size?: ControlSize;
  /** Opsi kosong di awal, mis. "Pilih kategori". */
  placeholder?: string;
}

/** Select native (dapat dioperasikan keyboard dan pembaca layar tanpa skrip tambahan). */
export function Select<V extends string = string>({
  options,
  value,
  onValueChange,
  size = "md",
  placeholder,
  className,
  ...props
}: SelectProps<V>) {
  return (
    <select
      value={value}
      onChange={(e) => onValueChange(e.target.value as V)}
      className={cn(controlClass(size), "appearance-auto pr-8", className)}
      {...props}
    >
      {placeholder !== undefined ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
