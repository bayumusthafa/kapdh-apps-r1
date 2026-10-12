import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { cn } from "../../lib/cn";

/**
 * Tab pil hijau tua sesuai guidelines (hlm. 13 "Banner | Feed Informasi", hlm. 17 "Verifikasi Pembayaran |
 * Kelola Metode | Biaya Pembayaran"). Pola WAI-ARIA Tabs: roving tabindex, panah kiri/kanan, Home/End,
 * aktivasi otomatis. Nilai dikendalikan pemanggil sehingga dapat disimpan di URL (?tab=...).
 */
export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Angka kecil di samping label (mis. jumlah menunggu). */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<V extends string = string> {
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  onValueChange: (value: V) => void;
  className?: string;
  /**
   * Awalan id agar panel dapat ditautkan (`${idPrefix}-panel-${value}`). Hanya tab terpilih yang memberi
   * aria-controls, karena halaman hanya merender <TabPanel> tab aktif (referensi ke id yang tidak ada dilarang).
   */
  idPrefix?: string;
}

export function tabIds(prefix: string, value: string) {
  return { tab: `${prefix}-tab-${value}`, panel: `${prefix}-panel-${value}` };
}

export function Tabs<V extends string = string>({
  label,
  items,
  value,
  onValueChange,
  className,
  idPrefix,
}: TabsProps<V>) {
  const auto = useId();
  const prefix = idPrefix ?? `tabs${auto}`;
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabled = items.filter((i) => !i.disabled);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const index = enabled.findIndex((i) => i.value === value);
    let next: TabItem<V> | undefined;
    if (e.key === "ArrowRight") next = enabled[(index + 1) % enabled.length];
    else if (e.key === "ArrowLeft") next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onValueChange(next.value);
    refs.current.get(next.value)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex max-w-full flex-wrap gap-1 rounded-pill border border-divider bg-surface p-1 shadow-card",
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        const ids = tabIds(prefix, item.value);
        return (
          <button
            key={item.value}
            ref={(el) => {
              if (el) refs.current.set(item.value, el);
              else refs.current.delete(item.value);
            }}
            id={ids.tab}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={selected && idPrefix ? ids.panel : undefined}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-pill px-4 text-sm font-semibold transition-colors",
              selected ? "bg-primary text-on-primary shadow-card" : "text-text hover:bg-green-50",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span
                className={cn(
                  "rounded-pill px-2 py-0.5 text-xs font-bold",
                  selected ? "bg-accent text-on-accent" : "bg-green-100 text-primary",
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  idPrefix,
  value,
  children,
  className,
}: {
  idPrefix: string;
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const ids = tabIds(idPrefix, value);
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} tabIndex={0} className={className}>
      {children}
    </div>
  );
}
