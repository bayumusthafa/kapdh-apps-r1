import { describe, expect, it } from "vitest";
import type { AdminEventDetail } from "./api";
import {
  changesNotifyHolders,
  emptyEventForm,
  eventFormSchema,
  type EventFormValues,
  formFromDetail,
  shiftZone,
  toCreateRequest,
  toUpdateRequest,
} from "./eventFormModel";
import { formatSchedule, timezoneOptions } from "./labels";

function valid(overrides: Partial<EventFormValues> = {}): EventFormValues {
  return {
    ...emptyEventForm(),
    title: "  Reuni Akbar  ",
    starts_at: "2027-03-10T02:00:00.000Z",
    ends_at: "2027-03-10T08:00:00.000Z",
    registration_opens_at: "2027-02-01T01:00:00.000Z",
    registration_closes_at: "2027-03-09T16:59:00.000Z",
    price: "60000.00",
    seats_total: "100",
    ...overrides,
  };
}

function issues(values: EventFormValues, minSeats?: number): Record<string, string> {
  const r = eventFormSchema({ minSeats }).safeParse(values);
  if (r.success) return {};
  // Pesan pertama per isian, sama dengan yang ditampilkan zodResolver (criteriaMode firstError).
  const out: Record<string, string> = {};
  for (const i of r.error.issues) out[i.path.join(".")] ??= i.message;
  return out;
}

const DETAIL: AdminEventDetail = {
  id: "0199e100-0000-7000-8000-0000000000e1",
  title: "Reuni Akbar",
  cover_url: null,
  category: { id: "0199e100-0000-7000-8000-0000000000c1", slug: "reuni", label: "Reuni" },
  location_name: "Pondok",
  timezone: "Asia/Jakarta",
  starts_at: "2027-03-10T02:00:00.000Z",
  ends_at: "2027-03-10T08:00:00.000Z",
  registration_opens_at: "2027-02-01T01:00:00.000Z",
  registration_closes_at: "2027-03-09T16:59:00.000Z",
  status: "open",
  price: "60000.00",
  seats_total: 100,
  seats_available: 90,
  held_quantity: 4,
  paid_quantity: 6,
  has_tickets: true,
  version: "3",
  updated_at: "2027-01-01T00:00:00.000Z",
  description: null,
  location_address: null,
  location_url: null,
  cover_file_id: null,
  checkin_opens_at: null,
  checkin_closes_at: null,
  effective_checkin_opens_at: "2027-03-10T00:00:00.000Z",
  effective_checkin_closes_at: "2027-03-10T08:00:00.000Z",
  checked_in_count: 0,
  min_seats_total: 10,
  cancelled_at: null,
  cancel_reason: null,
  created_by: null,
  created_at: "2027-01-01T00:00:00.000Z",
  allowed_actions: ["edit", "close", "cancel"],
};

