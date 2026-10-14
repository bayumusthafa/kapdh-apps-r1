// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOtpInput } from "./otp-input";

let boxes: HTMLInputElement[];
let onComplete: ReturnType<typeof vi.fn<(code: string) => void>>;
let otp: ReturnType<typeof createOtpInput>;

function type(box: HTMLInputElement, value: string) {
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

function paste(box: HTMLInputElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  event.clipboardData = { getData: () => text };
  box.dispatchEvent(event);
  return event;
}

function key(box: HTMLInputElement, k: string) {
  box.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  onComplete = vi.fn<(code: string) => void>();
  otp = createOtpInput(document, { legend: "Kode OTP", onComplete });
  document.body.append(otp.element);
  boxes = Array.from(otp.element.querySelectorAll("input"));
});

describe("kotak OTP (prototype screen_1_otp, N-11)", () => {
  it("enam kotak berlabel untuk pembaca layar dengan isi otomatis one-time-code", () => {
    expect(boxes).toHaveLength(6);
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => `Digit ${n} dari 6`),
    );
    expect(boxes[0]!.getAttribute("autocomplete")).toBe("one-time-code");
    expect(boxes[0]!.getAttribute("inputmode")).toBe("numeric");
    expect(otp.element.querySelector("legend")!.textContent).toBe("Kode OTP");
  });

  it("mengetik satu digit berpindah ke kotak berikutnya dan menolak huruf", () => {
    boxes[0]!.focus();
    type(boxes[0]!, "4");
    expect(document.activeElement).toBe(boxes[1]);
    type(boxes[1]!, "a");
    expect(boxes[1]!.value).toBe("");
    expect(otp.value()).toBe("4");
    expect(boxes[0]!.dataset.filled).toBe("true");
  });

  it("menempel kode utuh mengisi semua kotak dan memanggil onComplete", () => {
    const event = paste(boxes[2]!, " 482 913 ");
    expect(event.defaultPrevented).toBe(true);
    expect(otp.value()).toBe("482913");
    expect(onComplete).toHaveBeenCalledWith("482913");
  });

  it("isi otomatis beberapa digit sekaligus disebar mulai kotak itu", () => {
    type(boxes[0]!, "123456");
    expect(otp.value()).toBe("123456");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("Backspace pada kotak kosong menghapus kotak sebelumnya; panah berpindah kotak", () => {
    type(boxes[0]!, "1");
    type(boxes[1]!, "2");
    boxes[2]!.focus();
    key(boxes[2]!, "Backspace");
    expect(boxes[1]!.value).toBe("");
    expect(document.activeElement).toBe(boxes[1]);
    key(boxes[1]!, "ArrowLeft");
    expect(document.activeElement).toBe(boxes[0]);
    key(boxes[0]!, "ArrowRight");
    expect(document.activeElement).toBe(boxes[1]);
  });

  it("clear, focus, disabled dan invalid", () => {
    type(boxes[0]!, "12");
    otp.clear();
    expect(otp.value()).toBe("");
    otp.focus();
    expect(document.activeElement).toBe(boxes[0]);
    otp.setDisabled(true);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    otp.setInvalid(true, "err");
    expect(
      boxes.every(
        (b) => b.getAttribute("aria-invalid") === "true" && b.getAttribute("aria-describedby") === "err",
      ),
    ).toBe(true);
    otp.setInvalid(false);
    expect(boxes.every((b) => !b.hasAttribute("aria-describedby"))).toBe(true);
  });
});
