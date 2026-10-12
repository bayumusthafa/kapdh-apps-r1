import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Daftar label-nilai (<dl>) dua kolom yang menyusut menjadi satu kolom di layar sempit (prototipe screen_8). */
export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Bentang penuh dua kolom (nilai panjang, mis. riwayat). */
  wide?: boolean;
}

export function KeyValueList({ items, className }: { items: KeyValueItem[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-2", className)}>
      {items.map((item, i) => (
        <div key={i} className={cn("flex min-w-0 flex-col gap-0.5", item.wide && "sm:col-span-2")}>
          <dt className="text-xs text-text-muted">{item.label}</dt>
          <dd className="min-w-0 break-words font-medium">{item.value ?? "-"}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface TimelineItem {
  id: string;
  title: ReactNode;
  time?: ReactNode;
  description?: ReactNode;
  tone?: "neutral" | "success" | "danger" | "info" | "warning";
}

const DOT: Record<NonNullable<TimelineItem["tone"]>, string> = {
  neutral: "bg-neutral-500",
  success: "bg-success",
  danger: "bg-danger",
  info: "bg-info",
  warning: "bg-warning",
};

/** Riwayat berurutan waktu (riwayat pembayaran, audit objek). Urutan dibacakan sebagai daftar bernomor. */
export function Timeline({
  items,
  label,
  className,
}: {
  items: TimelineItem[];
  label: string;
  className?: string;
}) {
  return (
    <ol aria-label={label} className={cn("flex flex-col", className)}>
      {items.map((item, i) => (
        <li key={item.id} className="relative flex gap-3 pb-3 last:pb-0">
          {i < items.length - 1 ? (
            <span aria-hidden="true" className="absolute left-[5px] top-4 h-full w-px bg-divider" />
          ) : null}
          <span
            aria-hidden="true"
            className={cn("mt-1.5 size-[11px] shrink-0 rounded-pill", DOT[item.tone ?? "neutral"])}
          />
          <div className="flex min-w-0 flex-col gap-0.5 text-sm">
            <span className="font-medium">{item.title}</span>
            {item.time ? <span className="text-xs text-text-muted">{item.time}</span> : null}
            {item.description ? <span className="text-text-muted">{item.description}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Inisial dua huruf dari nama ("Siti Rahmawati" → "SR"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : parts[0]!.charAt(1);
  return (first + last).toUpperCase();
}

/**
 * Avatar foto atau inisial. Foto bersifat dekoratif bila nama ditampilkan di sebelahnya (`decorative`), selain
 * itu alt berisi nama.
 */
export function Avatar({
  name,
  src,
  size = "md",
  decorative = true,
  className,
}: {
  name: string;
  src?: string | null;
  size?: "sm" | "md" | "lg";
  decorative?: boolean;
  className?: string;
}) {
  const sizeCls = { sm: "size-8 text-xs", md: "size-10 text-sm", lg: "size-14 text-base" }[size];
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img" as const, "aria-label": name };
  if (src)
    return (
      <img
        src={src}
        alt={decorative ? "" : name}
        referrerPolicy="no-referrer"
        className={cn("shrink-0 rounded-pill object-cover", sizeCls, className)}
      />
    );
  return (
    <span
      {...a11y}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-pill bg-green-100 font-semibold text-primary",
        sizeCls,
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
