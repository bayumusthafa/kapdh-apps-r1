// Aturan penamaan identifier Dart untuk generator SDK (ARCHITECTURE §2 butir 8: JSON snake_case, Dart camelCase).

/**
 * Kata tercadang Dart (tidak boleh menjadi nama field/parameter/anggota enum) ditambah await/yield.
 * Identifier bawaan kontekstual seperti `type`, `required`, `get` tetap boleh dipakai sebagai nama field.
 */
export const DART_RESERVED = new Set([
  "assert",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "enum",
  "extends",
  "false",
  "final",
  "finally",
  "for",
  "if",
  "in",
  "is",
  "new",
  "null",
  "rethrow",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** Anggota bawaan objek/enum Dart yang tidak boleh ditimpa oleh field atau anggota enum. */
export const DART_MEMBER_RESERVED = new Set([
  "hashCode",
  "runtimeType",
  "toString",
  "noSuchMethod",
  "toJson",
  "fromJson",
  "toFormData",
  // dipakai di badan operator == dan factory fromJson terbangkit
  "other",
  "identical",
]);

/** Tambahan untuk anggota enum: anggota bawaan enum Dart, field `value`, dan nilai cadangan `unknown`. */
export const DART_ENUM_MEMBER_RESERVED = new Set([
  ...DART_MEMBER_RESERVED,
  "index",
  "name",
  "values",
  "value",
  "unknown",
]);

/**
 * Nama tipe yang bentrok dengan dart:core atau widget/kelas Flutter yang lazim diimpor bersama SDK.
 * Skema kontrak dengan nama ini wajib diberi prefiks domain (ARCHITECTURE §6), kecuali yang dipetakan di
 * TYPE_RENAMES.
 */
export const DART_TYPE_RESERVED = new Set([
  // dart:core
  "Object",
  "Null",
  "Never",
  "Function",
  "Record",
  "Type",
  "Symbol",
  "String",
  "int",
  "double",
  "num",
  "bool",
  "List",
  "Map",
  "Set",
  "Iterable",
  "Iterator",
  "Future",
  "Stream",
  "Duration",
  "DateTime",
  "Uri",
  "Pattern",
  "Match",
  "RegExp",
  "Error",
  "Exception",
  "StackTrace",
  "StringBuffer",
  "Comparable",
  "Enum",
  "Sink",
  "Expando",
  "WeakReference",
  "Finalizer",
  "Invocation",
  "BigInt",
  "Runes",
  "Deprecated",
  "Iterable",
  "MapEntry",
  // Flutter widgets/material/painting/services yang sering diimpor bersama
  "Notification",
  "Banner",
  "Page",
  "Route",
  "Text",
  "Image",
  "Icon",
  "Title",
  "Card",
  "Chip",
  "Badge",
  "Theme",
  "Table",
  "Form",
  "Step",
  "Stepper",
  "Tab",
  "Element",
  "State",
  "Widget",
  "Key",
  "Color",
  "Size",
  "Action",
  "Intent",
  "Actions",
  "Locale",
  "Animation",
  "Gradient",
  "Border",
  "Radius",
  "Offset",
  "Rect",
  "Visibility",
  "Listener",
  "Builder",
  "Dialog",
  "Drawer",
  "Divider",
  "Tooltip",
  "Checkbox",
  "Switch",
  "Slider",
  "Placeholder",
  "Container",
  "Center",
  "Align",
  "Padding",
  "Row",
  "Column",
  "Stack",
  "Expanded",
  "Spacer",
  "Wrap",
  "Flow",
  "Opacity",
  "Transform",
  "Hero",
  "Overlay",
  "Navigator",
  "Material",
  "Scaffold",
  "Semantics",
  "Focus",
  "Shortcuts",
  "Layout",
  "Flex",
  "Axis",
  "Alignment",
  "Brightness",
  "Clip",
  "Shadow",
  "Curve",
  "Tween",
  "Velocity",
  "Localizations",
  "TextStyle",
  "FontWeight",
  "Router",
  "Scrollable",
  "Directionality",
  "Flexible",
  "Positioned",
  "Draggable",
  "Dismissible",
  "Form",
  "Radio",
  "Ink",
  "Feedback",
  "Simulation",
  "Path",
  "Canvas",
  "Paint",
  "Picture",
  "Scene",
  "Shader",
  "Vertices",
  "Codec",
  "FrameInfo",
  "Window",
  "Display",
  "Clipboard",
  "Interval",
  "Threshold",
  "Ticker",
  "Timer",
  "Completer",
  "Zone",
  // nama yang dipakai runtime SDK
  "ApiException",
  "ApiFailureKind",
  "ErrorUi",
  "ErrorUiAction",
  "ClientErrorCode",
  "MemberRoute",
  "Optional",
  "Dio",
  "Options",
  "Response",
  "FormData",
  "MultipartFile",
  "CancelToken",
]);

/** Pemetaan nama skema kontrak ke nama kelas Dart (bentrok dengan dart:core). */
export const TYPE_RENAMES = { Error: "ApiError" };

/** Memecah string menjadi kata: snake_case, kebab-case, titik, spasi, camelCase, PascalCase, UPPER_SNAKE. */
export function words(input) {
  return String(input)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function pascalCase(input) {
  return words(input)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

export function camelCase(input) {
  const p = pascalCase(input);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

export function snakeCase(input) {
  return words(input)
    .map((w) => w.toLowerCase())
    .join("_");
}

/**
 * Nama identifier anggota (field, parameter, anggota enum) yang aman: camelCase, tidak diawali angka,
 * tidak bentrok dengan kata kunci atau anggota bawaan.
 */
export function safeMemberName(raw, reserved = DART_MEMBER_RESERVED) {
  let name = camelCase(raw);
  if (name === "") name = "empty";
  if (/^[0-9]/.test(name)) name = `v${name}`;
  if (DART_RESERVED.has(name) || reserved.has(name)) name = `${name}Value`;
  return name;
}

/** Nama anggota enum Dart yang aman (tidak bentrok dengan index/name/values/value/unknown). */
export function enumMemberName(raw) {
  return safeMemberName(raw, DART_ENUM_MEMBER_RESERVED);
}

/** Nama parameter header Dart: `X-Reauth-Token` -> `reauthToken`, `If-Match` -> `ifMatch`. */
export function headerParamName(header) {
  return safeMemberName(header.replace(/^x-/i, ""));
}

/** Literal string Dart berkutip tunggal yang aman (escape \, ', $, baris baru). */
export function dartString(value) {
  return `'${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("$", "\\$")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}'`;
}

/** Komentar dokumentasi Dart (///) dari teks deskripsi kontrak. */
export function docComment(text, indent = "") {
  if (!text) return "";
  const lines = String(text).trim().split(/\r?\n/);
  return lines.map((l) => `${indent}///${l.trim() ? ` ${l.trimEnd()}` : ""}`).join("\n") + "\n";
}
