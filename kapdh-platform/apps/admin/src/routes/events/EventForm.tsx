import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Save, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Controller, FormProvider, useController, useForm } from "react-hook-form";
import { api } from "../../api/client";
import { useApiMutation } from "../../api/query";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Switch } from "../../components/ui/Choice";
import { DateTimeField, MoneyField } from "../../components/ui/FormatFields";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input, Select, Textarea } from "../../components/ui/Input";
import { useToast } from "../../components/ui/Toast";
import { formatDateTime, formatRupiah, zoneLabel } from "../../lib/format";
import {
  type AdminEventDetail,
  currentEventDetail,
  eventKeys,
  storeEventDetail,
  useEventCategories,
} from "./api";
import {
  changesNotifyHolders,
  DATE_FIELDS,
  DESCRIPTION_MAX,
  emptyEventForm,
  eventFormSchema,
  type EventFormValues,
  formFromDetail,
  LOCATION_ADDRESS_MAX,
  LOCATION_NAME_MAX,
  LOCATION_URL_MAX,
  shiftZone,
  TITLE_MAX,
  toCreateRequest,
  toUpdateRequest,
} from "./eventFormModel";
import { type CoverValue, EventCoverField } from "./EventCoverField";
import { timezoneOptions } from "./labels";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-4 pb-5">
      <CardHeader title={title} description={description} />
      <div className="flex flex-col gap-4 px-5">{children}</div>
    </Card>
  );
}

function coverFromDetail(e: AdminEventDetail | undefined): CoverValue | null {
  return e?.cover_file_id ? { fileId: e.cover_file_id, url: e.cover_url } : null;
}

/**
 * Formulir buat/ubah event (F-15, guideline p14: informasi, kategori, lokasi, gambar, periode pendaftaran, total
 * tiket). Waktu diketik sebagai jam dinding zona event dan dikirim sebagai ISO UTC (PRD 2.1).
 * - Buat: POST /admin/events dengan Idempotency-Key; event selalu draft (kontrak adminCreateEvent).
 * - Ubah: PATCH hanya field yang berubah dengan If-Match versi saat formulir dimuat. Bila event berubah di tempat
 *   lain (409 VERSION_CONFLICT atau versi baru terlihat), formulir TIDAK menimpa diam-diam: admin ditawari memuat
 *   versi terbaru (AC F15-4). Kuota di bawah kursi ditahan + terbayar ditolak server dengan galat di isian kuota
 *   dan batas terbaru ditampilkan (AC F15-2).
 * - Harga dikunci setelah event memiliki tiket: tiket/payment yang sudah ada memakai harga snapshot (PRD 4.4).
 */
