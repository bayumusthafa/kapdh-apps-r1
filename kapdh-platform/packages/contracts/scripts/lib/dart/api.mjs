// Pembangkit kelas API Dart: satu kelas per tag, satu method per operasi (N-13).
// Dio diinjeksi dari aplikasi sehingga interceptor auth/refresh aplikasi tetap berlaku (ARCHITECTURE §8.3).
import { HTTP_METHODS } from "../assemble.mjs";
import { dartString, headerParamName, pascalCase, safeMemberName, snakeCase } from "../names.mjs";
import { GENERATED_HEADER } from "./runtime.mjs";
import { doc } from "./model.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const RESERVED_PARAM_NAMES = new Set(["body", "cancelToken", "options", "onSendProgress"]);
const RESERVED_METHOD_NAMES = new Set(["toString", "hashCode", "noSuchMethod", "runtimeType"]);

function resolve(bundle, node) {
  let current = node;
  for (let i = 0; i < 10 && isObject(current) && typeof current.$ref === "string"; i++) {
    const parts = current.$ref.replace(/^#\//, "").split("/");
    current = parts.reduce(
      (acc, key) => (isObject(acc) ? acc[key.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined),
      bundle,
    );
  }
  return current;
}

function isJsonMedia(mediaType) {
  return mediaType === "application/json" || /^application\/[\w.+-]*\+json$/.test(mediaType);
}

/** Nama kelas API dari nama tag: "Admin Payments" -> AdminPaymentsApi. */
export function apiClassName(tag) {
  return `${pascalCase(tag)}Api`;
}

export function apiFileName(tag) {
  return `apis/${snakeCase(tag)}_api.dart`;
}

/**
 * @param {object} bundle
 * @param {import("./model.mjs").ModelRegistry} registry
 */
export function buildApis(bundle, registry) {
  const groups = new Map(); // tag -> { description, operations: [] }
  for (const tag of bundle.tags ?? [])
    groups.set(tag.name, { tag: tag.name, description: tag.description, operations: [] });

  for (const [path, item] of Object.entries(bundle.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item?.[method];
      if (!isObject(op)) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const tags = Array.isArray(op.tags) ? op.tags : [];
      if (tags.length !== 1 || !groups.has(tags[0])) {
        registry.error(`${where}: wajib tepat satu tag yang terdaftar`);
        continue;
      }
      const opId = op.operationId;
      if (typeof opId !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(opId) || RESERVED_METHOD_NAMES.has(opId)) {
        registry.error(`${where}: operationId '${opId}' bukan nama method Dart yang valid`);
        continue;
      }
      groups
        .get(tags[0])
        .operations.push(buildOperation(bundle, registry, { path, method, op, item, where }));
    }
  }
  // Tag tanpa operasi (domain yang path-nya belum ditulis) tidak menghasilkan kelas API kosong.
  return [...groups.values()].filter((g) => g.operations.length > 0);
}

function buildOperation(bundle, registry, { path, method, op, item, where }) {
  const opId = op.operationId;
  const ctx = { source: `operasi ${opId}`, request: false, multipart: false };
  const usedTypes = new Set();
  const track = (type) => {
    if (!type) return type;
    if (["enum", "class", "alias"].includes(type.t)) usedTypes.add(type.name);
    if (type.of) track(type.of);
    return type;
  };

  // Parameter path-item + operasi (operasi menimpa yang sama in+name).
  const merged = new Map();
  for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = resolve(bundle, raw);
    if (!isObject(p)) {
      registry.error(`${where}: parameter tidak dapat diselesaikan`);
      continue;
    }
    merged.set(`${p.in}:${p.name}`, p);
  }
  const params = [];
  const names = new Set();
  for (const p of merged.values()) {
    if (p.in === "cookie") {
      if (p.required) registry.error(`${where}: parameter cookie wajib tidak didukung SDK Dart`);
      continue;
    }
    if (!["path", "query", "header"].includes(p.in)) {
      registry.error(`${where}: parameter ${p.name} di '${p.in}' tidak didukung`);
      continue;
    }
    const dartName = p.in === "header" ? headerParamName(p.name) : safeMemberName(p.name);
    if (names.has(dartName) || RESERVED_PARAM_NAMES.has(dartName)) {
      registry.error(`${where}: nama parameter Dart ${dartName} bentrok`);
    }
    names.add(dartName);
    const type = track(registry.typeRef(p.schema ?? {}, `${pascalCase(opId)}${pascalCase(p.name)}`, ctx));
    if (type.t === "class" || type.t === "map" || type.t === "any" || type.t === "binary") {
      registry.error(`${where}: parameter ${p.name} wajib bertipe primitif, enum atau array primitif`);
    }
    params.push({
      in: p.in,
      name: p.name,
      dartName,
      required: p.in === "path" ? true : p.required === true,
      type,
      description: p.description ?? p.schema?.description,
    });
  }

  // Urutan parameter path mengikuti template.
  const pathParams = [];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const p = params.find((x) => x.in === "path" && x.name === match[1]);
    if (!p) registry.error(`${where}: parameter path {${match[1]}} tidak dideklarasikan`);
    else pathParams.push(p);
  }
  for (const p of params) {
    if (p.in === "path" && !pathParams.includes(p))
      registry.error(`${where}: parameter path ${p.name} tidak ada di template`);
  }

  // Body.
  let body = null;
  const requestBody = resolve(bundle, op.requestBody);
  if (isObject(requestBody)) {
    const content = requestBody.content ?? {};
    const mediaTypes = Object.keys(content);
    const mediaType =
      mediaTypes.find(isJsonMedia) ??
      (mediaTypes.includes("multipart/form-data") ? "multipart/form-data" : null);
    if (!mediaType)
      registry.error(`${where}: media type body ${mediaTypes.join(", ")} tidak didukung SDK Dart`);
    else {
      const type = track(
        registry.typeRef(content[mediaType].schema ?? {}, `${pascalCase(opId)}Request`, ctx),
      );
      if (type.t !== "class") registry.error(`${where}: body wajib $ref ke skema objek bernama`);
      body = {
        kind: mediaType === "multipart/form-data" ? "multipart" : "json",
        type,
        required: requestBody.required === true,
      };
    }
  }

  // Respons sukses.
  const successes = [];
  for (const [status, raw] of Object.entries(op.responses ?? {})) {
    if (!/^2(\d\d|XX)$/.test(status)) continue;
    const response = resolve(bundle, raw);
    const content = isObject(response?.content) ? response.content : {};
    const mediaTypes = Object.keys(content);
    if (mediaTypes.length === 0) {
      successes.push({ status, kind: "none" });
      continue;
    }
    const json = mediaTypes.find(isJsonMedia);
    if (json) {
      const type = track(registry.typeRef(content[json].schema ?? {}, `${pascalCase(opId)}Response`, ctx));
      successes.push({ status, kind: "json", type, key: registry.dartType(type) });
    } else if (mediaTypes[0].startsWith("text/")) {
      successes.push({ status, kind: "text", key: "String" });
    } else {
      successes.push({ status, kind: "bytes", key: "List<int>" });
    }
  }
  if (successes.length === 0) registry.error(`${where}: wajib mendeklarasikan minimal satu respons 2xx`);
  const withBody = successes.filter((s) => s.kind !== "none");
  const distinct = [...new Set(withBody.map((s) => `${s.kind}:${s.key}`))];
  if (distinct.length > 1) {
    registry.error(
      `${where}: respons 2xx dengan skema berbeda (${distinct.join(", ")}) tidak didukung; samakan skemanya`,
    );
  }
  const result = withBody[0] ?? { kind: "none" };
  const resultNullable = withBody.length > 0 && withBody.length < successes.length;

  const security = op.security ?? bundle.security ?? [];
  const authRequired = security.some((req) => isObject(req) && Object.keys(req).includes("bearerAuth"));

  return {
    opId,
    method: method.toUpperCase(),
    path,
    summary: op.summary,
    description: op.description,
    deprecated: op.deprecated === true,
    params,
    pathParams,
    body,
    result,
    resultNullable,
    authRequired,
    usedTypes,
  };
}

