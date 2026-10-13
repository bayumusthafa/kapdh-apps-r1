/**
 * Redaksi data pribadi pada catatan yang DISIMPAN anonim setelah penghapusan akun (D2, AC F14-4, PRD 6.5 "whitelist
 * snapshot, redaksi"). Fungsi murni sehingga dapat diuji tanpa database.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** Money kontrak (`"60000.00"`, ARCHITECTURE §2.5): selalu dua desimal sehingga nomor telepon tidak lolos. */
const MONEY = /^\d{1,12}\.\d{2}$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Nomor permintaan penghapusan (bukan data pribadi; dipakai komunikasi bantuan). */
const REQUEST_NUMBER = /^DEL-[0-9]{4}-[0-9A-Z]{4,}$/;

/**
 * Kunci yang nilai string-nya berupa kode/enum (bukan teks bebas) dan boleh dipertahankan pada snapshot audit.
 * Teks bebas (nama, email, telepon, alasan, pesan, nomor anggota, tautan sosial) tidak pernah termasuk.
 */
const SAFE_ENUM_KEYS = new Set([
  "status",
  "kind",
  "type",
  "action",
  "outcome",
  "source",
  "category",
  "priority",
  "role",
  "purpose",
  "platform",
  "audience",
  "stage",
  "channel",
  "effective_status",
  "account_status",
  "mfa_method",
  "method",
  "reason_code",
  "cancelled_by",
  "target_type",
  "visibility",
  "ticket_status",
  "payment_type",
  "request_number",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeScalar(value: unknown, key: string | null, userId: string): { keep: boolean; value: unknown } {
  if (value === null || typeof value === "number" || typeof value === "boolean") return { keep: true, value };
  if (typeof value !== "string") return { keep: false, value: null };
  if (UUID.test(value)) return { keep: true, value: value.toLowerCase() === userId ? null : value };
  if (ISO_DATETIME.test(value) || MONEY.test(value)) return { keep: true, value };
  if (key === "request_number" && REQUEST_NUMBER.test(value)) return { keep: true, value };
  if (key !== null && SAFE_ENUM_KEYS.has(key) && TOKEN.test(value)) return { keep: true, value };
  return { keep: false, value: null };
}

function whitelist(value: unknown, key: string | null, userId: string, depth: number): { keep: boolean; value: unknown } {
  if (depth > 8) return { keep: false, value: null };
  if (Array.isArray(value)) {
    const items = value
      .map((item) => whitelist(item, key, userId, depth + 1))
      .filter((item) => item.keep)
      .map((item) => item.value);
    return { keep: true, value: items };
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [innerKey, inner] of Object.entries(value)) {
      const result = whitelist(inner, innerKey, userId, depth + 1);
      if (result.keep) out[innerKey] = result.value;
    }
    return { keep: true, value: out };
  }
  return safeScalar(value, key, userId);
}

/**
 * Snapshot audit (before/after) yang hanya mempertahankan nilai non-identitas: angka, boolean, waktu, nominal Money,
 * UUID rujukan (UUID akun yang dihapus menjadi null), dan kode/enum pada kunci {@link SAFE_ENUM_KEYS}. Teks bebas
 * lain dibuang. Nilai null/undefined tetap null.
 */
export function redactAuditSnapshot(value: unknown, userId: string): unknown {
  if (value === null || value === undefined) return null;
  return whitelist(value, null, userId.toLowerCase(), 0).value;
}

/** Kunci identitas/isi yang dikosongkan pada objek milik akun yang dihapus di dalam bukti moderasi. */
const IDENTITY_KEY =
  /(^|_)(name|full_name|display_name|bio|body|text|caption|member_number|cohort|email|phone|city|avatar|avatar_url|suspension_reason|suspension_message|description|reason|message)$/;

export interface EvidenceScrubContext {
  userId: string;
  /** Berkas yang dihapus job (avatar, gambar chat, bukti); rujukannya di bukti menjadi null. */
  deletedFileIds: ReadonlySet<string>;
  /** Akun yang dihapus adalah pihak terlapor/pemohon banding laporan ini (snapshot profil miliknya). */
  subjectIsUser: boolean;
}

function scrubNode(value: unknown, ctx: EvidenceScrubContext, owned: boolean, depth: number): unknown {
  if (depth > 10) return null;
  if (Array.isArray(value)) return value.map((item) => scrubNode(item, ctx, owned, depth + 1));
  if (!isPlainObject(value)) {
    if (typeof value === "string" && value.toLowerCase() === ctx.userId) return null;
    return owned && typeof value === "string" ? null : value;
  }
  // Objek yang menunjuk akun yang dihapus (mis. pesan dengan sender_user_id) dianggap miliknya.
  const ownsObject = owned || Object.values(value).some((inner) => inner === ctx.userId);
  const fileDeleted = typeof value.file_id === "string" && ctx.deletedFileIds.has(value.file_id);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === "string" && inner.toLowerCase() === ctx.userId) out[key] = null;
    else if (fileDeleted && (key === "file_id" || key === "url" || key === "url_expires_at")) out[key] = null;
    else if (ownsObject && IDENTITY_KEY.test(key) && !isPlainObject(inner) && !Array.isArray(inner))
      out[key] = null;
    else if ((key === "profile" || key === "contested_suspension") && ctx.subjectIsUser && inner !== null)
      out[key] = scrubNode(inner, ctx, true, depth + 1);
    else out[key] = scrubNode(inner, ctx, false, depth + 1);
  }
  return out;
}

/**
 * Bukti laporan moderasi yang disimpan anonim (D2, kontrak admin-moderation "data pihak yang akunnya sudah dihapus
 * tampil anonim (null)"): UUID akun menjadi null; nama, isi pesan, bio, foto dan teks lain milik akun itu dikosongkan;
 * rujukan berkas yang dihapus menjadi null. Pesan dan data pengguna lain di bukti tidak diubah (AC F14-2).
 */
export function scrubEvidence(evidence: unknown, ctx: EvidenceScrubContext): unknown {
  if (evidence === null || evidence === undefined) return evidence ?? null;
  return scrubNode(evidence, { ...ctx, userId: ctx.userId.toLowerCase() }, false, 0);
}
