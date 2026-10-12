// Inti penggabung kontrak: openapi/root.yaml + openapi/domains/*.yaml -> satu dokumen OpenAPI 3.1
// (ARCHITECTURE §6). Murni (tanpa I/O) agar dapat diuji; CLI ada di scripts/assemble.mjs.
// Sengaja tidak memakai `redocly join` karena menghapus servers/security global dan menambah `servers: []`
// di setiap path (temuan audit kontrak).

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const DOMAIN_KEYS = new Set(["tags", "paths", "components"]);
const DOMAIN_COMPONENT_SECTIONS = new Set([
  "schemas",
  "parameters",
  "responses",
  "requestBodies",
  "headers",
  "examples",
  "links",
  "callbacks",
  "pathItems",
]);
const ROOT_KEY_ORDER = [
  "openapi",
  "info",
  "jsonSchemaDialect",
  "servers",
  "security",
  "tags",
  "paths",
  "webhooks",
  "components",
  "externalDocs",
];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Menormalkan template path agar `/posts/{slug}` dan `/posts/{id}` terdeteksi identik (OAS 3.1 §4.8.8). */
export function normalizePathTemplate(path) {
  return path.replace(/\{[^}]+\}/g, "{}");
}

/** Mengembalikan semua nilai `$ref` beserta lokasi JSON pointer-nya. */
export function collectRefs(node, pointer = "#", out = []) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectRefs(item, `${pointer}/${i}`, out));
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push({ ref: value, at: pointer });
      else collectRefs(value, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, out);
    }
  }
  return out;
}

/** Menyelesaikan JSON pointer internal (`#/a/b`) terhadap dokumen; undefined bila tidak ada. */
export function resolvePointer(doc, ref) {
  if (!ref.startsWith("#/")) return undefined;
  let node = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(node) && !Array.isArray(node)) return undefined;
    node = node[key];
    if (node === undefined) return undefined;
  }
  return node;
}

function sortedObject(obj) {
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, obj[k]]),
  );
}

/**
 * Menggabungkan root dan domain.
 * @param {{ root: object, domains: Array<{ file: string, doc: unknown }> }} input domain diurutkan pemanggil.
 * @returns {{ doc: object, errors: string[], warnings: string[] }}
 */