function valueExpr(registry, type, v) {
  // Nilai query/header: primitif apa adanya (Dio mengubahnya ke teks), enum ke nilai JSON, waktu ke RFC 3339 UTC.
  switch (type.t) {
    case "string":
    case "int":
    case "double":
    case "bool":
      return v;
    case "enum":
      return `${v}.toJson()`;
    case "datetime":
      return `encodeDateTime(${v})`;
    case "alias":
      return valueExpr(registry, registry.types.get(type.name)?.target ?? { t: "string" }, v);
    case "list": {
      const item = valueExpr(registry, type.of, "e");
      return item === "e" ? v : `[for (final e in ${v}) ${item}]`;
    }
    default:
      return `'$${v}'`;
  }
}

function pathSegmentExpr(registry, p) {
  const base = p.type.t === "alias" ? (registry.types.get(p.type.name)?.target ?? { t: "string" }) : p.type;
  if (base.t === "string") return `\${Uri.encodeComponent(${p.dartName})}`;
  if (base.t === "enum") return `\${Uri.encodeComponent(${p.dartName}.toJson())}`;
  return `\${Uri.encodeComponent('$${p.dartName}')}`;
}

function renderOperation(registry, op) {
  const lines = [];
  const docParts = [op.summary, op.description]
    .filter(Boolean)
    .map((s) => String(s).trim())
    .join("\n\n");
  const paramDocs = op.params
    .filter((p) => p.description)
    .map((p) => `[${p.dartName}]: ${String(p.description).trim()}`);
  const fullDoc = [
    docParts,
    paramDocs.join("\n"),
    `\`${op.method} ${op.path}\` (operationId \`${op.opId}\`).`,
  ]
    .filter(Boolean)
    .join("\n\n");
  lines.push(doc(fullDoc, "  ").trimEnd());
  if (op.deprecated) lines.push("  @Deprecated('Operasi ditandai deprecated di kontrak.')");

  const resultType =
    op.result.kind === "none"
      ? "void"
      : `${op.result.kind === "json" ? registry.dartType(op.result.type) : op.result.key}${op.resultNullable ? "?" : ""}`;

  // Signature: path (posisional), body wajib (posisional), lalu parameter bernama.
  const positional = op.pathParams.map(
    (p) => `${registry.dartType({ ...p.type, nullable: false })} ${p.dartName}`,
  );
  if (op.body?.required) positional.push(`${registry.dartType(op.body.type)} body`);
  const named = [];
  if (op.body && !op.body.required) named.push(`${registry.dartType(op.body.type)}? body`);
  for (const p of op.params.filter((x) => x.in !== "path")) {
    const t = registry.dartType({ ...p.type, nullable: false });
    named.push(p.required ? `required ${t} ${p.dartName}` : `${t}? ${p.dartName}`);
  }
  named.push("CancelToken? cancelToken", "Options? options");
  if (op.body?.kind === "multipart") named.push("ProgressCallback? onSendProgress");

  // Gaya `dart format`: parameter posisional per baris, kurung kurawal bernama menempel pada yang terakhir.
  if (positional.length === 0) lines.push(`  Future<${resultType}> ${op.opId}({`);
  else {
    lines.push(`  Future<${resultType}> ${op.opId}(`);
    positional.forEach((p, i) => lines.push(`    ${p},${i === positional.length - 1 ? " {" : ""}`));
  }
  for (const n of named) lines.push(`    ${n},`);
  lines.push("  }) =>");
  lines.push("      sendRequest(");
  lines.push("        _dio,");
  lines.push(`        operationId: ${dartString(op.opId)},`);
  lines.push(`        method: ${dartString(op.method)},`);
  let pathExpr = op.path.replace(/'/g, "\\'").replace(/\$/g, "\\$");
  for (const p of op.pathParams) {
    const segment = pathSegmentExpr(registry, p);
    pathExpr = pathExpr.replace(`{${p.name}}`, () => segment);
  }
  lines.push(`        path: '${pathExpr}',`);
  lines.push(`        authRequired: ${op.authRequired},`);

  const entries = (location) =>
    op.params
      .filter((p) => p.in === location)
      .map((p) => {
        if (p.required) return `'${p.name}': ${valueExpr(registry, p.type, p.dartName)}`;
        const value = valueExpr(registry, p.type, "v");
        // Elemen null-aware (Dart 3.8) bila nilainya dipakai apa adanya.
        return value === "v"
          ? `'${p.name}': ?${p.dartName}`
          : `if (${p.dartName} case final v?) '${p.name}': ${value}`;
      });
  const query = entries("query");
  if (query.length) {
    lines.push("        queryParameters: <String, Object?>{");
    for (const q of query) lines.push(`          ${q},`);
    lines.push("        },");
  }
  const headers = entries("header");
  if (headers.length) {
    lines.push("        headers: <String, Object?>{");
    for (const h of headers) lines.push(`          ${h},`);
    lines.push("        },");
  }
  if (op.body) {
    const method = op.body.kind === "multipart" ? "toFormData()" : "toJson()";
    lines.push(`        data: body${op.body.required ? "" : "?"}.${method},`);
  }
  if (op.result.kind === "text") lines.push("        responseType: ResponseType.plain,");
  if (op.result.kind === "bytes") lines.push("        responseType: ResponseType.bytes,");

  let decode;
  if (op.result.kind === "none") decode = "(_) {}";
  else {
    const fn =
      op.result.kind === "json"
        ? registry.decodeFn({ ...op.result.type, nullable: false }, 1)
        : op.result.kind === "text"
          ? "decodeString"
          : "decodeBytes";
    decode = op.resultNullable ? `(v0) => v0 == null || v0 == '' ? null : (${fn})(v0)` : fn;
  }
  lines.push(`        decode: ${decode},`);
  lines.push("        cancelToken: cancelToken,");
  lines.push("        options: options,");
  if (op.body?.kind === "multipart") lines.push("        onSendProgress: onSendProgress,");
  lines.push("      );");
  return lines.join("\n");
}

/** Merender satu berkas kelas API untuk satu tag. */
export function renderApiFile(registry, group) {
  const className = apiClassName(group.tag);
  const methods = group.operations.map((op) => renderOperation(registry, op));
  const body = methods.join("\n\n");
  const usesModels = group.operations.some((op) => op.usedTypes.size > 0);
  const usesJson = /\b(decode[A-Z]\w*|encodeDateTime|encodeNullable)\b/.test(body);
  const imports = ["import 'package:dio/dio.dart';", ""];
  if (usesModels) imports.push("import '../models.dart';");
  if (usesJson) imports.push("import '../runtime/json.dart';");
  imports.push("import '../runtime/request.dart';");
  const tagDoc = `${group.description ?? group.tag}\n\nKelas API untuk tag kontrak "${group.tag}". Berikan [Dio] aplikasi (baseUrl berakhiran \`/api/v1\`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].`;
  return `${GENERATED_HEADER}
${imports.join("\n")}

${doc(tagDoc)}class ${className} {
  const ${className}(this._dio);

  final Dio _dio;
${methods.length ? `\n${body}\n` : ""}}
`;
}

/** Kelas agregat yang membuat semua kelas API dari satu Dio (memudahkan provider Riverpod). */
export function renderClientFile(groups) {
  const fields = groups.map((g) => ({ name: safeMemberName(g.tag), cls: apiClassName(g.tag), tag: g.tag }));
  const imports = groups.map((g) => `import '${apiFileName(g.tag)}';`).sort();
  return `${GENERATED_HEADER}
import 'package:dio/dio.dart';

${imports.join("\n")}

/// Semua kelas API kontrak KAPDH dari satu [Dio] aplikasi.
class KapdhApi {
  KapdhApi(Dio dio)
      : ${fields.map((f) => `${f.name} = ${f.cls}(dio)`).join(",\n        ")};

${fields.map((f) => `  /// Tag "${f.tag}".\n  final ${f.cls} ${f.name};`).join("\n\n")}
}
`;
}
