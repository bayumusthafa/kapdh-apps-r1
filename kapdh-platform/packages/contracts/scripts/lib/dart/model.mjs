// Registri tipe dan pembangkit model Dart dari skema OpenAPI 3.1 / JSON Schema 2020-12 (N-13).
//
// Pemetaan:
// - string -> String (Money/uuid/email/uri tetap String; Money tidak pernah double, ARCHITECTURE §2 butir 5),
//   format date-time -> DateTime, format binary -> MultipartFile (hanya multipart/form-data);
// - integer -> int, number -> double, boolean -> bool, array -> List<T>, additionalProperties -> Map<String, T>,
//   objek tanpa properti -> Map<String, Object?>, skema tanpa tipe -> Object?;
// - `type: [X, "null"]` dan `oneOf/anyOf: [{$ref}, {type: "null"}]` -> nullable;
// - enum string -> enum Dart dengan nilai cadangan `unknown` (kompatibilitas maju); enum inline nullable ditulis
//   `type: [string, "null"]` DENGAN `null` di daftar `enum` (JSON Schema 2020-12 menolak null yang tidak ada di enum);
// - allOf -> kelas dengan field gabungan yang `implements` kelas induk ($ref);
// - field opsional sekaligus nullable (atau bertipe bebas `{}`) pada skema body request -> Optional<T?> (tiga
//   keadaan, untuk PATCH);
// - field biner multipart -> MultipartFile yang DIKLON setiap kali body dibentuk (stream berkas hanya dapat dibaca
//   sekali; request yang sama dapat dikirim ulang, PRD 4.3).
// Konstruksi lain (oneOf/anyOf polimorfik, discriminator, enum non-string) ditolak dengan pesan jelas.
import { isDeepStrictEqual } from "node:util";
import {
  DART_TYPE_RESERVED,
  TYPE_RENAMES,
  camelCase,
  dartString,
  docComment,
  pascalCase,
  enumMemberName,
  safeMemberName,
} from "../names.mjs";

const SCHEMA_REF = "#/components/schemas/";
const SENSITIVE_NAME = /(^|_)(password|token|secret)(_|$)|^(totp_code|backup_code)$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Mengganti pola mirip tag HTML (`<rute>`) di luar code span agar dokumentasi tidak dianggap HTML
 * (lint unintended_html_in_doc_comment); perbandingan seperti `<= 5 MB` dibiarkan.
 */
function sanitizeDoc(text) {
  if (!text) return text;
  return String(text)
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith("`") ? part : part.replace(/<([A-Za-z/][^<>]*)>/g, "‹$1›")))
    .join("");
}

export function doc(text, indent = "") {
  return docComment(sanitizeDoc(text), indent);
}

/**
 * Bagian non-null dari skema nullable (`type: [X, "null"]` atau oneOf/anyOf dengan `{type: "null"}`).
 * `via` mencatat bentuk nullable-nya: "type" (`type: [X, "null"]`), "union" (oneOf/anyOf), atau "keyword"
 * (`nullable: true` gaya OAS 3.0).
 */
export function splitNullable(schema) {
  if (!isObject(schema)) return { schema, nullable: false };
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    const rest = schema.type.filter((t) => t !== "null");
    return { schema: { ...schema, type: rest.length === 1 ? rest[0] : rest }, nullable: true, via: "type" };
  }
  if (schema.nullable === true) return { schema: omit(schema, ["nullable"]), nullable: true, via: "keyword" };
  for (const key of ["oneOf", "anyOf"]) {
    const list = schema[key];
    if (Array.isArray(list) && list.length === 2) {
      const nullIdx = list.findIndex((s) => isObject(s) && s.type === "null");
      if (nullIdx >= 0)
        return { schema: { ...omit(schema, [key]), ...list[1 - nullIdx] }, nullable: true, via: "union" };
    }
  }
  return { schema, nullable: false };
}

/** Salinan objek tanpa kunci tertentu. */
export function omit(obj, keys) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