export function assemble({ root, domains }) {
  const errors = [];
  const warnings = [];
  if (!isObject(root)) return { doc: {}, errors: ["root.yaml: dokumen kosong atau bukan objek"], warnings };
  if (root.openapi !== "3.1.0") errors.push(`root.yaml: openapi harus 3.1.0 (ditemukan ${root.openapi})`);
  if (isObject(root.paths) && Object.keys(root.paths).length > 0)
    errors.push("root.yaml: path wajib berada di openapi/domains/<domain>.yaml, bukan di root");
  if (Array.isArray(root.tags) && root.tags.length > 0)
    errors.push("root.yaml: tag wajib dideklarasikan oleh domain pemiliknya");

  const doc = structuredClone(root);
  doc.tags = [];
  doc.paths = {};
  doc.components = isObject(doc.components) ? doc.components : {};

  /** nama komponen -> pemilik ("root.yaml" atau berkas domain) */
  const componentOwner = new Map();
  for (const [section, entries] of Object.entries(doc.components)) {
    if (!isObject(entries)) continue;
    for (const name of Object.keys(entries)) componentOwner.set(`${section}.${name}`, "root.yaml");
  }
  const tagOwner = new Map();
  const pathOwner = new Map();
  const normalizedPathOwner = new Map();
  const operationOwner = new Map();
  const domainComponents = [];

  for (const { file, doc: raw } of domains) {
    const d = raw ?? {};
    if (!isObject(d)) {
      errors.push(`${file}: isi berkas harus objek {tags, paths, components}`);
      continue;
    }
    for (const key of Object.keys(d)) {
      if (!DOMAIN_KEYS.has(key))
        errors.push(`${file}: kunci tingkat atas '${key}' tidak diizinkan (hanya tags, paths, components)`);
    }

    // Tag: setiap domain memiliki minimal satu tag dan hanya memakai tag miliknya sendiri.
    const ownTags = new Set();
    const tags = d.tags ?? [];
    if (!Array.isArray(tags) || tags.length === 0)
      errors.push(`${file}: wajib mendeklarasikan minimal satu tag`);
    for (const tag of Array.isArray(tags) ? tags : []) {
      if (!isObject(tag) || typeof tag.name !== "string") {
        errors.push(`${file}: setiap tag wajib memiliki name`);
        continue;
      }
      if (typeof tag.description !== "string" || !/F-\d{2}|N-\d{2}|PRD \d/.test(tag.description))
        errors.push(`${file}: tag '${tag.name}' wajib memiliki description yang merujuk F-xx/N-xx/PRD`);
      if (tagOwner.has(tag.name))
        errors.push(`${file}: tag '${tag.name}' duplikat (sudah di ${tagOwner.get(tag.name)})`);
      else {
        tagOwner.set(tag.name, file);
        doc.tags.push(tag);
      }
      ownTags.add(tag.name);
    }

    // Path dan operasi.
    const paths = d.paths ?? {};
    if (!isObject(paths)) errors.push(`${file}: paths harus objek`);
    for (const [path, item] of Object.entries(isObject(paths) ? paths : {})) {
      if (!path.startsWith("/")) errors.push(`${file}: path '${path}' harus diawali '/'`);
      if (pathOwner.has(path)) {
        errors.push(`${file}: path ${path} sudah didefinisikan di ${pathOwner.get(path)}`);
        continue;
      }
      const normalized = normalizePathTemplate(path);
      if (normalizedPathOwner.has(normalized)) {
        const [otherFile, otherPath] = normalizedPathOwner.get(normalized);
        errors.push(
          `${file}: path ${path} identik dengan ${otherPath} di ${otherFile} (beda nama parameter saja)`,
        );
        continue;
      }
      pathOwner.set(path, file);
      normalizedPathOwner.set(normalized, [file, path]);
      if (!isObject(item)) {
        errors.push(`${file}: path ${path} harus objek`);
        continue;
      }
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (op === undefined) continue;
        const where = `${file}: ${method.toUpperCase()} ${path}`;
        if (!isObject(op)) {
          errors.push(`${where} harus objek`);
          continue;
        }
        if (typeof op.operationId !== "string") errors.push(`${where} wajib memiliki operationId`);
        else if (operationOwner.has(op.operationId))
          errors.push(
            `${where}: operationId ${op.operationId} juga dipakai di ${operationOwner.get(op.operationId)}`,
          );
        else operationOwner.set(op.operationId, `${file} ${method.toUpperCase()} ${path}`);
        const opTags = Array.isArray(op.tags) ? op.tags : [];
        if (opTags.length !== 1) errors.push(`${where} wajib memiliki tepat satu tag`);
        for (const t of opTags) {
          if (!ownTags.has(t)) errors.push(`${where} memakai tag '${t}' yang bukan milik ${file}`);
        }
      }
      doc.paths[path] = item;
    }

    // Komponen milik domain.
    const components = d.components ?? {};
    if (!isObject(components)) errors.push(`${file}: components harus objek`);
    for (const [section, entries] of Object.entries(isObject(components) ? components : {})) {
      if (!DOMAIN_COMPONENT_SECTIONS.has(section)) {
        errors.push(`${file}: components.${section} hanya boleh di root.yaml atau tidak didukung`);
        continue;
      }
      if (!isObject(entries)) {
        errors.push(`${file}: components.${section} harus objek`);
        continue;
      }
      doc.components[section] ??= {};
      for (const [name, value] of Object.entries(entries)) {
        const key = `${section}.${name}`;
        if (componentOwner.has(key)) {
          errors.push(`${file}: components.${key} duplikat (sudah di ${componentOwner.get(key)})`);
          continue;
        }
        componentOwner.set(key, file);
        doc.components[section][name] = value;
        domainComponents.push({ section, name, file });
      }
    }
  }

  // Semua $ref wajib internal dan dapat diselesaikan setelah penggabungan.
  const refs = collectRefs(doc);
  for (const { ref, at } of refs) {
    if (!ref.startsWith("#/")) errors.push(`${at}: $ref '${ref}' harus rujukan internal '#/components/...'`);
    else if (resolvePointer(doc, ref) === undefined) {
      const owner = ownerOfPointer(at, pathOwner, componentOwner);
      errors.push(`${owner}: $ref '${ref}' tidak ditemukan (di ${at})`);
    }
  }

  // Komponen domain yang tidak dirujuk: peringatan saja (komponen bersama di root boleh belum dipakai).
  const referenced = new Set(refs.map((r) => r.ref));
  for (const { section, name, file } of domainComponents) {
    const pointer = `#/components/${section}/${name}`;
    if (!referenced.has(pointer)) warnings.push(`${file}: components.${section}.${name} belum dirujuk`);
  }

  // Keluaran deterministik: urutan kunci akar tetap, komponen diurutkan alfabetis.
  const components = {};
  for (const section of Object.keys(doc.components).sort()) {
    if (isObject(doc.components[section])) components[section] = sortedObject(doc.components[section]);
  }
  doc.components = components;
  const ordered = {};
  for (const key of ROOT_KEY_ORDER) if (key in doc) ordered[key] = doc[key];
  for (const key of Object.keys(doc)) if (!(key in ordered)) ordered[key] = doc[key];
  return { doc: ordered, errors, warnings };
}

function ownerOfPointer(pointer, pathOwner, componentOwner) {
  const parts = pointer.split("/").map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts[1] === "paths" && pathOwner.has(parts[2])) return pathOwner.get(parts[2]);
  if (parts[1] === "components" && componentOwner.has(`${parts[2]}.${parts[3]}`))
    return componentOwner.get(`${parts[2]}.${parts[3]}`);
  return "kontrak";
}
