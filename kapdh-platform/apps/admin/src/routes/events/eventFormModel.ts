import type { components } from "@kapdh/contracts";
import { z } from "zod";
import { DEFAULT_TIME_ZONE, fromZonedInputValue, toZonedInputValue } from "../../lib/format";
import { moneySchema } from "../../lib/validation";
import type { AdminEventDetail } from "./api";

type CreateRequest = components["schemas"]["AdminEventCreateRequest"];
type UpdateRequest = components["schemas"]["AdminEventUpdateRequest"];

/**
 * Logika murni formulir event (F-15, kontrak adminCreateEvent/adminUpdateEvent). Pra-validasi di sini cermin aturan
 * server; server tetap sumber kebenaran (ARCHITECTURE §2.1) dan galatnya dipasang ke isian bernama sama.
 */
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 5000;
export const LOCATION_NAME_MAX = 200;
export const LOCATION_ADDRESS_MAX = 500;
export const LOCATION_URL_MAX = 500;
export const SEATS_MAX = 100_000;

export const DATE_FIELDS = [
  "starts_at",
  "ends_at",
  "registration_opens_at",
  "registration_closes_at",
  "checkin_opens_at",
  "checkin_closes_at",
] as const;
export type DateField = (typeof DATE_FIELDS)[number];

export interface EventFormValues {
  title: string;
  description: string;
  /** "" = tanpa kategori. */
  category_id: string;
  location_name: string;
  location_address: string;
  location_url: string;
  /** Berkas purpose event_cover hasil POST /admin/event-covers; null = tanpa cover. */
  cover_file_id: string | null;
  timezone: string;
  starts_at: string | null;
  ends_at: string | null;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  /** Jendela check-in khusus; false = bawaan D5 (2 jam sebelum mulai sampai selesai). */
  custom_checkin: boolean;
  checkin_opens_at: string | null;
  checkin_closes_at: string | null;
  /** Money "60000.00"; "0.00" = event gratis (AC F09-3). */
  price: string;
  /** Teks angka dari isian; diubah ke integer saat dikirim. */
  seats_total: string;
}

export function emptyEventForm(): EventFormValues {
  return {
    title: "",
    description: "",
    category_id: "",
    location_name: "",
    location_address: "",
    location_url: "",
    cover_file_id: null,
    timezone: DEFAULT_TIME_ZONE,
    starts_at: null,
    ends_at: null,
    registration_opens_at: null,
    registration_closes_at: null,
    custom_checkin: false,
    checkin_opens_at: null,
    checkin_closes_at: null,
    price: "",
    seats_total: "",
  };
}

export function formFromDetail(e: AdminEventDetail): EventFormValues {
  return {
    title: e.title,
    description: e.description ?? "",
    category_id: e.category?.id ?? "",
    location_name: e.location_name ?? "",
    location_address: e.location_address ?? "",
    location_url: e.location_url ?? "",
    cover_file_id: e.cover_file_id,
    timezone: e.timezone,
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    registration_opens_at: e.registration_opens_at,
    registration_closes_at: e.registration_closes_at,
    custom_checkin: e.checkin_opens_at !== null || e.checkin_closes_at !== null,
    checkin_opens_at: e.checkin_opens_at,
    checkin_closes_at: e.checkin_closes_at,
    price: e.price,
    seats_total: String(e.seats_total),
  };
}

/**
 * Ganti zona waktu dengan mempertahankan jam dinding yang sudah diketik admin: "09.00" tetap "09.00" di zona baru,
 * sehingga instan UTC yang dikirim ikut bergeser (PRD 2.1, event menetapkan zona sendiri).
 */
export function shiftZone(iso: string | null, fromZone: string, toZone: string): string | null {
  if (!iso || fromZone === toZone) return iso;
  return fromZonedInputValue(toZonedInputValue(iso, fromZone), toZone);
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);

