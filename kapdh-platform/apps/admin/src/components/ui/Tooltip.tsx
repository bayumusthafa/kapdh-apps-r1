import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";

/** Jeda sebelum tooltip disembunyikan agar penunjuk sempat berpindah dari pemicu ke gelembung (WCAG 1.4.13). */
const HIDE_DELAY_MS = 150;

/**
 * Tooltip teks yang muncul saat hover dan fokus keyboard (WCAG 1.4.13, N-11):
 * - dapat di-hover: gelembung menerima penunjuk dan tetap terbuka selama penunjuk berada di pemicu atau gelembung;
 * - dapat ditutup: Escape menyembunyikannya tanpa memindah fokus/penunjuk. Escape ditangkap lebih dulu (fase
 *   capture) dan ditandai preventDefault sehingga dialog induk tidak ikut tertutup;
 * - persisten: tetap tampil sampai fokus/penunjuk pergi atau Escape.
 * `describe` (bawaan true) menautkan tooltip ke pemicu lewat aria-describedby; matikan bila isinya sama dengan
 * nama aksesibel pemicu (mis. IconButton) agar tidak dibacakan dua kali.
 */
export function Tooltip({
  content,
  children,
  describe = true,
  side = "top",
}: {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
  describe?: boolean;
  side?: "top" | "bottom";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const hideTimer = useRef<number | null>(null);

  function cancelHide() {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }
  function show() {
    cancelHide();
    setOpen(true);
  }
  function hideSoon() {
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setOpen(false);
    }, HIDE_DELAY_MS);
  }
  function hideNow() {
    cancelHide();
    setOpen(false);
  }

  useEffect(() => () => cancelHide(), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const trigger =
    describe && isValidElement(children)
      ? cloneElement(children, {
          "aria-describedby": [children.props["aria-describedby"], id].filter(Boolean).join(" "),
        })
      : children;

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocusCapture={show}
      onBlurCapture={hideNow}
    >
      {trigger}
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        className={cn(
          "absolute left-1/2 z-50 w-max max-w-60 -translate-x-1/2 rounded-sm bg-neutral-900 px-2 py-1 text-xs font-medium text-white shadow-raised",
          // Jembatan tak terlihat menutup celah antara pemicu dan gelembung agar penunjuk dapat berpindah.
          "before:absolute before:inset-x-0 before:h-2 before:content-['']",
          side === "top" ? "bottom-full mb-1.5 before:top-full" : "top-full mt-1.5 before:bottom-full",
        )}
      >
        {content}
      </span>
    </span>
  );
}
