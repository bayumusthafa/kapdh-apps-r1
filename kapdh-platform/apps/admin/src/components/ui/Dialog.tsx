import { X } from "lucide-react";
import { type ReactNode, type RefObject, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useModalLayer } from "../../lib/focus";
import { IconButton } from "./Button";

/**
 * Dialog modal yang dapat dioperasikan keyboard dan pembaca layar (N-11): role dialog/alertdialog,
 * aria-modal, judul dan deskripsi tertaut, fokus terjebak di dalam, Escape menutup lapisan teratas, fokus
 * kembali ke pemicu, latar di-inert. Dirender lewat portal ke <body> di luar #root.
 */
export interface DialogProps {
  open: boolean;
  /** Dipanggil saat Escape, klik latar, atau tombol tutup. Tidak dipanggil bila `dismissable` false. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** alertdialog untuk peringatan yang menuntut respons (idle timeout, konfirmasi destruktif). */
  role?: "dialog" | "alertdialog";
  size?: "sm" | "md" | "lg";
  /** false: Escape/latar/tombol tutup tidak menutup (mis. saat permintaan sedang berjalan). */
  dismissable?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  hideCloseButton?: boolean;
  className?: string;
}

const WIDTH = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" } as const;

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  role = "dialog",
  size = "md",
  dismissable = true,
  initialFocusRef,
  hideCloseButton,
  className,
}: DialogProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalLayer({
    open,
    containerRef: panelRef,
    initialFocusRef,
    onEscape: dismissable ? onClose : () => undefined,
  });
  if (!open) return null;
  const titleId = `${id}-title`;
  const descId = description ? `${id}-desc` : undefined;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end justify-center p-4 sm:items-center">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-neutral-900/50"
        onClick={dismissable ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className={cn(
          "relative z-10 flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-xl bg-surface shadow-raised",
          WIDTH[size],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-divider px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="font-heading text-h3 font-semibold">
              {title}
            </h2>
            {description ? (
              <div id={descId} className="text-sm text-text-muted">
                {description}
              </div>
            ) : null}
          </div>
          {hideCloseButton || !dismissable ? null : (
            <IconButton label="Tutup" icon={<X />} tone="neutral" tooltip={false} onClick={onClose} />
          )}
        </div>
        {children ? <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div> : null}
        {footer ? (
          <div className="flex flex-wrap justify-end gap-3 border-t border-divider bg-neutral-50 px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** Panel samping (detail, formulir panjang) dengan perilaku modal yang sama seperti Dialog. */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = "right",
  dismissable = true,
  tone = "light",
  className,
}: Omit<DialogProps, "role" | "size" | "initialFocusRef" | "hideCloseButton"> & {
  side?: "left" | "right";
  /** "dark" untuk menu navigasi bergaya sidebar hijau tua. */
  tone?: "light" | "dark";
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalLayer({ open, containerRef: panelRef, onEscape: dismissable ? onClose : () => undefined });
  if (!open) return null;
  const titleId = `${id}-title`;
  const descId = description ? `${id}-desc` : undefined;
  const dark = tone === "dark";
  return createPortal(
    <div className="fixed inset-0 z-40 flex">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-neutral-900/50"
        onClick={dismissable ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        data-surface={dark ? "dark" : undefined}
        className={cn(
          "relative z-10 flex h-full w-full max-w-md flex-col shadow-raised",
          side === "right" ? "ml-auto" : "mr-auto",
          dark ? "bg-surface-dark text-text-on-dark" : "bg-surface",
          className,
        )}
      >
        <div
          className={cn(
            "flex items-start justify-between gap-3 px-5 py-4",
            dark ? "border-b border-green-800" : "border-b border-divider",
          )}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="font-heading text-h3 font-semibold">
              {title}
            </h2>
            {description ? (
              <div id={descId} className={cn("text-sm", dark ? "text-green-100" : "text-text-muted")}>
                {description}
              </div>
            ) : null}
          </div>
          {dismissable ? (
            <IconButton
              label="Tutup"
              icon={<X />}
              tone={dark ? "on-dark" : "neutral"}
              tooltip={false}
              onClick={onClose}
            />
          ) : null}
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-3 border-t border-divider px-5 py-4">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
