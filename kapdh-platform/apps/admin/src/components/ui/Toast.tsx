import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

/**
 * Notifikasi singkat (toast). Dua wadah live SELALU terpasang sejak awal (kosong) di luar #root agar tetap terbaca
 * saat dialog modal membuat latar inert: galat masuk ke wadah aria-live="assertive", selain itu ke wadah
 * aria-live="polite". Toast baru adalah tambahan isi wadah yang sudah ada sehingga pasti diumumkan pembaca layar
 * (elemen live yang baru dipasang bersama isinya sering diabaikan). Toast berhenti menghitung mundur saat
 * disorot/fokus dan selalu dapat ditutup dengan tombol (N-11, WCAG 2.2.1).
 */
export type ToastTone = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

export interface ToastApi {
  show(tone: ToastTone, message: string): void;
  success(message: string): void;
  error(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DURATION: Record<ToastTone, number> = { success: 5000, info: 6000, warning: 8000, error: 8000 };
const MAX_VISIBLE = 4;

const STYLE: Record<ToastTone, { cls: string; icon: ReactNode; label: string }> = {
  success: { cls: "border-success/30 bg-success-bg text-success", icon: <CircleCheck />, label: "Berhasil" },
  error: { cls: "border-danger/30 bg-danger-bg text-danger", icon: <CircleAlert />, label: "Gagal" },
  info: { cls: "border-info/30 bg-info-bg text-info", icon: <Info />, label: "Info" },
  warning: {
    cls: "border-warning/30 bg-warning-bg text-warning",
    icon: <TriangleAlert />,
    label: "Perhatian",
  },
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback((tone: ToastTone, message: string) => {
    const id = nextId++;
    setItems((all) => {
      // Pesan identik yang masih tampil tidak ditumpuk (mis. beberapa query gagal karena jaringan).
      if (all.some((t) => t.tone === tone && t.message === message)) return all;
      return [...all, { id, tone, message }].slice(-MAX_VISIBLE);
    });
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (m) => show("success", m),
      error: (m) => show("error", m),
      info: (m) => show("info", m),
      warning: (m) => show("warning", m),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <section
          aria-label="Notifikasi"
          className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
        >
          <div aria-live="assertive" aria-relevant="additions text" className="flex flex-col gap-2">
            {items
              .filter((t) => t.tone === "error")
              .map((t) => (
                <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
              ))}
          </div>
          <div aria-live="polite" aria-relevant="additions text" className="flex flex-col gap-2">
            {items
              .filter((t) => t.tone !== "error")
              .map((t) => (
                <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
              ))}
          </div>
        </section>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(DURATION[item.tone]);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const t = window.setTimeout(() => onDismissRef.current(), remaining.current);
    return () => {
      window.clearTimeout(t);
      remaining.current -= Date.now() - started;
    };
  }, [paused]);

  const s = STYLE[item.tone];
  return (
    <div
      data-toast={item.tone}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-lg border bg-surface p-3 text-sm shadow-raised",
        s.cls,
      )}
    >
      <span aria-hidden="true" className="mt-0.5 [&_svg]:size-5">
        {s.icon}
      </span>
      <p className="min-w-0 flex-1 text-text">
        <span className="sr-only">{s.label}: </span>
        {item.message}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Tutup notifikasi"
        className="-m-1.5 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-black/5"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast harus dipakai di dalam ToastProvider");
  return ctx;
}
