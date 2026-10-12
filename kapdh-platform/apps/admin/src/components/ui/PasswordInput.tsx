import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Input, type InputProps } from "./Input";

/**
 * Isian sandi dengan tombol tampilkan/sembunyikan (guidelines hlm. 10). Tombol memakai aria-pressed sehingga
 * pembaca layar tahu statusnya; sandi tidak pernah disimpan di luar state formulir.
 */
export function PasswordInput(props: Omit<InputProps, "type" | "trailing">) {
  const [visible, setVisible] = useState(false);
  return (
    <Input
      {...props}
      type={visible ? "text" : "password"}
      spellCheck={false}
      autoCapitalize="none"
      trailing={
        <button
          type="button"
          aria-label="Tampilkan sandi"
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
          className="inline-flex size-11 items-center justify-center rounded-md text-text-muted hover:bg-neutral-100 hover:text-text"
        >
          {visible ? (
            <EyeOff aria-hidden="true" className="size-5" />
          ) : (
            <Eye aria-hidden="true" className="size-5" />
          )}
        </button>
      }
    />
  );
}