export class ModelRegistry {
  /**
   * @param {object} bundle dokumen OpenAPI tergabung.
   * @param {{ extraSchemas?: Record<string, object> }} [options] skema tambahan di luar kontrak HTTP
   *   (mis. amplop realtime dari events/envelope.schema.json), diperlakukan seperti components.schemas.
   */
  constructor(bundle, { extraSchemas = {} } = {}) {
    this.bundle = bundle;
    this.errors = [];
    // Skema tambahan berbagi models.dart dengan components.schemas: nama ganda akan saling menimpa.
    for (const name of Object.keys(extraSchemas)) {
      if (Object.hasOwn(bundle.components?.schemas ?? {}, name))
        this.errors.push(
          `skema event ${name}: nama (title) bentrok dengan components.schemas kontrak HTTP; beri nama lain`,
        );
    }
    this.schemas = { ...(bundle.components?.schemas ?? {}), ...extraSchemas };
    /** @type {Map<string, object>} dartName -> TypeDef */
    this.types = new Map();
    /** @type {Map<string, string>} nama skema -> nama Dart */
    this.dartNames = new Map();
    this.building = new Set();
    this.requestReachable = new Set();
    this.multipartSchemas = new Set();

    for (const name of Object.keys(this.schemas).sort()) {
      const dartName = TYPE_RENAMES[name] ?? name;
      if (!/^[A-Z][A-Za-z0-9]*$/.test(dartName)) this.errors.push(`skema ${name}: nama wajib PascalCase`);
      if (DART_TYPE_RESERVED.has(dartName))
        this.errors.push(
          `skema ${name}: nama bentrok dengan tipe Dart/Flutter bawaan; beri prefiks domain (ARCHITECTURE §6)`,
        );
      this.dartNames.set(name, dartName);
    }
    this.#markRequestReachable();
  }

  /** Membangun semua skema komponen. */
  buildAll() {
    for (const name of [...this.dartNames.keys()]) this.component(name);
    return this;
  }

  error(message) {
    this.errors.push(message);
  }

  // ------------------------------------------------------------------ jangkauan body request

