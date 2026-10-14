import { el } from "./dom";

/**
 * Enam kotak OTP (prototype screen_1_otp: 56 px, garis hijau bila terisi, emas pada fokus). Mendukung tempel kode
 * utuh, isi otomatis `one-time-code`, Backspace ke kotak sebelumnya, dan panah kiri/kanan. Setiap kotak berlabel
 * "Digit n dari 6" untuk pembaca layar (N-11).
 */
export interface OtpInput {
  element: HTMLFieldSetElement;
  value(): string;
  clear(): void;
  focus(): void;
  setDisabled(disabled: boolean): void;
  setInvalid(invalid: boolean, describedBy?: string): void;
}

export function createOtpInput(
  doc: Document,
  options: { length?: number; legend: string; onComplete?: (code: string) => void },
): OtpInput {
  const length = options.length ?? 6;
  const boxes: HTMLInputElement[] = [];
  const grid = el(doc, "div", { class: "grid grid-cols-6 gap-2" });
  for (let i = 0; i < length; i += 1) {
    const box = el(doc, "input", {
      class: "otp-box",
      attrs: {
        type: "text",
        inputmode: "numeric",
        autocomplete: i === 0 ? "one-time-code" : "off",
        pattern: "[0-9]*",
        "aria-label": `Digit ${i + 1} dari ${length}`,
        "data-otp-index": String(i),
      },
    });
    boxes.push(box);
    grid.append(box);
  }
  const element = el(doc, "fieldset", { class: "flex flex-col gap-2.5" }, [
    el(doc, "legend", { class: "mb-2.5 text-sm font-medium", text: options.legend }),
    grid,
  ]);

  const value = () => boxes.map((b) => b.value).join("");
  const sync = () => {
    for (const b of boxes) b.dataset.filled = b.value ? "true" : "false";
  };
  const maybeComplete = () => {
    const code = value();
    if (code.length === length && /^[0-9]+$/.test(code)) options.onComplete?.(code);
  };

  /** Menyebar digit mulai kotak `start` (tempel atau isi otomatis); karakter selain angka diabaikan. */
  const distribute = (start: number, text: string) => {
    const digits = text.replace(/[^0-9]/g, "").slice(0, length - start);
    if (!digits) return false;
    for (let k = 0; k < digits.length; k += 1) boxes[start + k]!.value = digits[k]!;
    sync();
    boxes[Math.min(start + digits.length, length - 1)]!.focus();
    maybeComplete();
    return true;
  };

  boxes.forEach((box, i) => {
    box.addEventListener("input", () => {
      const raw = box.value;
      box.value = "";
      if (!distribute(i, raw)) sync();
    });
    box.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text") ?? "";
      event.preventDefault();
      distribute(text.replace(/[^0-9]/g, "").length >= length ? 0 : i, text);
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !box.value && i > 0) {
        event.preventDefault();
        const prev = boxes[i - 1]!;
        prev.value = "";
        sync();
        prev.focus();
      } else if (event.key === "ArrowLeft" && i > 0) {
        event.preventDefault();
        boxes[i - 1]!.focus();
      } else if (event.key === "ArrowRight" && i < length - 1) {
        event.preventDefault();
        boxes[i + 1]!.focus();
      }
    });
    box.addEventListener("focus", () => box.select());
  });
  sync();

  return {
    element,
    value,
    clear: () => {
      for (const b of boxes) b.value = "";
      sync();
    },
    focus: () => {
      const firstEmpty = boxes.find((b) => !b.value) ?? boxes[0]!;
      firstEmpty.focus();
    },
    setDisabled: (disabled) => {
      for (const b of boxes) b.disabled = disabled;
    },
    setInvalid: (invalid, describedBy) => {
      for (const b of boxes) {
        b.setAttribute("aria-invalid", invalid ? "true" : "false");
        if (invalid && describedBy) b.setAttribute("aria-describedby", describedBy);
        else b.removeAttribute("aria-describedby");
      }
    },
  };
}
