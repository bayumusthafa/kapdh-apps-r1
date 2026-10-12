import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";

/**
 * Tombol design system web admin (Guidelines KAPDH v1.0 hlm. 10-17, prototipe screen_8).
 * - `gradient`: tombol utama bergradasi hijau (halaman masuk, aksi utama halaman).
 * - `primary`: hijau solid (Setujui, Simpan).
 * - `outline`: sekunder bergaris hijau.
 * - `danger`: destruktif bergaris merah (Tolak, Hapus); konfirmasi tetap lewat ConfirmDialog (PRD 4.5).
 * - `danger-solid`: tombol konfirmasi akhir tindakan destruktif di dalam dialog.
 * - `ghost`: tanpa latar (tautan aksi, tombol di bilah alat).
 * Target sentuh minimal 44 px (N-11). Saat `loading`, tombol tetap dapat difokus (aria-disabled) agar fokus
 * keyboard tidak hilang, tetapi klik diabaikan.
 */
export type ButtonVariant = "gradient" | "primary" | "outline" | "danger" | "danger-solid" | "ghost";
export type ButtonSize = "md" | "sm";

const VARIANT: Record<ButtonVariant, string> = {
  gradient: "bg-gradient-primary text-on-primary hover:brightness-110 shadow-card",
  primary: "bg-primary text-on-primary hover:bg-primary-hover",
  outline: "border border-primary bg-surface text-primary hover:bg-green-50",
  danger: "border border-danger bg-surface text-danger hover:bg-danger-bg",
  "danger-solid": "bg-danger text-on-primary hover:brightness-110",
  ghost: "bg-transparent text-primary hover:bg-green-50",
};

const SIZE: Record<ButtonSize, string> = {
  md: "h-12 px-5 text-sm",
  sm: "h-11 px-4 text-sm",
};

const DISABLED =
  "disabled:cursor-not-allowed disabled:border-transparent disabled:bg-disabled-bg disabled:bg-none disabled:text-disabled-text disabled:shadow-none aria-disabled:cursor-not-allowed " +
  // Nonaktif yang tetap dapat difokus (`focusableWhenDisabled`): tampilan sama dengan disabled native.
  "data-soft-disabled:border-transparent data-soft-disabled:bg-disabled-bg data-soft-disabled:bg-none data-soft-disabled:text-disabled-text data-soft-disabled:shadow-none";

/** Kelas tombol untuk elemen lain (mis. <Link> yang tampil sebagai tombol, tanpa menyarangkan <button>). */
export function buttonClass({
  variant = "primary",
  size = "md",
  fullWidth,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean; className?: string } = {}): string {
  return cn(
    "inline-flex select-none items-center justify-center gap-2 rounded-md font-semibold transition-colors",
    VARIANT[variant],
    SIZE[size],
    DISABLED,
    // Tombol ghost nonaktif cukup berteks redup tanpa latar abu-abu.
    variant === "ghost" && "disabled:bg-transparent data-soft-disabled:bg-transparent",
    fullWidth && "w-full",
    className,
  );
}

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Teks pengganti saat memuat, mis. "Menyimpan..." (bawaan: label tombol tetap). */
  loadingText?: string;
  leftIcon?: ReactNode;
  fullWidth?: boolean;
  /**
   * Saat `disabled`, tombol tetap dapat difokus (aria-disabled, klik diabaikan) alih-alih atribut disabled native.
   * Pakai untuk tombol yang bisa menjadi nonaktif tepat setelah ditekan (paging, hitung mundur coba lagi) agar
   * fokus keyboard tidak jatuh ke <body> (N-11).
   */
  focusableWhenDisabled?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  loadingText,
  leftIcon,
  fullWidth,
  focusableWhenDisabled = false,
  className,
  children,
  type = "button",
  onClick,
  disabled,
  ...props
}: ButtonProps) {
  const softDisabled = Boolean(disabled) && focusableWhenDisabled;
  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    if (loading || softDisabled) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  }
  return (
    <button
      type={type}
      disabled={softDisabled ? undefined : disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || softDisabled || undefined}
      data-soft-disabled={softDisabled || undefined}
      onClick={handleClick}
      className={buttonClass({ variant, size, fullWidth, className })}
      {...props}
    >
      {loading ? <Spinner /> : leftIcon}
      <span>{loading && loadingText ? loadingText : children}</span>
    </button>
  );
}

export type IconButtonTone = "primary" | "danger" | "neutral" | "on-dark";

const TONE: Record<IconButtonTone, string> = {
  // Ikon ubah hijau dan hapus merah sesuai tabel guidelines (hlm. 13-17): ubah berlatar terang bergaris hijau,
  // hapus berupa kotak merah PEKAT dengan ikon putih (#FFF di atas #B3261E ~6,5:1) agar tindakan destruktif
  // jelas berbeda dari tindakan biasa.
  primary: "border border-green-100 bg-green-50 text-primary hover:bg-green-100",
  danger: "border border-danger bg-danger text-on-primary hover:brightness-110",
  neutral: "border border-divider bg-surface text-text hover:bg-neutral-100",
  "on-dark": "text-text-on-dark hover:bg-green-800",
};

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children" | "aria-label"> {
  /** Nama aksesibel wajib, mis. "Ubah Siti Rahmawati". Juga ditampilkan sebagai tooltip. */
  label: string;
  icon: ReactNode;
  tone?: IconButtonTone;
  loading?: boolean;
  /** Tampilkan tooltip saat hover/fokus (bawaan true). */
  tooltip?: boolean;
}

/** Tombol ikon 44x44 px (N-11) dengan nama aksesibel dan tooltip. */
export function IconButton({
  label,
  icon,
  tone = "neutral",
  loading = false,
  tooltip = true,
  className,
  type = "button",
  onClick,
  ...props
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      aria-label={label}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-md transition-colors [&_svg]:size-[18px]",
        TONE[tone],
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {loading ? <Spinner /> : icon}
    </button>
  );
  return tooltip ? (
    <Tooltip content={label} describe={false}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}
