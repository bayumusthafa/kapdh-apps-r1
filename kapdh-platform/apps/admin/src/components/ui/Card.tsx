import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Kartu putih bergaris tipis di atas latar krem/abu (prototipe screen_8, guidelines hlm. 12-17). */
export function Card({
  className,
  as: Tag = "section",
  ...props
}: Omit<ComponentProps<"section">, "ref"> & { as?: "section" | "div" | "article" | "aside" }) {
  return <Tag className={cn("rounded-lg border border-divider bg-surface", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  actions,
  titleId,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 px-5 pt-4", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id={titleId} className="font-heading text-h3 font-semibold text-primary">
          {title}
        </h2>
        {description ? <p className="text-sm text-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Kartu statistik dasbor (guidelines hlm. 12: "5 Pengguna Aktif dari 5 total alumni", "Rp 295.224 Total
 * Transaksi"). Nilai ditulis sebagai teks; ikon dekoratif.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "primary",
  loading,
  action,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: "primary" | "warning" | "danger" | "info";
  loading?: boolean;
  action?: ReactNode;
}) {
  const toneCls = {
    primary: "bg-green-100 text-primary",
    warning: "bg-warning-bg text-warning",
    danger: "bg-danger-bg text-danger",
    info: "bg-info-bg text-info",
  }[tone];
  return (
    <Card as="div" className="flex min-w-0 flex-[1_1_220px] items-start gap-3 p-4 shadow-card">
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-pill [&_svg]:size-5",
            toneCls,
          )}
        >
          {icon}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-col gap-0.5">
        {loading ? (
          <span className="h-7 w-16 animate-pulse rounded-sm bg-neutral-200" aria-hidden="true" />
        ) : (
          <span className="font-heading text-h2 font-semibold leading-tight">{value}</span>
        )}
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-xs text-text-muted">{hint}</span> : null}
        {loading ? <span className="sr-only">Memuat {label}</span> : null}
        {action ? <div className="mt-1">{action}</div> : null}
      </div>
    </Card>
  );
}