/** Skema zod formulir; `minSeats` = batas bawah kuota saat ini (min_seats_total, AC F15-2) pada mode ubah. */
export function eventFormSchema(opts: { minSeats?: number } = {}) {
  const minSeats = Math.max(1, opts.minSeats ?? 1);
  return z
    .object({
      title: z
        .string()
        .trim()
        .min(1, "Nama event wajib diisi.")
        .max(TITLE_MAX, `Nama event maksimal ${TITLE_MAX} karakter.`),
      description: z.string().max(DESCRIPTION_MAX, `Deskripsi maksimal ${DESCRIPTION_MAX} karakter.`),
      category_id: z.string(),
      location_name: z.string().max(LOCATION_NAME_MAX, `Nama lokasi maksimal ${LOCATION_NAME_MAX} karakter.`),
      location_address: z
        .string()
        .max(LOCATION_ADDRESS_MAX, `Alamat maksimal ${LOCATION_ADDRESS_MAX} karakter.`),
      location_url: z
        .string()
        .trim()
        .max(LOCATION_URL_MAX, `Tautan maksimal ${LOCATION_URL_MAX} karakter.`)
        .refine((v) => v === "" || /^https:\/\/\S+\.\S+/.test(v), "Tautan lokasi harus diawali https://."),
      cover_file_id: z.string().nullable(),
      timezone: z.string().min(1, "Pilih zona waktu."),
      starts_at: z.string().nullable(),
      ends_at: z.string().nullable(),
      registration_opens_at: z.string().nullable(),
      registration_closes_at: z.string().nullable(),
      custom_checkin: z.boolean(),
      checkin_opens_at: z.string().nullable(),
      checkin_closes_at: z.string().nullable(),
      price: moneySchema,
      seats_total: z
        .string()
        .trim()
        .min(1, "Kuota wajib diisi.")
        .regex(/^\d+$/, "Kuota harus bilangan bulat.")
        .refine(
          (v) => !/^\d+$/.test(v) || (Number(v) >= 1 && Number(v) <= SEATS_MAX),
          `Kuota 1 sampai ${SEATS_MAX.toLocaleString("id-ID")}.`,
        )
        .refine(
          (v) => !/^\d+$/.test(v) || Number(v) >= minSeats,
          `Kuota tidak boleh di bawah ${minSeats} (kursi ditahan + terbayar, AC F15-2).`,
        ),
    })
    .superRefine((v, ctx) => {
      const required: [DateField, string][] = [
        ["starts_at", "Waktu mulai wajib diisi."],
        ["ends_at", "Waktu selesai wajib diisi."],
        ["registration_opens_at", "Buka pendaftaran wajib diisi."],
        ["registration_closes_at", "Tutup pendaftaran wajib diisi."],
      ];
      for (const [field, message] of required)
        if (!v[field]) ctx.addIssue({ code: "custom", path: [field], message });
      if (v.starts_at && v.ends_at && !(ms(v.ends_at) > ms(v.starts_at)))
        ctx.addIssue({
          code: "custom",
          path: ["ends_at"],
          message: "Waktu selesai harus setelah waktu mulai.",
        });
      if (v.registration_opens_at && v.registration_closes_at) {
        if (!(ms(v.registration_opens_at) < ms(v.registration_closes_at)))
          ctx.addIssue({
            code: "custom",
            path: ["registration_closes_at"],
            message: "Tutup pendaftaran harus setelah buka pendaftaran.",
          });
        else if (v.ends_at && ms(v.registration_closes_at) > ms(v.ends_at))
          ctx.addIssue({
            code: "custom",
            path: ["registration_closes_at"],
            message: "Tutup pendaftaran paling lambat saat event selesai.",
          });
      }
      if (v.custom_checkin) {
        if (!v.checkin_opens_at)
          ctx.addIssue({ code: "custom", path: ["checkin_opens_at"], message: "Buka check-in wajib diisi." });
        if (!v.checkin_closes_at)
          ctx.addIssue({
            code: "custom",
            path: ["checkin_closes_at"],
            message: "Tutup check-in wajib diisi.",
          });
        if (v.checkin_opens_at && v.checkin_closes_at && !(ms(v.checkin_closes_at) > ms(v.checkin_opens_at)))
          ctx.addIssue({
            code: "custom",
            path: ["checkin_closes_at"],
            message: "Tutup check-in harus setelah buka check-in.",
          });
      }
    });
}

const orNull = (s: string) => (s.trim() === "" ? null : s.trim());

/** Nilai formulir yang sudah lolos skema -> body adminCreateEvent. */
export function toCreateRequest(v: EventFormValues): CreateRequest {
  return {
    title: v.title.trim(),
    description: orNull(v.description),
    category_id: v.category_id || null,
    location_name: orNull(v.location_name),
    location_address: orNull(v.location_address),
    location_url: orNull(v.location_url),
    cover_file_id: v.cover_file_id,
    timezone: v.timezone,
    starts_at: v.starts_at!,
    ends_at: v.ends_at!,
    registration_opens_at: v.registration_opens_at!,
    registration_closes_at: v.registration_closes_at!,
    checkin_opens_at: v.custom_checkin ? v.checkin_opens_at : null,
    checkin_closes_at: v.custom_checkin ? v.checkin_closes_at : null,
    price: v.price,
    seats_total: Number(v.seats_total),
  };
}

/**
 * Body PATCH hanya berisi field yang berbeda dari event saat formulir dimuat (kontrak adminUpdateEvent: field yang
 * tidak dikirim tidak berubah). `lockPrice`: harga tidak dikirim bila event sudah memiliki tiket (PRD 4.4).
 * Objek kosong berarti tidak ada perubahan.
 */
export function toUpdateRequest(
  base: AdminEventDetail,
  v: EventFormValues,
  opts: { lockPrice: boolean },
): UpdateRequest {
  const next = toCreateRequest(v);
  const before: CreateRequest = {
    title: base.title,
    description: base.description,
    category_id: base.category?.id ?? null,
    location_name: base.location_name,
    location_address: base.location_address,
    location_url: base.location_url,
    cover_file_id: base.cover_file_id,
    timezone: base.timezone,
    starts_at: base.starts_at,
    ends_at: base.ends_at,
    registration_opens_at: base.registration_opens_at,
    registration_closes_at: base.registration_closes_at,
    checkin_opens_at: base.checkin_opens_at,
    checkin_closes_at: base.checkin_closes_at,
    price: base.price,
    seats_total: base.seats_total,
  };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof CreateRequest)[]) {
    if (key === "price" && opts.lockPrice) continue;
    const a = before[key];
    const b = next[key];
    const same =
      typeof a === "string" && typeof b === "string" && DATE_FIELDS.includes(key as DateField)
        ? Date.parse(a) === Date.parse(b)
        : a === b;
    if (!same) out[key] = b;
  }
  return out as UpdateRequest;
}

/** Perubahan yang diberitahukan kepada pemegang tiket aktif (kontrak adminUpdateEvent, AC F13-6). */
export function changesNotifyHolders(patch: UpdateRequest): boolean {
  return ["starts_at", "ends_at", "timezone", "location_name", "location_address", "location_url"].some(
    (k) => k in patch,
  );
}