export function EventForm({
  mode,
  detail,
  onSaved,
  onCancel,
}: {
  mode: "create" | "edit";
  /** Detail terbaru dari cache (mode ubah). */
  detail?: AdminEventDetail;
  onSaved: (saved: AdminEventDetail) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const categories = useEventCategories();
  /** Versi event yang menjadi dasar formulir (If-Match). */
  const [base, setBase] = useState<AdminEventDetail | undefined>(detail);
  /** Versi lebih baru terlihat saat formulir sudah diubah admin: tawarkan muat ulang, jangan menimpa (AC F15-4). */
  const [stale, setStale] = useState<AdminEventDetail | null>(null);
  const [cover, setCover] = useState<CoverValue | null>(() => coverFromDetail(detail));
  const staleRef = useRef<HTMLDivElement>(null);
  const minSeats = mode === "edit" ? (detail?.min_seats_total ?? 1) : 1;
  const schema = useMemo(() => eventFormSchema({ minSeats }), [minSeats]);
  const form = useForm<EventFormValues>({
    resolver: zodResolver(schema),
    defaultValues: detail ? formFromDetail(detail) : emptyEventForm(),
  });
  const lockPrice = mode === "edit" && Boolean(detail?.has_tickets);
  const timezone = form.watch("timezone");
  const customCheckin = form.watch("custom_checkin");

  // isDirty dibaca saat render: formState react-hook-form adalah Proxy yang hanya menghitung state yang dibaca.
  const { isDirty } = form.formState;
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  /** Simpan terakhir ditolak VERSION_CONFLICT: versi baru dari `current` selalu ditawarkan, tidak dipasang diam-diam. */
  const conflictRef = useRef(false);

  // Versi baru dari server (konflik, aksi status di halaman yang sama, atau muat ulang).
  const latestVersion = detail?.version;
  useEffect(() => {
    if (mode !== "edit" || !detail || !base || detail.version === base.version) return;
    if (!dirtyRef.current && !conflictRef.current) {
      setBase(detail);
      setCover(coverFromDetail(detail));
      form.reset(formFromDetail(detail));
      setStale(null);
    } else setStale(detail);
    conflictRef.current = false;
    // Hanya bereaksi pada versi baru; detail lain (penghitung kursi) tidak mengubah dasar formulir.
  }, [latestVersion]);

  useEffect(() => {
    if (stale) staleRef.current?.focus();
  }, [stale]);

  function reloadLatest() {
    if (!stale) return;
    setBase(stale);
    setCover(coverFromDetail(stale));
    form.reset(formFromDetail(stale));
    setStale(null);
    toast.info("Formulir memuat versi terbaru event. Ulangi perubahan Anda bila masih diperlukan.");
  }

  const create = useApiMutation<AdminEventDetail, EventFormValues, EventFormValues>({
    setError: form.setError,
    intent: (v) => toCreateRequest(v),
    request: (v, ctx) =>
      api.POST("/admin/events", {
        params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: toCreateRequest(v),
      }),
    successMessage: "Event draf dibuat. Terbitkan agar terlihat oleh anggota.",
    onSuccess: (saved) => {
      storeEventDetail(queryClient, saved);
      onSaved(saved);
    },
  });

  const update = useApiMutation<
    AdminEventDetail,
    { patch: ReturnType<typeof toUpdateRequest>; version: string },
    EventFormValues
  >({
    setError: form.setError,
    request: ({ patch, version }) =>
      api.PATCH("/admin/events/{eventId}", {
        params: { path: { eventId: base!.id }, header: { "If-Match": version } },
        body: patch,
      }),
    onReloadLatest: (err) => {
      const latest = currentEventDetail(err.current);
      if (latest) {
        conflictRef.current = true;
        storeEventDetail(queryClient, latest);
      } else void queryClient.invalidateQueries({ queryKey: eventKeys.detail(base!.id) });
    },
    onError: (err) => {
      // AC F15-2: kuota di bawah held+paid -> 409 VALIDATION_ERROR dengan `current`; batas terbaru ditampilkan.
      const latest = err.code === "VALIDATION_ERROR" ? currentEventDetail(err.current) : null;
      if (latest) storeEventDetail(queryClient, latest);
    },
    onSuccess: (saved, { patch }) => {
      storeEventDetail(queryClient, saved);
      setBase(saved);
      setCover(coverFromDetail(saved));
      form.reset(formFromDetail(saved));
      setStale(null);
      const activeTickets = saved.held_quantity + saved.paid_quantity > 0;
      toast.success(
        changesNotifyHolders(patch) && activeTickets
          ? "Perubahan disimpan. Pemegang tiket diberi notifikasi perubahan jadwal atau lokasi."
          : "Perubahan event disimpan.",
      );
      onSaved(saved);
    },
  });

  const pending = create.isPending || update.isPending;

  const onSubmit = form.handleSubmit((values) => {
    if (mode === "create") {
      create.mutate(values);
      return;
    }
    if (!base) return;
    const patch = toUpdateRequest(base, values, { lockPrice });
    if (Object.keys(patch).length === 0) {
      toast.info("Tidak ada perubahan untuk disimpan.");
      return;
    }
    update.mutate({ patch, version: base.version });
  });

  function changeZone(next: string) {
    const prev = form.getValues("timezone");
    form.setValue("timezone", next, { shouldDirty: true });
    for (const f of DATE_FIELDS) {
      const value = form.getValues(f);
      if (value) form.setValue(f, shiftZone(value, prev, next), { shouldDirty: true });
    }
  }

  const categoryOptions = useMemo(() => {
    const items = categories.data?.items ?? [];
    const selected = base?.category?.id ?? null;
    return [
      { value: "", label: "Tanpa kategori" },
      ...items
        .filter((c) => c.active || c.id === selected)
        .map((c) => ({ value: c.id, label: c.active ? c.label : `${c.label} (nonaktif)` })),
    ];
  }, [categories.data, base?.category?.id]);

  const rootError = form.formState.errors.root?.server?.message;
  const zone = zoneLabel(timezone);

  return (
    <FormProvider {...form}>
      <form
        noValidate
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-5"
        aria-label={mode === "create" ? "Formulir event baru" : "Formulir ubah event"}
      >
        {stale ? (
          <div
            ref={staleRef}
            tabIndex={-1}
            role="alert"
            className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-bg p-4 text-sm text-warning"
          >
            <p className="flex items-start gap-2 font-semibold">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              Event ini sudah diubah di tempat lain (versi {stale.version}, {formatDateTime(stale.updated_at)}
              ).
            </p>
            <p className="text-text">
              Perubahan Anda belum disimpan dan tidak akan menimpa versi terbaru. Muat versi terbaru, lalu
              ulangi perubahan yang masih diperlukan.
            </p>
            <div>
              <Button
                size="sm"
                variant="outline"
                leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
                onClick={reloadLatest}
              >
                Muat versi terbaru
              </Button>
            </div>
          </div>
        ) : null}
        <FormError message={rootError} />

        <Section
          title="Informasi Event"
          description="Nama, kategori, deskripsi dan gambar yang tampil di aplikasi."
        >
          <FormField<EventFormValues, "title"> name="title" label="Nama event" required>
            {(field, a11y) => (
              <Input {...a11y} {...field} maxLength={TITLE_MAX} autoComplete="off" disabled={pending} />
            )}
          </FormField>
          <FormField<EventFormValues, "category_id">
            name="category_id"
            label="Kategori"
            hint={
              categories.isError
                ? "Kategori gagal dimuat; event tetap dapat disimpan tanpa kategori."
                : "Kategori nonaktif tidak dapat dipilih untuk event baru atau diubah."
            }
          >
            {(field, a11y) => (
              <Select
                {...a11y}
                ref={field.ref}
                name={field.name}
                onBlur={field.onBlur}
                value={field.value}
                onValueChange={field.onChange}
                options={categoryOptions}
                disabled={pending}
              />
            )}
          </FormField>
          <FormField<EventFormValues, "description">
            name="description"
            label="Deskripsi"
            hint="Teks polos; tampil pada detail event di aplikasi."
          >
            {(field, a11y) => (
              <Textarea
                {...a11y}
                {...field}
                rows={5}
                maxLength={DESCRIPTION_MAX}
                showCount
                disabled={pending}
              />
            )}
          </FormField>
          <CoverFormField cover={cover} disabled={pending} onCoverChange={setCover} />
        </Section>

        <Section title="Lokasi" description="Ditampilkan kepada peserta beserta tautan peta.">
          <FormField<EventFormValues, "location_name"> name="location_name" label="Nama lokasi">
            {(field, a11y) => (
              <Input
                {...a11y}
                {...field}
                maxLength={LOCATION_NAME_MAX}
                placeholder="Contoh: Aula Pondok Darel Hikmah"
                disabled={pending}
              />
            )}
          </FormField>
          <FormField<EventFormValues, "location_address"> name="location_address" label="Alamat">
            {(field, a11y) => (
              <Textarea {...a11y} {...field} rows={2} maxLength={LOCATION_ADDRESS_MAX} disabled={pending} />
            )}
          </FormField>
          <FormField<EventFormValues, "location_url">
            name="location_url"
            label="Tautan peta"
            hint="Harus diawali https://, misalnya tautan Google Maps."
          >
            {(field, a11y) => (
              <Input
                {...a11y}
                {...field}
                type="url"
                inputMode="url"
                maxLength={LOCATION_URL_MAX}
                placeholder="https://"
                disabled={pending}
              />
            )}
          </FormField>
        </Section>

        <Section
          title="Jadwal"
          description="Ketik jam sesuai zona waktu event. Mengganti zona mempertahankan jam yang sudah diketik."
        >
          <FormField<EventFormValues, "timezone"> name="timezone" label="Zona waktu event" required>
            {(field, a11y) => (
              <Select
                {...a11y}
                ref={field.ref}
                name={field.name}
                onBlur={field.onBlur}
                value={field.value}
                onValueChange={changeZone}
                options={timezoneOptions(base?.timezone)}
                disabled={pending}
              />
            )}
          </FormField>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <DateFormField name="starts_at" label="Mulai" timezone={timezone} disabled={pending} required />
            <DateFormField name="ends_at" label="Selesai" timezone={timezone} disabled={pending} required />
          </div>
        </Section>

        <Section
          title="Periode Pendaftaran"
          description={`Anggota hanya dapat memesan di antara buka dan tutup daftar (${zone}). Tutup daftar paling lambat saat event selesai.`}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <DateFormField
              name="registration_opens_at"
              label="Buka daftar"
              timezone={timezone}
              disabled={pending}
              required
            />
            <DateFormField
              name="registration_closes_at"
              label="Tutup daftar"
              timezone={timezone}
              disabled={pending}
              required
            />
          </div>
        </Section>

        <Section
          title="Check-in"
          description="Bawaan: dibuka 2 jam sebelum event mulai sampai event selesai."
        >
          <Controller<EventFormValues, "custom_checkin">
            name="custom_checkin"
            control={form.control}
            render={({ field }) => (
              <Switch
                label="Atur jendela check-in sendiri"
                description="Matikan untuk memakai jendela bawaan."
                checked={field.value}
                onCheckedChange={(on) => {
                  field.onChange(on);
                  if (!on) {
                    form.setValue("checkin_opens_at", null, { shouldDirty: true });
                    form.setValue("checkin_closes_at", null, { shouldDirty: true });
                    form.clearErrors(["checkin_opens_at", "checkin_closes_at"]);
                  }
                }}
                stateLabels={["Khusus", "Bawaan"]}
                disabled={pending}
              />
            )}
          />
          {customCheckin ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <DateFormField
                name="checkin_opens_at"
                label="Buka check-in"
                timezone={timezone}
                disabled={pending}
                required
              />
              <DateFormField
                name="checkin_closes_at"
                label="Tutup check-in"
                timezone={timezone}
                disabled={pending}
                required
              />
            </div>
          ) : null}
        </Section>

        <Section
          title="Harga dan Kuota"
          description="Satu tiket berlaku untuk satu orang (anggota pemesan); tidak ada tiket rombongan atau tamu."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormField<EventFormValues, "price">
              name="price"
              label="Harga tiket"
              required
              hint={
                lockPrice
                  ? `Harga terkunci (${formatRupiah(detail?.price)}) karena event sudah memiliki tiket; tiket dan pembayaran yang ada memakai harga saat dipesan.`
                  : "Isi 0 untuk event gratis: tiket langsung lunas tanpa pembayaran."
              }
            >
              {(field, a11y) => (
                <MoneyField
                  {...a11y}
                  ref={field.ref}
                  name={field.name}
                  onBlur={field.onBlur}
                  value={field.value}
                  onValueChange={field.onChange}
                  readOnly={lockPrice}
                  aria-readonly={lockPrice || undefined}
                  disabled={pending}
                />
              )}
            </FormField>
            <FormField<EventFormValues, "seats_total">
              name="seats_total"
              label="Total tiket (kuota)"
              required
              hint={
                mode === "edit" && detail
                  ? `Saat ini ditahan ${detail.held_quantity}, terbayar ${detail.paid_quantity}, sisa ${detail.seats_available}. Kuota minimal ${detail.min_seats_total}.`
                  : "Jumlah kursi; satu tiket satu kursi."
              }
            >
              {(field, a11y) => (
                <Input {...a11y} {...field} inputMode="numeric" autoComplete="off" disabled={pending} />
              )}
            </FormField>
          </div>
        </Section>

        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Batal
          </Button>
          <Button
            type="submit"
            variant="gradient"
            loading={pending}
            loadingText="Menyimpan..."
            disabled={stale !== null}
            focusableWhenDisabled
            leftIcon={<Save aria-hidden="true" className="size-4" />}
          >
            {mode === "create" ? "Simpan sebagai draf" : "Simpan perubahan"}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}

/** Isian cover terikat react-hook-form; galat server `field_errors.cover_file_id` tampil dan memfokus tombol pilih. */
function CoverFormField({
  cover,
  disabled,
  onCoverChange,
}: {
  cover: CoverValue | null;
  disabled?: boolean;
  onCoverChange: (value: CoverValue | null) => void;
}) {
  const { field, fieldState } = useController<EventFormValues, "cover_file_id">({ name: "cover_file_id" });
  return (
    <EventCoverField
      value={cover}
      error={fieldState.error?.message}
      disabled={disabled}
      buttonRef={field.ref}
      onChange={(next) => {
        onCoverChange(next);
        field.onChange(next?.fileId ?? null);
      }}
    />
  );
}

type DateName = (typeof DATE_FIELDS)[number];

function DateFormField({
  name,
  label,
  timezone,
  disabled,
  required,
}: {
  name: DateName;
  label: string;
  timezone: string;
  disabled?: boolean;
  required?: boolean;
}) {
  return (
    <FormField<EventFormValues, DateName> name={name} label={label} required={required}>
      {(field, a11y) => (
        <DateTimeField
          {...a11y}
          ref={field.ref}
          name={field.name}
          onBlur={field.onBlur}
          value={field.value}
          onValueChange={field.onChange}
          timeZone={timezone}
          disabled={disabled}
        />
      )}
    </FormField>
  );
}
