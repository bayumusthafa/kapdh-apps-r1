import { CircleAlert } from "lucide-react";
import { type ComponentProps, type ReactNode, useId } from "react";
import {
  type Control,
  type ControllerFieldState,
  type ControllerRenderProps,
  type FieldPath,
  type FieldValues,
  useController,
  useFormContext,
} from "react-hook-form";
import { cn } from "../../lib/cn";

/** Label dengan penanda wajib yang juga dibacakan ("wajib"), bukan hanya tanda bintang. */
export function Label({
  required,
  className,
  children,
  ...props
}: ComponentProps<"label"> & { required?: boolean }) {
  return (
    <label className={cn("text-sm font-medium text-text", className)} {...props}>
      {children}
      {required ? (
        <>
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
          <span className="sr-only"> (wajib)</span>
        </>
      ) : null}
    </label>
  );
}

/** Atribut yang harus dipasang pada kontrol agar label, petunjuk dan galat terbaca (N-11). */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Label hanya untuk pembaca layar (mis. kotak cari dengan placeholder jelas). */
  labelHidden?: boolean;
  className?: string;
  /** id kontrol; bawaan dibuat otomatis. */
  id?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/** Bungkus label + kontrol + petunjuk + galat dengan id yang saling tertaut. */
export function Field({ label, hint, error, required, labelHidden, className, id, children }: FieldProps) {
  const auto = useId();
  const controlId = id ?? `f${auto}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={controlId} required={required} className={labelHidden ? "sr-only" : undefined}>
        {label}
      </Label>
      {children({
        id: controlId,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {hint ? (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1 text-xs font-medium text-danger">
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export interface FormFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> extends Omit<FieldProps, "children" | "error"> {
  name: TName;
  /** Bila tidak diisi, diambil dari <FormProvider>. */
  control?: Control<TFieldValues>;
  children: (
    field: ControllerRenderProps<TFieldValues, TName>,
    control: FieldControlProps,
    state: ControllerFieldState,
  ) => ReactNode;
}

/**
 * Field yang terikat react-hook-form. Galat validasi zod dan `field_errors` dari API (VALIDATION_ERROR,
 * dipasang lewat applyFieldErrors/useApiMutation) tampil di tempat yang sama.
 */
export function FormField<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  name,
  control,
  children,
  ...fieldProps
}: FormFieldProps<TFieldValues, TName>) {
  const ctx = useFormContext<TFieldValues>();
  const { field, fieldState } = useController<TFieldValues, TName>({
    name,
    control: control ?? ctx?.control,
  });
  return (
    <Field {...fieldProps} error={fieldState.error?.message ?? null}>
      {(a11y) => children(field, a11y, fieldState)}
    </Field>
  );
}

/** Galat tingkat formulir (mis. "Email atau password salah", galat `_` dari server). */
export function FormError({ message, className }: { message?: string | null; className?: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md border border-danger/30 bg-danger-bg px-3 py-2.5 text-sm text-danger",
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
