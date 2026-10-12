import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Utilitas fokus untuk dialog modal (N-11: admin dapat dioperasikan dengan keyboard dan pembaca layar).
 * - Fokus dipindah ke dalam dialog saat dibuka dan dikembalikan ke pemicu saat ditutup.
 * - Tab/Shift+Tab berputar di dalam dialog.
 * - Escape hanya menutup lapisan paling atas (dialog bertumpuk, mis. reautentikasi di atas konfirmasi).
 * - Selama ada modal, #root diberi `inert` dan body tidak dapat digulir.
 */

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getAttribute("aria-hidden") !== "true" && !el.closest("[inert]"),
  );
}

const layers: symbol[] = [];
let lockCount = 0;
let previousOverflow = "";

function lockBackground() {
  lockCount += 1;
  if (lockCount > 1) return;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.getElementById("root")?.setAttribute("inert", "");
}

function unlockBackground() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount > 0) return;
  document.body.style.overflow = previousOverflow;
  document.getElementById("root")?.removeAttribute("inert");
}

export interface ModalLayerOptions {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onEscape?: () => void;
  initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  /** Kembalikan fokus ke elemen yang aktif sebelum dialog dibuka (bawaan true). */
  restoreFocus?: boolean;
}

/** Jebakan fokus, Escape untuk lapisan teratas, kunci latar dan pemulihan fokus untuk satu dialog modal. */
export function useModalLayer({
  open,
  containerRef,
  onEscape,
  initialFocusRef,
  restoreFocus = true,
}: ModalLayerOptions): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useLayoutEffect(() => {
    if (!open) return;
    const layer = Symbol("modal-layer");
    layers.push(layer);
    lockBackground();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const target = initialFocusRef?.current ?? (container ? getFocusable(container)[0] : null) ?? container;
    target?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (layers[layers.length - 1] !== layer) return;
      if (e.key === "Escape") {
        if (onEscapeRef.current) {
          e.preventDefault();
          e.stopPropagation();
          onEscapeRef.current();
        }
        return;
      }
      if (e.key !== "Tab" || !container) return;
      const items = getFocusable(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !container.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !container.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const idx = layers.indexOf(layer);
      if (idx >= 0) layers.splice(idx, 1);
      unlockBackground();
      if (restoreFocus && previouslyFocused && document.contains(previouslyFocused))
        previouslyFocused.focus();
    };
    // initialFocusRef/containerRef adalah ref stabil; efek hanya bergantung pada status buka.
  }, [open]);
}

/** Jalankan callback saat klik terjadi di luar elemen (untuk popover/listbox non-modal). */
export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void,
): void {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [active, ref]);
}
