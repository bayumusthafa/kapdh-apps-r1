import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Field } from "./FormField";
import { Input } from "./Input";

/**
 * Kotak cari dengan debounce (bawaan 300 ms) agar API tidak dipanggil setiap ketukan (paging server, F-15).
 * Escape mengosongkan isian. Nilai `value` dari luar (mis. reset filter) disinkronkan ke isian.
 */
export function SearchInput({
  label,
  value,
  onValueChange,
  placeholder,
  delayMs = 300,
  labelHidden = false,
  maxLength = 100,
  className,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  delayMs?: number;
  labelHidden?: boolean;
  maxLength?: number;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const lastEmitted = useRef(value);
  const onChangeRef = useRef(onValueChange);
  onChangeRef.current = onValueChange;

  // Sinkronkan bila nilai diubah dari luar (bukan hasil ketikan sendiri).
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    const next = text.trim();
    if (next === lastEmitted.current) return;
    const t = window.setTimeout(() => {
      lastEmitted.current = next;
      onChangeRef.current(next);
    }, delayMs);
    return () => window.clearTimeout(t);
  }, [text, delayMs]);

  return (
    <Field label={label} labelHidden={labelHidden} className={className}>
      {(a11y) => (
        <Input
          {...a11y}
          type="search"
          size="sm"
          value={text}
          maxLength={maxLength}
          placeholder={placeholder}
          autoComplete="off"
          leading={<Search />}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && text !== "") {
              e.preventDefault();
              setText("");
            }
          }}
        />
      )}
    </Field>
  );
}
