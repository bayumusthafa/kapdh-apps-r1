import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge perlu mengenal nama token desain KAPDH (@kapdh/design-tokens) agar, misalnya, `text-h1` (ukuran)
 * tidak dianggap bentrok dengan `text-primary` (warna) lalu salah satunya dibuang.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["display", "h1", "h2", "h3", "body-lg", "body", "label", "caption", "overline"],
      radius: ["sm", "md", "lg", "xl", "pill"],
      shadow: ["card", "raised"],
      font: ["heading", "sans", "mono"],
    },
  },
});

/** Gabungkan kelas kondisional dan selesaikan bentrok utilitas Tailwind (kelas terakhir menang). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
