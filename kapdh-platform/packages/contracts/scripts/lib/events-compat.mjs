// Perbandingan kompatibilitas skema event realtime (events/*.schema.json; PRD 5.2, N-13; review E2 untuk D2-12).
// Murni (tanpa I/O); dipanggil scripts/check-breaking.mjs bersama `oasdiff breaking` untuk kontrak HTTP.
//
// Event mengalir server -> klien (klien hanya mengirim `typing {room_id}` dan `presence.ping` tanpa skema, events/
// README.md), jadi aplikasi lama adalah PEMBACA. Perubahan dinilai dari sudut pembaca, dengan level yang sama dengan
// oasdiff (3 = ERR memutus, 2 = WARN, 1 = INFO):
//   ERR  berkas skema event dihapus; jenis event dihapus dari enum `type` amplop; properti WAJIB dihapus atau menjadi
//        opsional; tipe diperlebar (mis. string -> string|null, tipe dihapus); format berubah; const berubah
//        (mis. versi amplop `v`); cabang oneOf/anyOf baru (nilai yang belum dikenal pembaca); $ref berganti.
//   WARN nilai enum baru atau enum dilepas (SDK Dart menerima nilai yang belum dikenal, diuji di dart/kapdh_api);
//        properti opsional dihapus (pembaca sudah wajib menangani ketiadaannya); format dilepas.
//   INFO berkas/properti/nilai baru, penyempitan tipe, nilai enum dihapus dari payload.
export const LEVEL = Object.freeze({ ERR: 3, WARN: 2, INFO: 1 });

const ENVELOPE_FILE = "envelope.schema.json";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    isObject(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
const typeSet = (schema) =>
  schema.type === undefined ? null : new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
const pointer = (parts) => (parts.length === 0 ? "" : `/${parts.join("/")}`);

function change(changes, level, id, file, parts, text) {
  changes.push({ id, level, text, section: "events", path: `events/${file}#${pointer(parts)}` });
}

function compareSchema(base, head, file, parts, changes) {
  if (!isObject(base) || !isObject(head)) return;

  if (base.$ref !== undefined && base.$ref !== head.$ref)
    change(
      changes,
      LEVEL.ERR,
      "event-ref-changed",
      file,
      parts,
      `$ref ${base.$ref} -> ${head.$ref ?? "(dihapus)"}`,
    );

  if (base.const !== undefined && canonical(base.const) !== canonical(head.const))
    change(
      changes,
      LEVEL.ERR,
      "event-const-changed",
      file,
      parts,
      `const ${canonical(base.const)} -> ${head.const === undefined ? "(dihapus)" : canonical(head.const)}`,
    );

  const tBase = typeSet(base);
  const tHead = typeSet(head);
  if (tBase !== null) {
    const widened = tHead === null ? ["(semua tipe)"] : [...tHead].filter((t) => !tBase.has(t));
    if (widened.length > 0)
      change(
        changes,
        LEVEL.ERR,
        "event-type-widened",
        file,
        parts,
        `tipe diperlebar dengan ${widened.join(", ")}; pembaca lama tidak siap menerimanya`,
      );
  }

  if (typeof base.format === "string") {
    if (typeof head.format === "string" && head.format !== base.format)
      change(
        changes,
        LEVEL.ERR,
        "event-format-changed",
        file,
        parts,
        `format ${base.format} -> ${head.format}`,
      );
    else if (head.format === undefined)
      change(changes, LEVEL.WARN, "event-format-removed", file, parts, `format ${base.format} dilepas`);
  }

  if (Array.isArray(base.enum)) {
    if (!Array.isArray(head.enum))
      change(changes, LEVEL.WARN, "event-enum-removed", file, parts, "batasan enum dilepas");
    else {
      const b = new Set(base.enum.map(canonical));
      const h = new Set(head.enum.map(canonical));
      const added = [...h].filter((v) => !b.has(v));
      const removed = [...b].filter((v) => !h.has(v));
      if (added.length > 0)
        change(
          changes,
          LEVEL.WARN,
          "event-enum-value-added",
          file,
          parts,
          `nilai enum baru ${added.join(", ")}`,
        );
      if (removed.length > 0) {
        const eventType = file === ENVELOPE_FILE && pointer(parts) === "/properties/type";
        change(
          changes,
          eventType ? LEVEL.ERR : LEVEL.INFO,
          eventType ? "event-type-removed" : "event-enum-value-removed",
          file,
          parts,
          eventType
            ? `jenis event ${removed.join(", ")} dihapus; aplikasi lama tidak lagi menerima pembaruan itu`
            : `nilai enum ${removed.join(", ")} tidak lagi dikirim`,
        );
      }
    }
  }

  for (const key of ["oneOf", "anyOf"]) {
    if (!Array.isArray(base[key]) && !Array.isArray(head[key])) continue;
    const b = new Set((base[key] ?? []).map(canonical));
    const h = (head[key] ?? []).map(canonical);
    const added = h.filter((v) => !b.has(v));
    if (Array.isArray(base[key]) && added.length > 0)
      change(
        changes,
        LEVEL.ERR,
        `event-${key.toLowerCase()}-branch-added`,
        file,
        [...parts, key],
        `cabang baru ${added.join(" ")}`,
      );
  }

  if (isObject(base.properties)) {
    const required = new Set(Array.isArray(base.required) ? base.required : []);
    const headRequired = new Set(Array.isArray(head.required) ? head.required : []);
    const headProps = isObject(head.properties) ? head.properties : {};
    for (const [name, sub] of Object.entries(base.properties)) {
      const at = [...parts, "properties", name];
      if (!(name in headProps)) {
        if (required.has(name))
          change(
            changes,
            LEVEL.ERR,
            "event-required-property-removed",
            file,
            at,
            `properti wajib ${name} dihapus`,
          );
        else
          change(
            changes,
            LEVEL.WARN,
            "event-optional-property-removed",
            file,
            at,
            `properti opsional ${name} dihapus`,
          );
        continue;
      }
      if (required.has(name) && !headRequired.has(name))
        change(
          changes,
          LEVEL.ERR,
          "event-property-became-optional",
          file,
          at,
          `properti ${name} tidak lagi wajib`,
        );
      compareSchema(sub, headProps[name], file, at, changes);
    }
  }

  if (isObject(base.items) && isObject(head.items))
    compareSchema(base.items, head.items, file, [...parts, "items"], changes);
}

/**
 * Membandingkan dua kumpulan skema event ({nama berkas: objek skema}).
 * @returns {object[]} perubahan berbentuk keluaran oasdiff (id, level, text, section, path).
 */
export function diffEventSchemas(baseFiles, headFiles) {
  const changes = [];
  for (const [file, base] of Object.entries(baseFiles)) {
    const head = headFiles[file];
    if (head === undefined) {
      change(changes, LEVEL.ERR, "event-schema-removed", file, [], `skema event ${file} dihapus`);
      continue;
    }
    compareSchema(base, head, file, [], changes);
  }
  for (const file of Object.keys(headFiles))
    if (!(file in baseFiles))
      change(changes, LEVEL.INFO, "event-schema-added", file, [], `skema event baru ${file}`);
  return changes;
}