  #markRequestReachable() {
    for (const item of Object.values(this.bundle.paths ?? {})) {
      for (const op of Object.values(item ?? {})) {
        const content = this.#resolve(op?.requestBody)?.content;
        if (!isObject(content)) continue;
        for (const [mediaType, media] of Object.entries(content)) {
          const ref = media?.schema?.$ref;
          if (typeof ref === "string" && ref.startsWith(SCHEMA_REF)) {
            const name = ref.slice(SCHEMA_REF.length);
            if (mediaType === "multipart/form-data") this.multipartSchemas.add(name);
          }
          this.#walkReachable(media?.schema);
        }
      }
    }
  }

  #walkReachable(schema) {
    if (!isObject(schema)) return;
    if (typeof schema.$ref === "string" && schema.$ref.startsWith(SCHEMA_REF)) {
      const name = schema.$ref.slice(SCHEMA_REF.length);
      if (this.requestReachable.has(name)) return;
      this.requestReachable.add(name);
      this.#walkReachable(this.schemas[name]);
      return;
    }
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) value.forEach((v) => this.#walkReachable(v));
      else if (isObject(value)) this.#walkReachable(value);
    }
  }

  #resolve(node) {
    let current = node;
    for (let i = 0; i < 10 && isObject(current) && typeof current.$ref === "string"; i++) {
      const parts = current.$ref.replace(/^#\//, "").split("/");
      current = parts.reduce(
        (acc, key) => (isObject(acc) ? acc[key.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined),
        this.bundle,
      );
    }
    return current;
  }

  // ------------------------------------------------------------------ definisi tipe

  /** Mengembalikan TypeDef komponen (membangun bila belum). */
  component(name) {
    const dartName = this.dartNames.get(name);
    if (!dartName) {
      this.error(`$ref ke skema yang tidak ada: ${name}`);
      return undefined;
    }
    if (this.types.has(dartName)) return this.types.get(dartName);
    if (this.building.has(name)) return { kind: "pending", name: dartName };
    this.building.add(name);
    const def = this.#define(dartName, this.schemas[name], {
      request: this.requestReachable.has(name),
      multipart: this.multipartSchemas.has(name),
      source: `skema ${name}`,
    });
    this.building.delete(name);
    return def;
  }

  #register(def) {
    const existing = this.types.get(def.name);
    if (existing) {
      if (!isDeepStrictEqual(existing.schema, def.schema)) {
        this.error(`${def.source}: nama tipe Dart ${def.name} sudah dipakai oleh ${existing.source}`);
      }
      return existing;
    }
    // Tipe inline (enum/objek tanpa nama komponen) tidak boleh memakai nama tipe bawaan atau nama komponen.
    if (def.inline) {
      if (DART_TYPE_RESERVED.has(def.name)) {
        this.error(
          `${def.source}: nama tipe ${def.name} bentrok dengan tipe Dart/Flutter bawaan; beri judul (title) lain`,
        );
      }
      if ([...this.dartNames.values()].includes(def.name)) {
        this.error(
          `${def.source}: nama tipe inline ${def.name} bentrok dengan skema komponen; beri judul (title) lain`,
        );
      }
    }
    this.types.set(def.name, def);
    return def;
  }

  #define(dartName, rawSchema, ctx) {
    const { schema, nullable } = splitNullable(rawSchema);
    if (nullable)
      this.error(`${ctx.source}: skema komponen tidak boleh nullable; buat nullable di titik pemakaian`);
    if (!isObject(schema)) {
      this.error(`${ctx.source}: skema harus objek`);
      return this.#register({
        kind: "alias",
        name: dartName,
        target: { t: "any" },
        schema,
        source: ctx.source,
      });
    }
    if (schema.discriminator || Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
      this.error(
        `${ctx.source}: oneOf/anyOf polimorfik dan discriminator tidak didukung generator Dart; ` +
          "gunakan objek dengan field opsional atau allOf",
      );
    }
    if (Array.isArray(schema.enum)) return this.#defineEnum(dartName, schema, ctx);
    if (this.#isClassSchema(schema)) return this.#defineClass(dartName, schema, ctx);
    // Alias primitif/list/map (mis. Money = String, ClassLevel = int).
    const placeholder = {
      kind: "alias",
      name: dartName,
      target: { t: "any" },
      schema,
      source: ctx.source,
      description: schema.description,
    };
    this.types.set(dartName, placeholder);
    placeholder.target = this.typeRef(schema, `${dartName}Item`, ctx, { allowInlineClass: false });
    return placeholder;
  }

  #isClassSchema(schema) {
    return Array.isArray(schema.allOf) || isObject(schema.properties);
  }

  #defineEnum(dartName, schema, ctx) {
    if (schema.type !== undefined && schema.type !== "string") {
      this.error(`${ctx.source}: hanya enum string yang didukung (ditemukan ${JSON.stringify(schema.type)})`);
    }
    const members = [];
    const seen = new Set();
    for (const value of schema.enum) {
      if (value === null) {
        this.error(
          `${ctx.source}: null di enum hanya boleh pada enum inline nullable \`type: [string, "null"]\`; ` +
            'skema komponen tidak boleh nullable (pakai `oneOf: [{ $ref }, { type: "null" }]` di titik pemakaian)',
        );
        continue;
      }
      if (typeof value !== "string") {
        this.error(`${ctx.source}: nilai enum wajib string (ditemukan ${JSON.stringify(value)})`);
        continue;
      }
      const name = enumMemberName(value);
      if (seen.has(name))
        this.error(`${ctx.source}: nilai enum '${value}' menghasilkan nama Dart ganda ${name}`);
      seen.add(name);
      members.push({ name, value });
    }
    return this.#register({
      kind: "enum",
      name: dartName,
      members,
      description: schema.description,
      schema,
      source: ctx.source,
      inline: ctx.inline === true,
    });
  }

  #defineClass(dartName, schema, ctx) {
    const def = {
      kind: "class",
      name: dartName,
      fields: [],
      implements: [],
      description: schema.description,
      multipart: ctx.multipart,
      request: ctx.request,
      schema,
      source: ctx.source,
      inline: ctx.inline === true,
    };
    const registered = this.#register(def);
    if (registered !== def) return registered;
    // Field turunan (allOf $ref) memakai ulang tipe induk agar `implements` tetap kompatibel; properti milik
    // skema ini sendiri menimpa field turunan bernama sama.
    const fields = new Map();
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const addProps = (props) => {
      for (const [jsonName, propSchema] of Object.entries(props ?? {})) {
        const prev = fields.get(jsonName);
        if (prev?.own && !isDeepStrictEqual(prev.rawSchema, propSchema)) {
          this.error(`${ctx.source}: properti ${jsonName} didefinisikan ganda dengan skema berbeda`);
          continue;
        }
        fields.set(jsonName, { jsonName, rawSchema: propSchema, own: true });
      }
    };
    for (const member of schema.allOf ?? []) {
      if (isObject(member) && typeof member.$ref === "string") {
        if (!member.$ref.startsWith(SCHEMA_REF)) {
          this.error(`${ctx.source}: allOf $ref harus ke components.schemas`);
          continue;
        }
        const baseName = member.$ref.slice(SCHEMA_REF.length);
        const base = this.component(baseName);
        if (!base || base.kind !== "class") {
          this.error(`${ctx.source}: allOf hanya boleh merujuk skema objek (${baseName} bukan objek)`);
          continue;
        }
        def.implements.push(base.name);
        for (const f of base.fields) {
          fields.set(f.jsonName, { jsonName: f.jsonName, rawSchema: f.rawSchema, own: false, inherited: f });
          if (f.required) required.add(f.jsonName);
        }
      } else if (isObject(member)) {
        if (member.allOf || member.oneOf || member.anyOf)
          this.error(`${ctx.source}: allOf bersarang tidak didukung`);
        addProps(member.properties);
        for (const r of member.required ?? []) required.add(r);
      }
    }
    addProps(schema.properties);

    const dartFieldNames = new Set();
    for (const { jsonName, rawSchema, inherited } of fields.values()) {
      const {
        schema: propSchema,
        nullable,
        via,
      } = inherited
        ? { schema: splitNullable(rawSchema).schema, nullable: inherited.nullable }
        : splitNullable(rawSchema);
      const fieldName = safeMemberName(jsonName);
      if (dartFieldNames.has(fieldName))
        this.error(`${ctx.source}: properti ${jsonName} menghasilkan field Dart ganda ${fieldName}`);
      dartFieldNames.add(fieldName);
      const type =
        inherited?.type ??
        this.typeRef(
          propSchema,
          `${dartName}${pascalCase(jsonName)}`,
          { ...ctx, source: `${ctx.source}.${jsonName}` },
          // Nullability field dicatat di tingkat field; bentuknya diteruskan untuk pemeriksaan enum nullable.
          { nullableVia: via },
        );
      const isRequired = required.has(jsonName);
      const field = {
        jsonName,
        name: fieldName,
        type,
        nullable,
        required: isRequired,
        // Opsional + nullable pada body request: tiga keadaan agar null (kosongkan) dapat dibedakan dari tidak
        // dikirim. Skema bebas `{}` juga menerima null, sehingga diperlakukan sama.
        triState: !isRequired && (nullable || type.t === "any") && ctx.request && !ctx.multipart,
        sensitive:
          SENSITIVE_NAME.test(jsonName) ||
          rawSchema?.["x-sensitive"] === true ||
          propSchema?.format === "password" ||
          propSchema?.writeOnly === true,
        description: rawSchema?.description ?? propSchema?.description,
        rawSchema,
      };
      if (type.t === "binary" && !ctx.multipart) {
        this.error(`${ctx.source}.${jsonName}: format binary hanya didukung pada body multipart/form-data`);
      }
      def.fields.push(field);
    }
    for (const r of required) {
      if (!fields.has(r)) this.error(`${ctx.source}: required '${r}' tidak ada di properties`);
    }
    if (ctx.multipart) {
      for (const f of def.fields) {
        const base = this.#unalias(f.type);
        if (
          !["string", "int", "double", "bool", "datetime", "enum", "binary"].includes(base.t) &&
          base.t !== "list"
        ) {
          this.error(
            `${ctx.source}.${f.jsonName}: field multipart hanya boleh primitif, enum, list primitif atau binary`,
          );
        }
      }
    }
    return def;
  }

  #unalias(type) {
    let t = type;
    for (let i = 0; i < 10 && t.t === "alias"; i++) t = this.types.get(t.name)?.target ?? { t: "any" };
    return t;
  }

  /**
   * Referensi tipe untuk skema inline/ref. `contextName` dipakai untuk menamai enum/objek inline
   * (bisa ditimpa `title` pada skema).
   */
  typeRef(rawSchema, contextName, ctx, { allowInlineClass = true, nullableVia } = {}) {
    const { schema, nullable, via: ownVia } = splitNullable(rawSchema);
    // Bentuk nullable skema asli: milik skema ini, atau dari field pemanggil yang sudah memisahkan nullable.
    const via = ownVia ?? nullableVia;
    const wrap = (ref) => (nullable ? { ...ref, nullable: true } : ref);
    if (!isObject(schema) || Object.keys(schema).length === 0) return wrap({ t: "any" });
    if (typeof schema.$ref === "string") {
      if (!schema.$ref.startsWith(SCHEMA_REF)) {
        this.error(`${ctx.source}: $ref '${schema.$ref}' harus ke components.schemas`);
        return wrap({ t: "any" });
      }
      const target = this.component(schema.$ref.slice(SCHEMA_REF.length));
      if (!target) return wrap({ t: "any" });
      const kind = target.kind === "pending" ? "class" : target.kind;
      return wrap({ t: kind, name: target.name });
    }
    if (Array.isArray(schema.allOf) && schema.allOf.length === 1 && !schema.properties) {
      return wrap(this.typeRef(schema.allOf[0], contextName, ctx, { allowInlineClass }));
    }
    const name =
      typeof schema.title === "string" && /^[A-Z][A-Za-z0-9]*$/.test(schema.title)
        ? schema.title
        : contextName;
    if (Array.isArray(schema.enum)) {
      const source = `${ctx.source} (enum inline ${name})`;
      const hasNull = schema.enum.includes(null);
      // JSON Schema 2020-12 (dipakai Ajv di expectOperation): `type: [string, "null"]` + `enum` tanpa null tetap
      // menolak null, sehingga nilai null dari API gagal uji kontrak. Bentuk yang benar memuat null di enum.
      if (via === "type" && !hasNull) {
        this.error(
          `${source}: enum nullable \`type: [string, "null"]\` wajib memuat null di daftar enum ` +
            "(mis. `enum: [open, closed, null]`); tanpa itu nilai null ditolak validator JSON Schema",
        );
      }
      if (hasNull && !via) {
        this.error(`${source}: null di enum wajib disertai \`type: [string, "null"]\``);
      }
      const members = hasNull ? { ...schema, enum: schema.enum.filter((v) => v !== null) } : schema;
      const def = this.#defineEnum(name, members, { ...ctx, inline: true, source });
      return wrap({ t: "enum", name: def.name });
    }
    if (schema.oneOf || schema.anyOf || schema.discriminator) {
      this.error(`${ctx.source}: oneOf/anyOf selain pola nullable tidak didukung generator Dart`);
      return wrap({ t: "any" });
    }
    const type = Array.isArray(schema.type)
      ? schema.type.length === 1
        ? schema.type[0]
        : null
      : schema.type;
    if (Array.isArray(schema.type) && type === null) {
      this.error(`${ctx.source}: union tipe ${JSON.stringify(schema.type)} tidak didukung`);
      return wrap({ t: "any" });
    }
    const effective =
      type ??
      (schema.const !== undefined ? typeof schema.const : undefined) ??
      (schema.properties || schema.allOf ? "object" : undefined);
    switch (effective) {
      case "string":
        if (schema.format === "date-time") return wrap({ t: "datetime" });
        if (schema.format === "binary") return wrap({ t: "binary" });
        return wrap({ t: "string" });
      case "integer":
        return wrap({ t: "int" });
      case "number":
        return wrap({ t: Number.isInteger(schema.const) && type === undefined ? "int" : "double" });
      case "boolean":
        return wrap({ t: "bool" });
      case "array":
        return wrap({ t: "list", of: this.typeRef(schema.items ?? {}, `${contextName}Item`, ctx) });
      case "object": {
        if (isObject(schema.properties) || Array.isArray(schema.allOf)) {
          if (!allowInlineClass) this.error(`${ctx.source}: objek inline tidak boleh di alias`);
          const def = this.#defineClass(name, schema, {
            ...ctx,
            inline: true,
            source: `${ctx.source} (objek inline ${name})`,
          });
          return wrap({ t: "class", name: def.name });
        }
        if (isObject(schema.additionalProperties)) {
          return wrap({
            t: "map",
            of: this.typeRef(schema.additionalProperties, `${contextName}Value`, ctx),
          });
        }
        return wrap({ t: "map", of: { t: "any" } });
      }
      case "null":
        return { t: "any" };
      default:
        return wrap({ t: "any" });
    }
  }

  // ------------------------------------------------------------------ ekspresi Dart

  dartType(type) {
    const base = (() => {
      switch (type.t) {
        case "string":
          return "String";
        case "int":
          return "int";
        case "double":
          return "double";
        case "bool":
          return "bool";
        case "datetime":
          return "DateTime";
        case "binary":
          return "MultipartFile";
        case "any":
          return "Object?";
        case "list":
          return `List<${this.dartType(type.of)}>`;
        case "map":
          return `Map<String, ${this.dartType(type.of)}>`;
        default:
          return type.name;
      }
    })();
    return type.nullable && !base.endsWith("?") ? `${base}?` : base;
  }

  /** Nama fungsi dekode untuk tipe primitif, atau null bila tipe butuh ekspresi. */
  #primitiveDecoder(type) {
    switch (type.t) {
      case "string":
        return "decodeString";
      case "int":
        return "decodeInt";
      case "double":
        return "decodeDouble";
      case "bool":
        return "decodeBool";
      case "datetime":
        return "decodeDateTime";
      case "any":
        return "decodeAny";
      case "binary":
        return "decodeBytes";
      default:
        return null;
    }
  }

  /**
   * Ekspresi fungsi `T Function(Object?)` yang mendekode nilai JSON (null ditolak kecuali tipe nullable).
   * Parameter closure selalu bertipe eksplisit `Object?` agar tetap lolos `strict-inference` di posisi mana pun
   * (termasuk closure yang langsung dipanggil tanpa tipe konteks).
   */
  decodeFn(type, depth = 0) {
    if (!type.nullable) {
      if (type.t === "alias") return this.decodeFn(this.types.get(type.name)?.target ?? { t: "any" }, depth);
      const primitive = this.#primitiveDecoder(type);
      if (primitive) return primitive;
    }
    return `(Object? v${depth}) => ${this.decodeExpr(type, `v${depth}`, depth)}`;
  }

  /** Ekspresi Dart yang mendekode nilai JSON `expr` (bertipe Object?) menjadi `type`. */
  decodeExpr(type, expr, depth = 0) {
    if (type.nullable) {
      const inner = { ...type, nullable: false };
      return `decodeNullable(${expr}, ${this.decodeFn(inner, depth + 1)})`;
    }
    const primitive = this.#primitiveDecoder(type);
    if (primitive) return `${primitive}(${expr})`;
    switch (type.t) {
      case "enum":
        return `${type.name}.fromJson(decodeString(${expr}))`;
      case "class":
        return `${type.name}.fromJson(decodeObject(${expr}))`;
      case "alias":
        return this.decodeExpr(this.types.get(type.name)?.target ?? { t: "any" }, expr, depth);
      case "list":
        return `decodeList(${expr}, ${this.decodeFn(type.of, depth + 1)})`;
      case "map":
        return `decodeMap(${expr}, ${this.decodeFn(type.of, depth + 1)})`;
      default:
        return `decodeAny(${expr})`;
    }
  }

  isIdentityEncode(type) {
    switch (type.t) {
      case "string":
      case "int":
      case "double":
      case "bool":
      case "any":
      case "binary":
        return true;
      case "alias":
        return this.isIdentityEncode(this.types.get(type.name)?.target ?? { t: "any" });
      case "list":
      case "map":
        return this.isIdentityEncode(type.of);
      default:
        return false;
    }
  }

  /** Ekspresi Dart yang mengodekan nilai non-null `expr` bertipe `type` ke nilai JSON. */
  encodeExpr(type, expr, depth = 0) {
    if (this.isIdentityEncode(type)) return expr;
    const element = (inner, e) => {
      if (this.isIdentityEncode(inner)) return e;
      const { nullable, ...nonNull } = inner;
      const enc = this.encodeExpr(nonNull, e, depth + 1);
      if (!nullable) return enc;
      // Pemanggilan method pada elemen nullable memakai `?.` (lint prefer_null_aware_operators).
      if (enc === `${e}.toJson()`) return `${e}?.toJson()`;
      return `${e} == null ? null : ${enc}`;
    };
    switch (type.t) {
      case "datetime":
        return `encodeDateTime(${expr})`;
      case "enum":
      case "class":
        return `${expr}.toJson()`;
      case "alias":
        return this.encodeExpr(this.types.get(type.name)?.target ?? { t: "any" }, expr, depth);
      case "list":
        return `[for (final e${depth} in ${expr}) ${element(type.of, `e${depth}`)}]`;
      case "map":
        return `{for (final e${depth} in ${expr}.entries) e${depth}.key: ${element(type.of, `e${depth}.value`)}}`;
      default:
        return expr;
    }
  }

  /** Apakah kesamaan butuh deepEquals (list/map/nilai bebas). */
  needsDeepEquals(type) {
    const t = this.#unalias(type);
    return t.t === "list" || t.t === "map" || t.t === "any";
  }

  // ------------------------------------------------------------------ keluaran

  /** Mengecek kompatibilitas `implements`: field induk harus ada di anak dengan tipe sama/lebih sempit. */
  #compatibleImplements(def) {
    return def.implements.filter((baseName) => {
      const base = this.types.get(baseName);
      if (!base || base.kind !== "class") return false;
      return base.fields.every((bf) => {
        const cf = def.fields.find((f) => f.jsonName === bf.jsonName);
        if (!cf) return false;
        if (this.dartType(cf.type) !== this.dartType(bf.type)) return false;
        if (cf.triState !== bf.triState) return false;
        return this.#fieldNullable(bf) || !this.#fieldNullable(cf);
      });
    });
  }

  #fieldNullable(f) {
    return !f.required || f.nullable;
  }

  fieldDartType(f) {
    const base = this.dartType({ ...f.type, nullable: false });
    if (f.triState) return `Optional<${base.endsWith("?") ? base : `${base}?`}>`;
    if (f.type.t === "any") return "Object?";
    return this.#fieldNullable(f) ? `${base}?` : base;
  }

  renderEnum(def) {
    const lines = [];
    lines.push(doc(def.description ?? `Nilai enum ${def.name} dari kontrak.`).trimEnd());
    lines.push(`enum ${def.name} {`);
    for (const m of def.members) lines.push(`  ${m.name}(${dartString(m.value)}),`);
    lines.push("");
    lines.push("  /// Nilai baru dari server yang belum dikenal versi SDK ini (kompatibilitas maju, N-13).");
    lines.push("  /// Dikodekan sebagai string kosong sehingga server menolaknya bila terkirim kembali.");
    lines.push("  unknown('');");
    lines.push("");
    lines.push(`  const ${def.name}(this.value);`);
    lines.push("");
    lines.push("  /// Nilai JSON di kontrak.");
    lines.push("  final String value;");
    lines.push("");
    lines.push("  /// Nilai dari JSON; nilai yang belum dikenal menjadi [unknown] (tidak melempar galat).");
    lines.push(`  static ${def.name} fromJson(String value) {`);
    lines.push("    for (final candidate in values) {");
    lines.push("      if (candidate != unknown && candidate.value == value) return candidate;");
    lines.push("    }");
    lines.push("    return unknown;");
    lines.push("  }");
    lines.push("");
    lines.push("  String toJson() => value;");
    lines.push("}");
    return lines.join("\n");
  }

  renderAlias(def) {
    return `${doc(def.description ?? `Alias ${def.name} dari kontrak.`)}typedef ${def.name} = ${this.dartType(def.target)};`;
  }

  renderClass(def) {
    const implementsList = this.#compatibleImplements(def);
    const out = [];
    const sourceName = def.source.startsWith("skema ") ? def.source.slice(6) : def.name;
    out.push(doc(def.description ?? `Model ${sourceName} dari kontrak.`).trimEnd());
    out.push("@immutable");
    out.push(`class ${def.name}${implementsList.length ? ` implements ${implementsList.join(", ")}` : ""} {`);

    // Konstruktor.
    if (def.fields.length === 0) out.push(`  const ${def.name}();`);
    else {
      out.push(`  const ${def.name}({`);
      for (const f of def.fields) {
        if (f.required) out.push(`    required this.${f.name},`);
        else if (f.triState) out.push(`    this.${f.name} = const Optional.absent(),`);
        else out.push(`    this.${f.name},`);
      }
      out.push("  });");
    }

    if (!def.multipart) {
      out.push("");
      out.push(
        "  /// Membaca dari JSON (snake_case). Properti yang belum dikenal diabaikan (kompatibilitas maju).",
      );
      out.push(`  factory ${def.name}.fromJson(Map<String, Object?> json) {`);
      if (def.fields.length === 0) out.push(`    return const ${def.name}();`);
      else {
        out.push(`    return ${def.name}(`);
        for (const f of def.fields) {
          const dec = this.decodeFn({ ...f.type, nullable: false });
          const key = dartString(f.jsonName);
          let expr;
          // Nilai bebas: argumen tipe eksplisit agar T tidak disimpulkan non-null dari konteks Optional<Object?>.
          if (f.triState)
            expr = `readPresentField${f.type.t === "any" ? "<Object?>" : ""}(json, ${key}, ${dec})`;
          else if (f.type.t === "any") expr = `json[${key}]`;
          else if (this.#fieldNullable(f)) expr = `readOptionalField(json, ${key}, ${dec})`;
          else expr = `readField(json, ${key}, ${dec})`;
          out.push(`      ${f.name}: ${expr},`);
        }
        out.push("    );");
      }
      out.push("  }");
    }

    // Field.
    for (const f of def.fields) {
      out.push("");
      const fieldDoc = doc(f.description, "  ");
      if (fieldDoc) out.push(fieldDoc.trimEnd());
      if (implementsList.some((b) => this.types.get(b)?.fields.some((bf) => bf.jsonName === f.jsonName))) {
        out.push("  @override");
      }
      out.push(`  final ${this.fieldDartType(f)} ${f.name};`);
    }

    if (def.multipart) {
      out.push("");
      out.push("  /// Body multipart/form-data untuk Dio.");
      out.push("  FormData toFormData() => FormData.fromMap(<String, Object?>{");
      for (const f of def.fields) out.push(`    ${this.#jsonEntry(f, true)},`);
      out.push("  });");
    } else {
      out.push("");
      out.push("  /// Menulis ke JSON (snake_case); field opsional yang kosong tidak dikirim.");
      const overrideToJson = implementsList.length > 0 ? "  @override\n" : "";
      out.push(`${overrideToJson}  Map<String, Object?> toJson() => <String, Object?>{`);
      for (const f of def.fields) out.push(`    ${this.#jsonEntry(f, false)},`);
      out.push("  };");

      // Kesamaan nilai.
      out.push("");
      out.push("  @override");
      out.push("  bool operator ==(Object other) =>");
      if (def.fields.length === 0) out.push(`      identical(this, other) || other is ${def.name};`);
      else {
        const parts = def.fields.map((f) =>
          this.needsDeepEquals(f.type) && !f.triState
            ? `deepEquals(other.${f.name}, ${f.name})`
            : `other.${f.name} == ${f.name}`,
        );
        out.push(`      identical(this, other) ||`);
        out.push(`      other is ${def.name} &&`);
        parts.forEach((p, i) => out.push(`          ${p}${i === parts.length - 1 ? ";" : " &&"}`));
      }
      out.push("");
      out.push("  @override");
      if (def.fields.length === 0) out.push(`  int get hashCode => ${dartString(def.name)}.hashCode;`);
      else {
        const hashes = def.fields.map((f) =>
          this.needsDeepEquals(f.type) && !f.triState ? `deepHash(${f.name})` : f.name,
        );
        out.push(`  int get hashCode => Object.hashAll(<Object?>[${hashes.join(", ")}]);`);
      }
    }

    // toString tanpa nilai sensitif (ARCHITECTURE §2 butir 3: sandi, OTP, token tidak boleh tercatat).
    out.push("");
    out.push("  @override");
    const parts = def.fields.map((f) => {
      if (f.sensitive) return `${f.name}: ***`;
      if (f.type.t === "binary")
        return `${f.name}: \${${f.name}${this.#fieldNullable(f) ? "?" : ""}.filename}`;
      return `${f.name}: $${f.name}`;
    });
    out.push(`  String toString() => ${dartString(`${def.name}(`).slice(0, -1)}${parts.join(", ")})';`);
    out.push("}");
    return out.join("\n");
  }

  /**
   * Ekspresi nilai multipart: berkas diklon setiap kali FormData dibentuk karena dio memfinalisasi
   * MultipartFile setelah terkirim; tanpa klon, mengirim ulang body yang sama ("Coba lagi" setelah jaringan
   * putus, PRD 4.3) gagal dengan "MultipartFile has already been finalized".
   */
  #multipartExpr(type, expr) {
    const t = this.#unalias(type);
    if (t.t === "binary") return `${expr}.clone()`;
    if (t.t === "list" && this.#unalias(t.of).t === "binary") return `[for (final e0 in ${expr}) e0.clone()]`;
    return this.encodeExpr(type, expr);
  }

  #jsonEntry(f, multipart) {
    const key = dartString(f.jsonName);
    const nonNull = { ...f.type, nullable: false };
    const enc = (e) => (multipart ? this.#multipartExpr(nonNull, e) : this.encodeExpr(nonNull, e));
    const identity = enc("x") === "x";
    if (f.triState) {
      const value = identity
        ? `${f.name}.valueOrNull`
        : `encodeNullable(${f.name}.valueOrNull, (v) => ${enc("v")})`;
      return `if (${f.name}.isPresent) ${key}: ${value}`;
    }
    // Nilai bebas: field wajib selalu dikirim (boleh null); field opsional yang null tidak dikirim.
    if (f.type.t === "any") return f.required ? `${key}: ${f.name}` : `${key}: ?${f.name}`;
    if (f.required && !f.nullable) return `${key}: ${enc(f.name)}`;
    if (f.required && f.nullable && !multipart) {
      return identity ? `${key}: ${f.name}` : `${key}: encodeNullable(${f.name}, (v) => ${enc("v")})`;
    }
    // Elemen null-aware (Dart 3.8): field opsional yang null tidak dikirim.
    if (identity) return `${key}: ?${f.name}`;
    return `if (${f.name} case final v?) ${key}: ${enc("v")}`;
  }
}

/** Nama camelCase untuk dipakai modul lain. */
export { camelCase };
