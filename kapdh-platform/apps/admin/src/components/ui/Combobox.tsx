import { Check, Search, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toApiError } from "../../api/errors";
import { cn } from "../../lib/cn";
import { useOutsideClick } from "../../lib/focus";
import { Field } from "./FormField";
import { controlClass } from "./Input";
import { Spinner } from "./Spinner";

/**
 * Combobox pencarian asinkron (pola WAI-ARIA combobox + listbox, N-11), mis. memilih alumni untuk undangan admin
 * atau event untuk banner. Hasil diambil dari server dengan debounce dan permintaan lama dibatalkan.
 */
export interface ComboboxOption {
  value: string;
  label: string;
  description?: ReactNode;
}

export interface ComboboxProps {
  label: string;
  value: ComboboxOption | null;
  onValueChange: (option: ComboboxOption | null) => void;
  loadOptions: (query: string, signal: AbortSignal) => Promise<ComboboxOption[]>;
  placeholder?: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  minQueryLength?: number;
  delayMs?: number;
  emptyText?: string;
  className?: string;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; options: ComboboxOption[] };

export function Combobox({
  label,
  value,
  onValueChange,
  loadOptions,
  placeholder = "Ketik untuk mencari",
  hint,
  error,
  required,
  disabled,
  minQueryLength = 1,
  delayMs = 300,
  emptyText = "Tidak ada hasil.",
  className,
}: ComboboxProps) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(value?.label ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const loadRef = useRef(loadOptions);
  loadRef.current = loadOptions;

  useEffect(() => {
    setText(value?.label ?? "");
  }, [value]);

  const query = text.trim();
  const shouldSearch = open && query.length >= minQueryLength && query !== value?.label;
  useEffect(() => {
    if (!shouldSearch) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    const t = window.setTimeout(() => {
      loadRef
        .current(query, controller.signal)
        .then((options) => {
          if (!controller.signal.aborted) {
            setState({ kind: "done", options });
            setActive(options.length > 0 ? 0 : -1);
          }
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setState({ kind: "error", message: toApiError(e).message });
        });
    }, delayMs);
    return () => {
      window.clearTimeout(t);
      controller.abort();
    };
  }, [shouldSearch, query, delayMs]);

  function close(revert = true) {
    setOpen(false);
    setActive(-1);
    if (revert) setText(value?.label ?? "");
  }
  useOutsideClick(wrapRef, open, () => close());

  const options = state.kind === "done" ? state.options : [];

  function select(option: ComboboxOption) {
    onValueChange(option);
    setText(option.label);
    close(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else if (options.length > 0) setActive((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length > 0) setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      if (open && active >= 0 && options[active]) {
        e.preventDefault();
        select(options[active]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    } else if (e.key === "Tab") {
      close();
    }
  }

  const status =
    !open || query.length < minQueryLength
      ? ""
      : state.kind === "loading"
        ? "Mencari..."
        : state.kind === "error"
          ? state.message
          : state.kind === "done"
            ? options.length === 0
              ? emptyText
              : `${options.length} hasil tersedia. Gunakan panah atas/bawah lalu Enter untuk memilih.`
            : "";

  const activeId = open && active >= 0 && options[active] ? `${listId}-opt-${active}` : undefined;
  const showList = open && query.length >= minQueryLength;

  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(a11y) => (
        <div ref={wrapRef} className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          >
            {state.kind === "loading" && open ? <Spinner /> : <Search className="size-4" />}
          </span>
          <input
            {...a11y}
            type="text"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            autoComplete="off"
            disabled={disabled}
            placeholder={placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
              if (value && e.target.value !== value.label) onValueChange(null);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            className={cn(controlClass("md"), "pl-10", value ? "pr-12" : null)}
          />
          {value && !disabled ? (
            <button
              type="button"
              aria-label={`Hapus pilihan ${value.label}`}
              onClick={() => {
                onValueChange(null);
                setText("");
              }}
              className="absolute right-0.5 top-1/2 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-text-muted hover:bg-neutral-100"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            hidden={!showList || options.length === 0}
            className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-divider bg-surface py-1 shadow-raised"
          >
            {options.map((o, i) => {
              const selected = value?.value === o.value;
              return (
                <li
                  key={o.value}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={selected}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => select(o)}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-start gap-2 px-3 py-2 text-sm",
                    i === active && "bg-green-50",
                  )}
                >
                  <Check
                    aria-hidden="true"
                    className={cn("mt-0.5 size-4 shrink-0 text-primary", selected ? "visible" : "invisible")}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{o.label}</span>
                    {o.description ? <span className="text-xs text-text-muted">{o.description}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <span
            role="status"
            aria-live="polite"
            className={cn(
              status && showList && options.length === 0 ? "mt-1 block text-xs text-text-muted" : "sr-only",
            )}
          >
            {status}
          </span>
        </div>
      )}
    </Field>
  );
}
