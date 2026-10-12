#!/usr/bin/env python3
"""Bangkitkan token KAPDH untuk Tailwind 4 (CSS) dan Flutter (Dart) dari tokens.json.

Jalankan:  python3 build.py
Hasil:     css/kapdh-theme.css, flutter/lib/kapdh_tokens.dart
"""
import json, re, pathlib

ROOT = pathlib.Path(__file__).parent
T = json.loads((ROOT / "tokens.json").read_text())


def resolve(v):
    m = re.fullmatch(r"\{(.+)\}", v) if isinstance(v, str) else None
    if not m:
        return v
    node = T
    for k in m.group(1).split("."):
        node = node[k]
    return resolve(node)


def camel(*parts):
    words = []
    for p in parts:
        words += re.split(r"[-_ ]", str(p))
    words = [w for w in words if w]
    out = words[0].lower() + "".join(w[:1].upper() + w[1:] for w in words[1:])
    return ("n" + out) if out[0].isdigit() else out


def dart_color(hexv):
    return f"Color(0xFF{hexv.lstrip('#').upper()})"


# ---------------- CSS (Tailwind v4 @theme) ----------------
css = ["/* DIBANGKITKAN dari tokens.json oleh build.py. Jangan edit manual. */",
       "/* Pakai di apps/admin: @import \"tailwindcss\"; @import \"@kapdh/design-tokens/css/kapdh-theme.css\"; */",
       "@theme {"]
for k, v in T["color"]["brand"].items():
    css.append(f"  --color-{k}: {v};")
for k, v in T["color"]["neutral"].items():
    css.append(f"  --color-neutral-{k}: {v};")
for k, v in T["color"]["semantic"].items():
    css.append(f"  --color-{k}: {resolve(v)};")
for k, v in T["color"]["status"].items():
    css.append(f"  --color-{k}: {v};")
css.append(f"  --font-heading: {T['font']['family']['heading']};")
css.append(f"  --font-sans: {T['font']['family']['body']};")
css.append(f"  --font-mono: {T['font']['family']['mono']};")
for k, v in T["font"]["size"].items():
    css.append(f"  --text-{k}: {v / 16:.4g}rem;")
for k, v in T["radius"].items():
    css.append(f"  --radius-{k}: {v}px;" if v < 999 else f"  --radius-{k}: 9999px;")
for k, v in T["shadow"].items():
    css.append(f"  --shadow-{k}: {v};")
css.append("}")
css.append("")
css.append(":root {")
for k, v in T["gradient"].items():
    css.append(f"  --gradient-{k}: {v};")
css.append("}")
css.append("")
css.append("/* Badge status keanggotaan: selalu tampilkan label teks, bukan warna saja (PRD 4.5). */")
for k, v in T["color"]["membership"].items():
    css.append(f".badge-{k.replace('_', '-')} {{ color: {resolve(v['fg'])}; background: {resolve(v['bg'])}; }}")
css.append(".bg-kta-card { background: var(--gradient-kta-card); }")
css.append(".bg-button-primary { background: var(--gradient-button-primary); }")
css.append(":where(a, button, input, select, textarea, [tabindex]):focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }")
(ROOT / "css").mkdir(exist_ok=True)
(ROOT / "css" / "kapdh-theme.css").write_text("\n".join(css) + "\n")

# ---------------- Dart tokens ----------------
d = ["// DIBANGKITKAN dari tokens.json oleh build.py. Jangan edit manual.",
     "// ignore_for_file: constant_identifier_names",
     "import 'package:flutter/painting.dart';", "",
     "/// Warna KAPDH dari Guidelines KAPDH Platform v1.0.",
     "abstract final class KapdhColors {"]
for k, v in T["color"]["brand"].items():
    d.append(f"  static const {camel(k)} = {dart_color(v)};")
for k, v in T["color"]["neutral"].items():
    d.append(f"  static const {camel('neutral', k)} = {dart_color(v)};")
d.append("")
for k, v in T["color"]["semantic"].items():
    d.append(f"  static const {camel(k)} = {dart_color(resolve(v))};")
d.append("")
for k, v in T["color"]["status"].items():
    d.append(f"  static const {camel(k)} = {dart_color(v)};")
d.append("}")
d.append("")
d.append("/// Gaya badge status keanggotaan; label wajib ditampilkan bersama warna.")
d.append("class KapdhStatusStyle {")
d.append("  const KapdhStatusStyle(this.fg, this.bg, this.label, this.icon);")
d.append("  final Color fg;\n  final Color bg;\n  final String label;\n  final String icon;")
d.append("}")
d.append("")
d.append("abstract final class KapdhMembershipStatus {")
for k, v in T["color"]["membership"].items():
    d.append(f"  static const {camel(k)} = KapdhStatusStyle({dart_color(resolve(v['fg']))}, {dart_color(resolve(v['bg']))}, '{v['label']}', '{v['icon']}');")
d.append("}")
d.append("")
d.append("abstract final class KapdhGradients {")
d.append("  static const ktaCard = LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,")
d.append("      colors: [Color(0xFF020702), Color(0xFF0E280C), Color(0xFF215E1E)], stops: [0, 0.45, 1]);")
d.append("  static const buttonPrimary = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,")
d.append("      colors: [Color(0xFF215E1E), Color(0xFF1A4B17)]);")
d.append("}")
d.append("")
d.append("abstract final class KapdhSpace {")
for k, v in T["space"].items():
    d.append(f"  static const double {camel('s', k)} = {v};")
d.append("}")
d.append("")
d.append("abstract final class KapdhRadius {")
for k, v in T["radius"].items():
    d.append(f"  static const double {camel(k)} = {v};")
d.append("}")
d.append("")
d.append("abstract final class KapdhFontSize {")
for k, v in T["font"]["size"].items():
    d.append(f"  static const double {camel(k)} = {v};")
d.append("}")
d.append("")
d.append("abstract final class KapdhSize {")
for k, v in T["size"].items():
    d.append(f"  static const double {camel(k)} = {v};")
d.append("}")
(ROOT / "flutter" / "lib").mkdir(parents=True, exist_ok=True)
(ROOT / "flutter" / "lib" / "kapdh_tokens.dart").write_text("\n".join(d) + "\n")
print("css/kapdh-theme.css dan flutter/lib/kapdh_tokens.dart dibangkitkan")
