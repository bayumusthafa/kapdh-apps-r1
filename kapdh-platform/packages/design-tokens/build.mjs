#!/usr/bin/env node
// Bangkitkan token KAPDH untuk Tailwind 4 (CSS) dan Flutter (Dart) dari tokens.json.
// Jalankan:  node build.mjs
// Hasil:     css/kapdh-theme.css, flutter/lib/kapdh_tokens.dart
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(readFileSync(join(ROOT, "tokens.json"), "utf8"));

function resolve(v) {
  const m = typeof v === "string" ? /^\{(.+)\}$/.exec(v) : null;
  if (!m) return v;
  let node = T;
  for (const k of m[1].split(".")) node = node[k];
  return resolve(node);
}

function camel(...parts) {
  const words = parts.flatMap((p) => String(p).split(/[-_ ]/)).filter(Boolean);
  const out =
    words[0].toLowerCase() +
    words
      .slice(1)
      .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
      .join("");
  return /^\d/.test(out) ? "n" + out : out;
}

const dartColor = (hex) => `Color(0xFF${hex.replace(/^#/, "").toUpperCase()})`;
const rem = (px) => String(Number((px / 16).toPrecision(4)));

// ---------------- CSS (Tailwind v4 @theme) ----------------
const css = [
  "/* DIBANGKITKAN dari tokens.json oleh build.mjs. Jangan edit manual. */",
  '/* Pakai di apps/admin: @import "tailwindcss"; @import "@kapdh/design-tokens/css/kapdh-theme.css"; */',
  "@theme {",
];
for (const [k, v] of Object.entries(T.color.brand)) css.push(`  --color-${k}: ${v};`);
for (const [k, v] of Object.entries(T.color.neutral)) css.push(`  --color-neutral-${k}: ${v};`);
for (const [k, v] of Object.entries(T.color.semantic)) css.push(`  --color-${k}: ${resolve(v)};`);
for (const [k, v] of Object.entries(T.color.status)) css.push(`  --color-${k}: ${v};`);
css.push(`  --font-heading: ${T.font.family.heading};`);
css.push(`  --font-sans: ${T.font.family.body};`);
css.push(`  --font-mono: ${T.font.family.mono};`);
for (const [k, v] of Object.entries(T.font.size)) css.push(`  --text-${k}: ${rem(v)}rem;`);
for (const [k, v] of Object.entries(T.radius))
  css.push(v < 999 ? `  --radius-${k}: ${v}px;` : `  --radius-${k}: 9999px;`);
for (const [k, v] of Object.entries(T.shadow)) css.push(`  --shadow-${k}: ${v};`);
css.push("}", "", ":root {");
for (const [k, v] of Object.entries(T.gradient)) css.push(`  --gradient-${k}: ${v};`);
css.push("}", "");
css.push("/* Badge status keanggotaan: selalu tampilkan label teks, bukan warna saja (PRD 4.5). */");
for (const [k, v] of Object.entries(T.color.membership)) {
  css.push(`.badge-${k.replaceAll("_", "-")} { color: ${resolve(v.fg)}; background: ${resolve(v.bg)}; }`);
}
css.push(".bg-kta-card { background: var(--gradient-kta-card); }");
css.push(".bg-button-primary { background: var(--gradient-button-primary); }");
css.push(
  ":where(a, button, input, select, textarea, [tabindex]):focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }",
);
mkdirSync(join(ROOT, "css"), { recursive: true });
writeFileSync(join(ROOT, "css", "kapdh-theme.css"), css.join("\n") + "\n");

// ---------------- Dart tokens ----------------
const d = [
  "// DIBANGKITKAN dari tokens.json oleh build.mjs. Jangan edit manual.",
  "// ignore_for_file: constant_identifier_names",
  "import 'package:flutter/painting.dart';",
  "",
  "/// Warna KAPDH dari Guidelines KAPDH Platform v1.0.",
  "abstract final class KapdhColors {",
];
for (const [k, v] of Object.entries(T.color.brand)) d.push(`  static const ${camel(k)} = ${dartColor(v)};`);
for (const [k, v] of Object.entries(T.color.neutral))
  d.push(`  static const ${camel("neutral", k)} = ${dartColor(v)};`);
d.push("");
for (const [k, v] of Object.entries(T.color.semantic))
  d.push(`  static const ${camel(k)} = ${dartColor(resolve(v))};`);
d.push("");
for (const [k, v] of Object.entries(T.color.status)) d.push(`  static const ${camel(k)} = ${dartColor(v)};`);
d.push("}", "");
d.push("/// Gaya badge status keanggotaan; label wajib ditampilkan bersama warna.");
d.push("class KapdhStatusStyle {");
d.push("  const KapdhStatusStyle(this.fg, this.bg, this.label, this.icon);");
d.push("  final Color fg;\n  final Color bg;\n  final String label;\n  final String icon;");
d.push("}", "");
d.push("abstract final class KapdhMembershipStatus {");
for (const [k, v] of Object.entries(T.color.membership)) {
  d.push(
    `  static const ${camel(k)} = KapdhStatusStyle(${dartColor(resolve(v.fg))}, ${dartColor(resolve(v.bg))}, '${v.label}', '${v.icon}');`,
  );
}
d.push("}", "");
d.push("abstract final class KapdhGradients {");
d.push("  static const ktaCard = LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,");
d.push("      colors: [Color(0xFF020702), Color(0xFF0E280C), Color(0xFF215E1E)], stops: [0, 0.45, 1]);");
d.push(
  "  static const buttonPrimary = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,",
);
d.push("      colors: [Color(0xFF215E1E), Color(0xFF1A4B17)]);");
d.push("}", "");
d.push("abstract final class KapdhSpace {");
for (const [k, v] of Object.entries(T.space)) d.push(`  static const double ${camel("s", k)} = ${v};`);
d.push("}", "");
d.push("abstract final class KapdhRadius {");
for (const [k, v] of Object.entries(T.radius)) d.push(`  static const double ${camel(k)} = ${v};`);
d.push("}", "");
d.push("abstract final class KapdhFontSize {");
for (const [k, v] of Object.entries(T.font.size)) d.push(`  static const double ${camel(k)} = ${v};`);
d.push("}", "");
d.push("abstract final class KapdhSize {");
for (const [k, v] of Object.entries(T.size)) d.push(`  static const double ${camel(k)} = ${v};`);
d.push("}");
mkdirSync(join(ROOT, "flutter", "lib"), { recursive: true });
writeFileSync(join(ROOT, "flutter", "lib", "kapdh_tokens.dart"), d.join("\n") + "\n");
console.log("css/kapdh-theme.css dan flutter/lib/kapdh_tokens.dart dibangkitkan");
