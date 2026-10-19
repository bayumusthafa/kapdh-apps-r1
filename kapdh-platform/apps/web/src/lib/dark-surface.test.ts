import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Cincin fokus (N-11, WCAG 1.4.11 >= 3:1): token v2 memakai hijau #2D7A28 di permukaan terang, yang hanya ~2,96:1 di
 * atas #0E280C. Token menukar ke emas lewat `[data-surface="dark"]`, jadi setiap wadah bg-surface-dark wajib
 * membawa atribut itu agar tautan dan tombol di dalamnya tetap terlihat saat difokus keyboard.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const astroFiles = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) =>
  f.endsWith(".astro"),
);

function darkTagsWithoutSurface(source: string): string[] {
  return [...source.matchAll(/<[a-z][\w-]*\b[^>]*\bbg-surface-dark\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => !/\sdata-surface="dark"/.test(tag));
}

describe("permukaan gelap", () => {
  it("token menukar cincin fokus ke emas di bawah data-surface=dark", () => {
    const theme = readFileSync(
      fileURLToPath(new URL("../../../../packages/design-tokens/css/kapdh-theme.css", import.meta.url)),
      "utf8",
    );
    expect(theme).toContain('[data-surface="dark"] { --color-focus-ring: var(--color-focus-ring-on-dark); }');
  });

  it("setiap wadah bg-surface-dark memakai data-surface=dark", () => {
    expect(astroFiles.length).toBeGreaterThan(0);
    const missing = astroFiles.flatMap((file) =>
      darkTagsWithoutSurface(readFileSync(`${SRC}/${file}`, "utf8")).map((tag) => `${file}: ${tag}`),
    );
    expect(missing).toEqual([]);
  });
});
