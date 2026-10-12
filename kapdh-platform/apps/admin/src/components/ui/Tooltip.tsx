import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { cn } from "../../lib/cn";

/**
 * Tooltip teks yang muncul saat hover dan fokus keyboard, ditutup dengan Escape (WCAG 1.4.13, N-11).
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {trigger}
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 w-max max-w-60 -translate-x-1/2 rounded-sm bg-neutral-900 px-2 py-1 text-xs font-medium text-white shadow-raised",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {content}
      </span>
    </span>
  );
}
