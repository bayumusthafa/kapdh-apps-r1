import { type ComponentProps, type ReactNode, useEffect, useId, useRef } from "react";
import { cn } from "../../lib/cn";

/**
 * Kontrol pilihan: Checkbox dan RadioGroup memakai input native (keyboard & pembaca layar bawaan peramban),
 * Switch memakai pola WAI-ARIA `role="switch"`. Area klik minimal 44 px (N-11).
 */

export interface CheckboxProps extends Omit<ComponentProps<"input">, "type" | "onChange"> {
  label: ReactNode;
  description?: ReactNode;
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Tampilan kotak berlatar hijau muda seperti konfirmasi dana di prototipe screen_8. */
  boxed?: boolean;
  error?: string | null;
}

export function Checkbox({
  label,
  description,
  indeterminate = false,
  onCheckedChange,
  boxed,
  error,
  className,
  id,
  ref: externalRef,
  ...props
}: CheckboxProps) {
  const auto = useId();
  const inputId = id ?? `cb${auto}`;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const descId = description ? `${inputId}-desc` : undefined;
  const errId = error ? `${inputId}-err` : undefined;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        htmlFor={inputId}
        className={cn(
          "flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-relaxed",
          boxed && "rounded-md bg-green-50 p-3",
          props.disabled && "cursor-not-allowed opacity-70",
        )}
      >
        <input
          ref={(el) => {
            ref.current = el;
            if (typeof externalRef === "function") externalRef(el);
            else if (externalRef) externalRef.current = el;
          }}
          id={inputId}
          type="checkbox"
          aria-describedby={[errId, descId].filter(Boolean).join(" ") || undefined}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onCheckedChange?.(e.target.checked)}
          className="mt-0.5 size-5 shrink-0 cursor-pointer accent-[var(--color-primary)] disabled:cursor-not-allowed"
          {...props}
        />
        <span className="flex flex-col gap-0.5">
          <span>{label}</span>
          {description ? (
            <span id={descId} className="text-xs text-text-muted">
              {description}
            </span>
          ) : null}
        </span>
      </label>
      {error ? (
        <p id={errId} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface SwitchProps extends Omit<ComponentProps<"button">, "onChange" | "role"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  /** Teks status di samping saklar (bawaan "Aktif"/"Nonaktif") agar status tidak hanya warna (PRD 4.5). */
  stateLabels?: [on: string, off: string];
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  stateLabels = ["Aktif", "Nonaktif"],
  disabled,
  className,
  ...props
}: SwitchProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descId = description ? `${id}-desc` : undefined;
  return (
    <div className={cn("flex min-h-11 items-center justify-between gap-4", className)}>
      <div className="flex flex-col gap-0.5">
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
        {description ? (
          <span id={descId} className="text-xs text-text-muted">
            {description}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descId}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-pill px-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60"
        {...props}
      >
        <span
          aria-hidden="true"
          className={cn(
            "relative inline-flex h-6 w-11 items-center rounded-pill border transition-colors",
            checked ? "border-primary bg-primary" : "border-border bg-neutral-200",
          )}
        >
          <span
            className={cn(
              "absolute size-5 rounded-pill bg-white shadow-card transition-transform",
              checked ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </span>
        <span aria-hidden="true" className={checked ? "text-primary" : "text-text-muted"}>
          {checked ? stateLabels[0] : stateLabels[1]}
        </span>
      </button>
    </div>
  );
}

export interface RadioOption<V extends string = string> {
  value: V;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<V extends string = string> {
  legend: ReactNode;
  name?: string;
  value: V | null;
  onValueChange: (value: V) => void;
  options: readonly RadioOption<V>[];
  /** "card" menampilkan opsi sebagai kartu bergaris (mis. metode bayar). */
  variant?: "list" | "card";
  orientation?: "vertical" | "horizontal";
  error?: string | null;
  hint?: ReactNode;
  required?: boolean;
  legendHidden?: boolean;
  className?: string;
}

export function RadioGroup<V extends string = string>({
  legend,
  name,
  value,
  onValueChange,
  options,
  variant = "list",
  orientation = "vertical",
  error,
  hint,
  required,
  legendHidden,
  className,
}: RadioGroupProps<V>) {
  const auto = useId();
  const groupName = name ?? `rg${auto}`;
  const hintId = hint ? `${groupName}-hint` : undefined;
  const errId = error ? `${groupName}-err` : undefined;
  return (
    <fieldset
      aria-describedby={[errId, hintId].filter(Boolean).join(" ") || undefined}
      aria-invalid={error ? true : undefined}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      <legend className={cn("mb-1 text-sm font-medium", legendHidden && "sr-only")}>
        {legend}
        {required ? (
          <>
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
            <span className="sr-only"> (wajib)</span>
          </>
        ) : null}
      </legend>
      <div className={cn("flex gap-2", orientation === "vertical" ? "flex-col" : "flex-wrap")}>
        {options.map((o) => {
          const id = `${groupName}-${o.value}`;
          const checked = value === o.value;
          return (
            <label
              key={o.value}
              htmlFor={id}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 text-sm",
                variant === "card" &&
                  "rounded-md border bg-surface p-3 has-[:checked]:border-primary has-[:checked]:bg-green-50",
                variant === "card" && !checked && "border-divider",
                o.disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                id={id}
                type="radio"
                name={groupName}
                value={o.value}
                checked={checked}
                disabled={o.disabled}
                required={required}
                onChange={() => onValueChange(o.value)}
                className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
              />
              <span className="flex flex-col gap-0.5">
                <span className={cn(variant === "card" && "font-semibold")}>{o.label}</span>
                {o.description ? <span className="text-xs text-text-muted">{o.description}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
