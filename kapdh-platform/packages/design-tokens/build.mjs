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
const own = (o) => Object.entries(o).filter(([k]) => !k.startsWith("$"));
const argbCss = (argb) => {
  const n = parseInt(argb.slice(2), 16);
  const a = ((n >>> 24) & 255) / 255;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Number(a.toFixed(3))})`;
};
const shadowCss = (list) =>
  list.map(([x, y, b, sp, c]) => `${x}px ${y}px ${b}px${sp ? ` ${sp}px` : ""} ${argbCss(c)}`).join(", ");
const shadowDart = (list) =>
  "[" +
  list
    .map(
      ([x, y, b, sp, c]) =>
        `BoxShadow(offset: Offset(${x}, ${y}), blurRadius: ${b}${sp ? `, spreadRadius: ${sp}` : ""}, color: Color(${c}))`,
    )
    .join(", ") +
  "]";

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
for (const [k, v] of own(T.elevation.light)) css.push(`  --elevation-${k}: ${shadowCss(v)};`);
for (const [k, v] of own(T.motion)) css.push(`  --duration-${k}: ${v}ms;`);
for (const [k, v] of own(T.easing)) css.push(`  --ease-${k}: cubic-bezier(${v.join(", ")});`);
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
// Cincin fokus hijau (focus-ring) di permukaan terang; emas (focus-ring-on-dark) di permukaan hijau gelap (WCAG 1.4.11).
css.push('[data-surface="dark"] { --color-focus-ring: var(--color-focus-ring-on-dark); }');
mkdirSync(join(ROOT, "css"), { recursive: true });
writeFileSync(join(ROOT, "css", "kapdh-theme.css"), css.join("\n") + "\n");

// ---------------- Dart tokens ----------------
const d = [
  "// DIBANGKITKAN dari tokens.json oleh build.mjs. Jangan edit manual.",
  "// ignore_for_file: constant_identifier_names",
  "import 'package:flutter/animation.dart';",
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
d.push("/// Palet mode gelap v2 (tokens.json dark). Dipakai KapdhPalette.dark di lib/app/theme.");
d.push("abstract final class KapdhDarkColors {");
for (const [k, v] of own(T.dark)) d.push(`  static const ${camel(k)} = ${dartColor(v)};`);
d.push("}", "");
d.push("abstract final class KapdhGradients {");
d.push("  static const ktaCard = LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,");
d.push("      colors: [Color(0xFF020702), Color(0xFF0E280C), Color(0xFF215E1E)], stops: [0, 0.45, 1]);");
d.push(
  "  static const buttonPrimary = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,",
);
d.push("      colors: [Color(0xFF215E1E), Color(0xFF1A4B17)]);");
d.push(
  "  /// Dasar mesh zamrud (gradient.brand-mesh): diagonal green950 -> green800 -> green700. Cahaya emas dan hijau",
);
d.push("  /// ditumpuk oleh BrandMesh (lib/design/brand_mesh.dart).");
d.push("  static const brandMeshBase = LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,");
d.push("      colors: [Color(0xFF0E280C), Color(0xFF1A4B17), Color(0xFF215E1E)], stops: [0, 0.55, 1]);");
d.push("  static const brandMeshGold = RadialGradient(center: Alignment(0.84, -1), radius: 0.92,");
d.push("      colors: [Color(0x33E6D312), Color(0x00E6D312)]);");
d.push("  static const brandMeshGreen = RadialGradient(center: Alignment(-0.88, 1), radius: 1.1,");
d.push("      colors: [Color(0x573F9A38), Color(0x003F9A38)]);");
d.push("  /// Latar Splash mode terang (gradient.splash).");
d.push("  static const splash = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,");
d.push("      colors: [Color(0xFFFAFAFA), Color(0xFFEEEFED), Color(0xFFE2E4E1)], stops: [0, 0.55, 1]);");
d.push("}", "");
for (const [cls, set] of [
  ["KapdhShadows", T.elevation.light],
  ["KapdhShadowsDark", T.elevation.dark],
]) {
  d.push(`/// Bayangan v2 (elevation.${cls === "KapdhShadows" ? "light" : "dark"}).`);
  d.push(`abstract final class ${cls} {`);
  for (const [k, v] of own(set)) d.push(`  static const ${camel(k)} = <BoxShadow>${shadowDart(v)};`);
  d.push("}", "");
}
d.push("/// Durasi (motion, ms) dan kurva (easing) animasi v2.");
d.push("abstract final class KapdhMotion {");
for (const [k, v] of own(T.motion)) d.push(`  static const ${camel(k)} = Duration(milliseconds: ${v});`);
for (const [k, v] of own(T.easing))
  d.push(`  static const Curve ${camel("ease", k)} = Cubic(${v.join(", ")});`);
d.push("}", "");
d.push("abstract final class KapdhIconSize {");
for (const [k, v] of Object.entries(T.icon)) d.push(`  static const double ${camel(k)} = ${v};`);
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
