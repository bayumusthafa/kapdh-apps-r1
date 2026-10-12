import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "outline" | "danger" }) {
  const styles = {
    primary:
      "bg-primary text-on-primary hover:bg-primary-hover disabled:bg-disabled-bg disabled:text-disabled-text",
    outline: "border border-primary text-primary bg-surface hover:bg-green-50",
    danger: "border border-danger text-danger bg-surface hover:bg-danger-bg",
  }[variant];
  return (
    <button
      className={`h-12 rounded-md px-5 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  );
}

export function TextField({
  label,
  error,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; hint?: ReactNode }) {
  const id = useId();
  const errId = `${id}-err`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        className={`h-12 rounded-md border bg-surface px-3 text-sm ${error ? "border-danger" : "border-border"}`}
        {...props}
      />
      {hint && !error ? <p className="text-xs text-text-muted">{hint}</p> : null}
      {error ? (
        <p id={errId} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const STATUS_STYLE = {
  pending: { label: "Menunggu", cls: "bg-info-bg text-info" },
  paid: { label: "Disetujui", cls: "bg-success-bg text-success" },
  rejected: { label: "Ditolak", cls: "bg-danger-bg text-danger" },
  cancelled: { label: "Dibatalkan", cls: "bg-neutral-bg text-neutral" },
} as const;

/** Status selalu berlabel teks, bukan warna saja (PRD 4.5). */
export function PaymentStatusBadge({ status }: { status: keyof typeof STATUS_STYLE }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-semibold ${s.cls}`}
    >
      {s.label}
    </span>
  );
}