describe("model formulir event (F-15, kontrak adminCreateEvent/adminUpdateEvent)", () => {
  it("menerima event valid dan membentuk body create: judul di-trim, teks kosong menjadi null, kuota integer", () => {
    expect(issues(valid())).toEqual({});
    const body = toCreateRequest(eventFormSchema().parse(valid()));
    expect(body).toMatchObject({
      title: "Reuni Akbar",
      description: null,
      category_id: null,
      location_url: null,
      timezone: "Asia/Jakarta",
      checkin_opens_at: null,
      checkin_closes_at: null,
      price: "60000.00",
      seats_total: 100,
    });
  });

  it("aturan waktu server: selesai > mulai, buka daftar < tutup daftar <= selesai", () => {
    expect(issues(valid({ ends_at: "2027-03-10T01:00:00.000Z" }))).toHaveProperty("ends_at");
    expect(issues(valid({ registration_closes_at: "2027-01-01T00:00:00.000Z" }))).toHaveProperty(
      "registration_closes_at",
      "Tutup pendaftaran harus setelah buka pendaftaran.",
    );
    expect(issues(valid({ registration_closes_at: "2027-03-10T09:00:00.000Z" }))).toHaveProperty(
      "registration_closes_at",
      "Tutup pendaftaran paling lambat saat event selesai.",
    );
    expect(issues(valid({ starts_at: null }))).toHaveProperty("starts_at", "Waktu mulai wajib diisi.");
  });

  it("D5: jendela check-in khusus wajib lengkap dengan tutup > buka; bawaan mengirim null", () => {
    const custom = valid({ custom_checkin: true, checkin_opens_at: "2027-03-10T01:00:00.000Z" });
    expect(issues(custom)).toHaveProperty("checkin_closes_at", "Tutup check-in wajib diisi.");
    expect(issues({ ...custom, checkin_closes_at: "2027-03-10T00:30:00.000Z" })).toHaveProperty(
      "checkin_closes_at",
      "Tutup check-in harus setelah buka check-in.",
    );
    // Saklar dimatikan: nilai lama tidak ikut terkirim.
    const off = toCreateRequest(
      valid({ custom_checkin: false, checkin_opens_at: "2027-03-10T01:00:00.000Z" }),
    );
    expect(off.checkin_opens_at).toBeNull();
  });

  it("tautan lokasi wajib https, harga Money desimal dan kuota 1..100000", () => {
    expect(issues(valid({ location_url: "http://maps.example.com" }))).toHaveProperty("location_url");
    expect(issues(valid({ location_url: "https://maps.example.com/x" }))).toEqual({});
    expect(issues(valid({ price: "60.000" }))).toHaveProperty("price");
    expect(issues(valid({ seats_total: "0" }))).toHaveProperty("seats_total");
    expect(issues(valid({ seats_total: "100001" }))).toHaveProperty("seats_total");
    expect(issues(valid({ seats_total: "12,5" }))).toHaveProperty(
      "seats_total",
      "Kuota harus bilangan bulat.",
    );
  });

  it("AC F15-2: kuota di bawah held+paid (min_seats_total) ditolak sebelum dikirim", () => {
    expect(issues(valid({ seats_total: "9" }), 10)).toHaveProperty(
      "seats_total",
      "Kuota tidak boleh di bawah 10 (kursi ditahan + terbayar, AC F15-2).",
    );
    expect(issues(valid({ seats_total: "10" }), 10)).toEqual({});
  });

  it("PATCH hanya berisi field yang berubah; waktu yang sama dalam format berbeda tidak dianggap berubah", () => {
    const base = formFromDetail(DETAIL);
    expect(toUpdateRequest(DETAIL, base, { lockPrice: false })).toEqual({});
    const edited = {
      ...base,
      title: "Reuni Akbar 2027",
      seats_total: "120",
      starts_at: "2027-03-10T02:00:00Z",
      location_url: "",
    };
    expect(toUpdateRequest(DETAIL, edited, { lockPrice: false })).toEqual({
      title: "Reuni Akbar 2027",
      seats_total: 120,
    });
  });

  it("PRD 4.4: harga terkunci tidak pernah dikirim walau isian berubah", () => {
    const edited = { ...formFromDetail(DETAIL), price: "75000.00" };
    expect(toUpdateRequest(DETAIL, edited, { lockPrice: true })).toEqual({});
    expect(toUpdateRequest(DETAIL, edited, { lockPrice: false })).toEqual({ price: "75000.00" });
  });

  it("AC F13-6: perubahan jadwal, zona atau lokasi memberi notifikasi pemegang tiket; judul/kuota tidak", () => {
    expect(changesNotifyHolders({ starts_at: "2027-03-11T02:00:00.000Z" })).toBe(true);
    expect(changesNotifyHolders({ location_name: "Aula" })).toBe(true);
    expect(changesNotifyHolders({ timezone: "Asia/Makassar" })).toBe(true);
    expect(changesNotifyHolders({ title: "Baru", seats_total: 50 })).toBe(false);
  });

  it("PRD 2.1: mengganti zona mempertahankan jam dinding (09.00 WIB -> 09.00 WITA = 01.00Z)", () => {
    expect(shiftZone("2027-03-10T02:00:00.000Z", "Asia/Jakarta", "Asia/Makassar")).toBe(
      "2027-03-10T01:00:00.000Z",
    );
    expect(shiftZone(null, "Asia/Jakarta", "Asia/Makassar")).toBeNull();
    expect(formatSchedule("2027-03-10T01:00:00.000Z", "2027-03-10T07:00:00.000Z", "Asia/Makassar")).toBe(
      "10 Mar 2027, 09.00–15.00 WITA",
    );
    expect(formatSchedule("2027-03-10T02:00:00.000Z", "2027-03-11T08:00:00.000Z")).toBe(
      "10 Mar 2027, 09.00 – 11 Mar 2027, 15.00 WIB",
    );
  });

  it("zona event lama di luar daftar Indonesia tetap ditawarkan agar tidak hilang diam-diam", () => {
    expect(timezoneOptions("Asia/Jakarta").map((o) => o.value)).toEqual([
      "Asia/Jakarta",
      "Asia/Makassar",
      "Asia/Jayapura",
    ]);
    expect(timezoneOptions("Asia/Singapore").at(-1)).toEqual({
      value: "Asia/Singapore",
      label: "Asia/Singapore",
    });
  });
});
