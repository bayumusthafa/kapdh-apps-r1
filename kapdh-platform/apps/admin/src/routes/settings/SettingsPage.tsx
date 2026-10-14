import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type DefaultValues, type FieldValues, useForm, type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge } from "../../components/ui/Badge";
import { Button, buttonClass } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox, Switch } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { KeyValueList } from "../../components/ui/DataDisplay";
import { DateTimeField } from "../../components/ui/FormatFields";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input, Textarea } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { PermissionGate } from "../../components/ui/PermissionGate";
import { ErrorState, Loading } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { RECORD_PERMISSIONS } from "../payments/recordEligibility";

type Settings = components["schemas"]["AdminAppSettings"];
type Meta = components["schemas"]["AdminSettingMeta"];
type MinVersion = components["schemas"]["AdminMinAppVersionSetting"];
type Maintenance = components["schemas"]["AdminMaintenanceSetting"];
type StoreLinks = components["schemas"]["AdminStoreLinksSetting"];
type Support = components["schemas"]["AdminSupportSetting"];
type PaymentInstructions = components["schemas"]["AdminPaymentInstructionsSetting"];
type Platform = components["schemas"]["DevicePlatform"];

export const SETTINGS_KEY = ["admin-settings"] as const;
const PLATFORM_LABEL: Record<Platform, string> = { android: "Android", ios: "iOS" };
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** Bandingkan semver MAJOR.MINOR.PATCH; >0 bila a lebih baru dari b. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Teks metadata versi kunci pengaturan (AC F15-3: versi konfigurasi tercatat). */
function metaText(meta: Meta): string {
  const by = meta.updated_by?.display_name ?? "nilai awal sistem";
  return `Versi ${meta.version} | diubah ${formatDateTime(meta.updated_at)} oleh ${by}`;
}

/**
 * Halaman Pengaturan (F-15, AC F15-3, F15-4, PRD 4.5, 8.3, D13; izin settings.manage). Setiap kunci app_settings
 * disimpan terpisah dengan If-Match versinya sendiri dan wajib reautentikasi (sandi + kode autentikator). Bila
 * pengurus lain mengubah kunci yang sama lebih dulu, server menjawab 409 VERSION_CONFLICT: isian admin tidak
 * dikirim ulang dan UI menawarkan muat versi terbaru, bukan menimpa diam-diam (AC F15-4). Biaya iuran dikelola di
 * menu Verifikasi Pembayaran (tab Biaya); nilai kebijakan PRD hanya dapat dibaca.
 */
export function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Pengaturan"
        description="Konfigurasi aplikasi yang berversi dan teraudit. Setiap perubahan meminta konfirmasi identitas."
      />
      <PermissionGate anyOf={["settings.manage"]}>
        <SettingsContent />
      </PermissionGate>
    </>
  );
}

function SettingsContent() {
  const settings = useApiQuery({
    queryKey: SETTINGS_KEY,
    request: ({ signal, headers }) => api.GET("/admin/settings", { signal, headers }),
  });
  if (settings.isPending)
    return (
      <Card className="p-2">
        <Loading label="Memuat pengaturan..." rows={6} />
      </Card>
    );
  if (settings.isError)
    return (
      <Card>
        <ErrorState
          error={settings.error}
          onRetry={() => void settings.refetch()}
          title="Pengaturan gagal dimuat"
        />
      </Card>
    );
  const s = settings.data;
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <MaintenanceCard setting={s.maintenance} />
      <MinVersionCard setting={s.min_app_version} storeLinks={s.store_links} />
      <StoreLinksCard setting={s.store_links} />
      <SupportCard setting={s.support} />
      <PaymentInstructionsCard setting={s.payment_instructions} />
      <PoliciesCard settings={s} />
    </div>
  );
}

/**
 * Keadaan formulir satu kunci: nilai dasar (versi yang dibaca), konflik versi dari server, sinkronisasi dengan data
 * terbaru bila formulir belum diubah.
 */
function useSettingForm<K extends SettingKey, V extends FieldValues>(
  key: K,
  setting: Settings[K],
  toValues: (s: Settings[K]) => V,
  schema: z.ZodType<V, V>,
) {
  type T = Settings[K];
  const updateCache = useCacheUpdate();
  const [base, setBase] = useState<T>(setting);
  const [conflict, setConflict] = useState<T | null>(null);
  const form = useForm<V>({
    resolver: zodResolver(schema),
    defaultValues: toValues(setting) as DefaultValues<V>,
  });
  const dirty = form.formState.isDirty;
  // Data baru dari server (muat ulang/aksi lain) hanya diterapkan bila admin belum mengubah isian; versi bersifat
  // opaque sehingga yang dipantau adalah perubahan data, bukan urutan angka versi.
  const seen = useRef(setting.version);
  useEffect(() => {
    if (setting.version === seen.current) return;
    seen.current = setting.version;
    if (!dirty && !conflict && setting.version !== base.version) {
      setBase(setting);
      form.reset(toValues(setting));
    }
  }, [setting, base.version, dirty, conflict, form, toValues]);
  return {
    form,
    base,
    conflict,
    /** Simpan berhasil: hasil server menjadi dasar baru. */
    saved(next: T) {
      seen.current = next.version;
      setBase(next);
      setConflict(null);
      form.reset(toValues(next));
      updateCache(key, next);
    },
    /** 409 VERSION_CONFLICT: simpan `current` tanpa menimpa isian admin. */
    conflicted(error: ApiError) {
      const current = error.current as T | undefined;
      setConflict(current && typeof current === "object" && "version" in current ? current : base);
    },
    /** Admin memilih memuat versi terbaru: isian diganti nilai server. */
    reloadLatest() {
      if (!conflict) return;
      seen.current = conflict.version;
      setBase(conflict);
      form.reset(toValues(conflict));
      setConflict(null);
      updateCache(key, conflict);
    },
  };
}

type SettingKey = "maintenance" | "min_app_version" | "store_links" | "support" | "payment_instructions";

function useCacheUpdate() {
  const queryClient = useQueryClient();
  return <K extends keyof Settings>(key: K, value: Settings[K]) =>
    queryClient.setQueryData<Settings>(SETTINGS_KEY, (old) => (old ? { ...old, [key]: value } : old));
}

function SettingCard<V extends FieldValues>({
  id,
  title,
  description,
  meta,
  conflict,
  onReloadLatest,
  form,
  onSubmit,
  saving,
  saveLabel,
  children,
}: {
  id: string;
  title: string;
  description: ReactNode;
  meta: Meta;
  conflict: Meta | null;
  onReloadLatest: () => void;
  form: UseFormReturn<V>;
  onSubmit: () => void;
  saving: boolean;
  saveLabel: string;
  children: ReactNode;
}) {
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-4 pb-5">
      <CardHeader titleId={id} title={title} description={description} />
      <form
        noValidate
        className="flex flex-col gap-4 px-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <p className="text-xs text-text-muted">{metaText(meta)}</p>
        {conflict ? (
          <div role="alert" className="flex flex-col gap-2 rounded-md bg-warning-bg p-3 text-sm text-warning">
            <p className="flex items-start gap-2">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                Pengaturan ini sudah diubah {conflict.updated_by?.display_name ?? "pengurus lain"} (versi{" "}
                {conflict.version}). Isian Anda belum disimpan; muat versi terbaru lalu ulangi perubahan bila
                masih diperlukan.
              </span>
            </p>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
              onClick={onReloadLatest}
            >
              Muat versi terbaru
            </Button>
          </div>
        ) : null}
        <FormError message={form.formState.errors.root?.server?.message} />
        {children}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={saving} loadingText="Menyimpan..." disabled={conflict !== null}>
            {saveLabel}
          </Button>
          {form.formState.isDirty && !conflict ? (
            <Button variant="ghost" size="sm" onClick={() => form.reset()} disabled={saving}>
              Batalkan perubahan
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ Maintenance

const maintenanceSchema = z
  .object({
    active: z.boolean(),
    message: z.string().max(500, "Pesan maksimal 500 karakter."),
    until: z.string().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.active && v.message.trim() === "")
      ctx.addIssue({
        code: "custom",
        path: ["message"],
        message: "Pesan wajib diisi saat mode pemeliharaan aktif (PRD 4.5).",
      });
    if (v.until && Date.parse(v.until) <= Date.now())
      ctx.addIssue({ code: "custom", path: ["until"], message: "Perkiraan selesai harus di masa depan." });
  });
type MaintenanceValues = z.infer<typeof maintenanceSchema>;
const maintenanceValues = (s: Maintenance): MaintenanceValues => ({
  active: s.active,
  message: s.message ?? "",
  until: s.until,
});

function MaintenanceCard({ setting }: { setting: Maintenance }) {
  const state = useSettingForm("maintenance", setting, maintenanceValues, maintenanceSchema);
  const [confirmOn, setConfirmOn] = useState(false);
  const { form } = state;
  const save = useApiMutation<Maintenance, MaintenanceValues & { version: string }, MaintenanceValues>({
    requiresReauth: true,
    reauthReason: "Mengubah mode pemeliharaan",
    setError: form.setError,
    request: (v, ctx) =>
      api.PUT("/admin/settings/maintenance", {
        params: { header: { "If-Match": v.version, "X-Reauth-Token": ctx.reauthToken ?? "" } },
        body: {
          active: v.active,
          message: v.message.trim() === "" ? null : v.message.trim(),
          until: v.until,
        },
      }),
    onSuccess: (data) => {
      setConfirmOn(false);
      state.saved(data);
    },
    onReloadLatest: (error) => {
      setConfirmOn(false);
      state.conflicted(error);
    },
    onError: () => setConfirmOn(false),
    successMessage: (data) =>
      data.active ? "Mode pemeliharaan diaktifkan." : "Mode pemeliharaan disimpan (tidak aktif).",
  });
  const active = form.watch("active");
  const submit = form.handleSubmit((values) => {
    // Mengaktifkan memengaruhi seluruh anggota: konfirmasi eksplisit dulu (PRD 4.5).
    if (values.active && !state.base.active) setConfirmOn(true);
    else save.mutate({ ...values, version: state.base.version });
  });
  return (
    <SettingCard
      id="pengaturan-maintenance"
      title="Mode pemeliharaan"
      description="Selama aktif, perubahan dari aplikasi anggota ditolak dengan pesan pemeliharaan; baca terkendali dan web admin tetap berjalan (PRD 4.5, 8.4)."
      meta={state.base}
      conflict={state.conflict}
      onReloadLatest={state.reloadLatest}
      form={form}
      onSubmit={() => void submit()}
      saving={save.isPending}
      saveLabel="Simpan mode pemeliharaan"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm">Status saat ini:</span>
        {state.base.active ? (
          <Badge tone="warning" icon={<TriangleAlert />}>
            Pemeliharaan aktif
          </Badge>
        ) : (
          <Badge tone="success">Layanan normal</Badge>
        )}
      </div>
      <Switch
        label="Aktifkan mode pemeliharaan"
        checked={active}
        onCheckedChange={(v) => form.setValue("active", v, { shouldDirty: true })}
      />
      <FormField<MaintenanceValues, "message">
        control={form.control}
        name="message"
        label="Pesan untuk pengguna"
        required={active}
        hint="Jelaskan perkiraan durasi, kapan mencoba lagi, dan kanal dukungan (PRD 4.5)."
      >
        {(field, a11y) => <Textarea {...field} {...a11y} rows={3} maxLength={500} showCount />}
      </FormField>
      <FormField<MaintenanceValues, "until">
        control={form.control}
        name="until"
        label="Perkiraan selesai (opsional)"
      >
        {(field, a11y) => (
          <DateTimeField
            {...a11y}
            name={field.name}
            onBlur={field.onBlur}
            ref={field.ref}
            value={field.value}
            onValueChange={(iso) => field.onChange(iso)}
          />
        )}
      </FormField>
      <ConfirmDialog
        open={confirmOn}
        tone="primary"
        onCancel={() => setConfirmOn(false)}
        onConfirm={() => save.mutate({ ...form.getValues(), version: state.base.version })}
        pending={save.isPending}
        title="Aktifkan mode pemeliharaan?"
        description="Semua perubahan dari aplikasi anggota akan ditolak dengan pesan berikut sampai mode ini dimatikan."
        confirmLabel="Aktifkan pemeliharaan"
      >
        <blockquote className="rounded-md border-l-4 border-warning bg-warning-bg px-3 py-2 text-sm text-text">
          {form.getValues("message")}
        </blockquote>
      </ConfirmDialog>
    </SettingCard>
  );
}

// ------------------------------------------------------------------------------------------------ Versi minimum

const semverField = z.string().trim().regex(SEMVER, "Gunakan format MAJOR.MINOR.PATCH, mis. 1.2.0.");
const minVersionSchema = z.object({ android: semverField, ios: semverField });
type MinVersionValues = z.infer<typeof minVersionSchema>;
const minVersionValues = (s: MinVersion): MinVersionValues => ({ android: s.android, ios: s.ios });

function MinVersionCard({ setting, storeLinks }: { setting: MinVersion; storeLinks: StoreLinks }) {
  const state = useSettingForm("min_app_version", setting, minVersionValues, minVersionSchema);
  const { form } = state;
  const save = useApiMutation<MinVersion, MinVersionValues & { version: string }, MinVersionValues>({
    requiresReauth: true,
    reauthReason: "Mengubah versi aplikasi minimum",
    setError: form.setError,
    request: (v, ctx) =>
      api.PUT("/admin/settings/min-app-version", {
        params: { header: { "If-Match": v.version, "X-Reauth-Token": ctx.reauthToken ?? "" } },
        body: { android: v.android.trim(), ios: v.ios.trim() },
      }),
    onSuccess: (data) => {
      state.saved(data);
    },
    onReloadLatest: (error) => state.conflicted(error),
    successMessage: "Versi aplikasi minimum disimpan.",
  });
  const submit = form.handleSubmit((values) => {
    // PRD 8.4: versi minimum hanya dinaikkan setelah versi baru dapat diunduh dari toko.
    let blocked = false;
    for (const p of ["android", "ios"] as const) {
      if (compareSemver(values[p].trim(), state.base[p]) > 0 && !storeLinks[p]) {
        form.setError(
          p,
          {
            type: "manual",
            message: `Isi tautan toko ${PLATFORM_LABEL[p]} sebelum menaikkan versi minimum.`,
          },
          { shouldFocus: !blocked },
        );
        blocked = true;
      }
    }
    if (!blocked) save.mutate({ ...values, version: state.base.version });
  });
  return (
    <SettingCard
      id="pengaturan-versi"
      title="Versi aplikasi minimum"
      description="Perubahan dari aplikasi di bawah versi ini ditolak (wajib update) dan aplikasi menampilkan tautan toko (PRD 4.5). Naikkan hanya setelah versi baru tersedia di toko (PRD 8.4)."
      meta={state.base}
      conflict={state.conflict}
      onReloadLatest={state.reloadLatest}
      form={form}
      onSubmit={() => void submit()}
      saving={save.isPending}
      saveLabel="Simpan versi minimum"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {(["android", "ios"] as const).map((p) => (
          <FormField<MinVersionValues, typeof p>
            key={p}
            control={form.control}
            name={p}
            label={`Versi minimum ${PLATFORM_LABEL[p]}`}
            required
            hint={
              storeLinks[p] ? "Tautan toko terisi." : "Tautan toko belum diisi; versi belum dapat dinaikkan."
            }
          >
            {(field, a11y) => (
              <Input {...field} {...a11y} inputMode="decimal" placeholder="1.0.0" maxLength={32} />
            )}
          </FormField>
        ))}
      </div>
    </SettingCard>
  );
}

// ------------------------------------------------------------------------------------------------ Tautan toko

const storeLinksSchema = z.object({
  android: z
    .string()
    .trim()
    .max(500, "Tautan maksimal 500 karakter.")
    .refine(
      (v) => v === "" || /^https:\/\/play\.google\.com\//.test(v),
      "Gunakan tautan https://play.google.com/...",
    ),
  ios: z
    .string()
    .trim()
    .max(500, "Tautan maksimal 500 karakter.")
    .refine(
      (v) => v === "" || /^https:\/\/apps\.apple\.com\//.test(v),
      "Gunakan tautan https://apps.apple.com/...",
    ),
});
type StoreLinksValues = z.infer<typeof storeLinksSchema>;
const storeLinksValues = (s: StoreLinks): StoreLinksValues => ({
  android: s.android ?? "",
  ios: s.ios ?? "",
});

function StoreLinksCard({ setting }: { setting: StoreLinks }) {
  const state = useSettingForm("store_links", setting, storeLinksValues, storeLinksSchema);
  const { form } = state;
  const save = useApiMutation<StoreLinks, StoreLinksValues & { version: string }, StoreLinksValues>({
    requiresReauth: true,
    reauthReason: "Mengubah tautan toko aplikasi",
    setError: form.setError,
    request: (v, ctx) =>
      api.PUT("/admin/settings/store-links", {
        params: { header: { "If-Match": v.version, "X-Reauth-Token": ctx.reauthToken ?? "" } },
        body: { android: v.android.trim() || null, ios: v.ios.trim() || null },
      }),
    onSuccess: (data) => {
      state.saved(data);
    },
    onReloadLatest: (error) => state.conflicted(error),
    successMessage: "Tautan toko aplikasi disimpan.",
  });
  return (
    <SettingCard
      id="pengaturan-toko"
      title="Tautan toko aplikasi"
      description="Dipakai layar wajib update dan situs publik. Hanya tautan resmi Google Play dan App Store; kosongkan untuk menghapus (PRD 5.2)."
      meta={state.base}
      conflict={state.conflict}
      onReloadLatest={state.reloadLatest}
      form={form}
      onSubmit={() => void form.handleSubmit((v) => save.mutate({ ...v, version: state.base.version }))()}
      saving={save.isPending}
      saveLabel="Simpan tautan toko"
    >
      <FormField<StoreLinksValues, "android">
        control={form.control}
        name="android"
        label="Google Play (Android)"
      >
        {(field, a11y) => (
          <Input
            {...field}
            {...a11y}
            type="url"
            placeholder="https://play.google.com/store/apps/details?id=..."
          />
        )}
      </FormField>
      <FormField<StoreLinksValues, "ios"> control={form.control} name="ios" label="App Store (iOS)">
        {(field, a11y) => (
          <Input {...field} {...a11y} type="url" placeholder="https://apps.apple.com/id/app/..." />
        )}
      </FormField>
    </SettingCard>
  );
}

// ------------------------------------------------------------------------------------------------ Kontak dukungan

const supportSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email wajib diisi.")
    .max(254, "Email terlalu panjang.")
    .pipe(z.email({ error: "Format email tidak valid." })),
  whatsapp: z
    .string()
    .trim()
    .refine(
      (v) => v === "" || /^\+[1-9][0-9]{7,14}$/.test(v),
      "Gunakan format internasional, mis. +6281234567890.",
    ),
});
type SupportValues = z.infer<typeof supportSchema>;
const supportValues = (s: Support): SupportValues => ({ email: s.email, whatsapp: s.whatsapp ?? "" });

function SupportCard({ setting }: { setting: Support }) {
  const state = useSettingForm("support", setting, supportValues, supportSchema);
  const { form } = state;
  const save = useApiMutation<Support, SupportValues & { version: string }, SupportValues>({
    requiresReauth: true,
    reauthReason: "Mengubah kontak dukungan anggota",
    setError: form.setError,
    request: (v, ctx) =>
      api.PUT("/admin/settings/support", {
        params: { header: { "If-Match": v.version, "X-Reauth-Token": ctx.reauthToken ?? "" } },
        body: { email: v.email.trim(), whatsapp: v.whatsapp.trim() || null },
      }),
    onSuccess: (data) => {
      state.saved(data);
    },
    onReloadLatest: (error) => state.conflicted(error),
    successMessage: "Kontak dukungan disimpan.",
  });
  return (
    <SettingCard
      id="pengaturan-dukungan"
      title="Kontak dukungan"
      description="Tampil di aplikasi (Hubungi pengurus), portal pembatasan dan situs publik (PRD 8.3). Anggota dapat diarahkan ke kontak ini untuk urusan iuran."
      meta={state.base}
      conflict={state.conflict}
      onReloadLatest={state.reloadLatest}
      form={form}
      onSubmit={() => void form.handleSubmit((v) => save.mutate({ ...v, version: state.base.version }))()}
      saving={save.isPending}
      saveLabel="Simpan kontak dukungan"
    >
      <FormField<SupportValues, "email"> control={form.control} name="email" label="Email dukungan" required>
        {(field, a11y) => <Input {...field} {...a11y} type="email" autoComplete="off" />}
      </FormField>
      <FormField<SupportValues, "whatsapp">
        control={form.control}
        name="whatsapp"
        label="WhatsApp pengurus (opsional)"
        hint="Format internasional E.164, mis. +6281234567890. Kosongkan untuk menghapus."
      >
        {(field, a11y) => <Input {...field} {...a11y} type="tel" inputMode="tel" autoComplete="off" />}
      </FormField>
    </SettingCard>
  );
}

// ------------------------------------------------------------------------------------------------ Instruksi iuran (D13)

const instructionsSchema = z.object({
  android: z.boolean(),
  ios: z.boolean(),
  reason: z.string().max(500, "Catatan maksimal 500 karakter."),
});
type InstructionsValues = z.infer<typeof instructionsSchema>;
const instructionsValues = (s: PaymentInstructions): InstructionsValues => ({
  android: s.dues_hidden_platforms.includes("android"),
  ios: s.dues_hidden_platforms.includes("ios"),
  reason: "",
});

function PaymentInstructionsCard({ setting }: { setting: PaymentInstructions }) {
  const state = useSettingForm("payment_instructions", setting, instructionsValues, instructionsSchema);
  const { form } = state;
  const save = useApiMutation<
    PaymentInstructions,
    InstructionsValues & { version: string },
    InstructionsValues
  >({
    requiresReauth: true,
    reauthReason: "Mengubah instruksi bayar iuran per platform",
    setError: form.setError,
    request: (v, ctx) =>
      api.PUT("/admin/settings/payment-instructions", {
        params: { header: { "If-Match": v.version, "X-Reauth-Token": ctx.reauthToken ?? "" } },
        body: {
          dues_hidden_platforms: (["android", "ios"] as const).filter((p) => v[p]),
          ...(v.reason.trim() ? { reason: v.reason.trim() } : {}),
        },
      }),
    onSuccess: (data) => {
      state.saved(data);
    },
    onReloadLatest: (error) => state.conflicted(error),
    successMessage: "Pengaturan instruksi iuran disimpan.",
  });
  const hidden = state.base.dues_hidden_platforms;
  return (
    <SettingCard
      id="pengaturan-instruksi"
      title="Instruksi bayar iuran per platform"
      description="Rencana cadangan D13: bila review toko menolak alur iuran, sembunyikan rekening tujuan dan unggah bukti iuran di platform itu; pengurus mencatat iuran yang diverifikasi di luar aplikasi lewat Catat iuran di Verifikasi Pembayaran. Pembayaran tiket tidak terpengaruh."
      meta={state.base}
      conflict={state.conflict}
      onReloadLatest={state.reloadLatest}
      form={form}
      onSubmit={() => void form.handleSubmit((v) => save.mutate({ ...v, version: state.base.version }))()}
      saving={save.isPending}
      saveLabel="Simpan instruksi iuran"
    >
      <p className="text-sm">
        Saat ini:{" "}
        {hidden.length === 0
          ? "semua platform menampilkan instruksi iuran."
          : `disembunyikan di ${hidden.map((p) => PLATFORM_LABEL[p]).join(" dan ")}.`}
      </p>
      <RecordDuesNote hidden={hidden.length > 0} />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">Sembunyikan instruksi iuran di</legend>
        {(["android", "ios"] as const).map((p) => (
          <Checkbox
            key={p}
            label={PLATFORM_LABEL[p]}
            checked={form.watch(p)}
            onCheckedChange={(v) => form.setValue(p, v, { shouldDirty: true })}
          />
        ))}
      </fieldset>
      <FormField<InstructionsValues, "reason">
        control={form.control}
        name="reason"
        label="Catatan perubahan (opsional)"
        hint="Mis. hasil review App Store. Tercatat di audit."
      >
        {(field, a11y) => <Textarea {...field} {...a11y} rows={2} maxLength={500} />}
      </FormField>
    </SettingCard>
  );
}

/**
 * Jalur pencatatan iuran D13 (adminRecordPayment). Anggota di platform yang instruksinya disembunyikan tidak dapat
 * mengunggah bukti iuran, sehingga aktivasi dan perpanjangannya hanya dapat dicatat pengurus berizin payments.read +
 * payments.decide lewat "Catat iuran". Bila instruksi sedang disembunyikan, catatan ditampilkan sebagai peringatan.
 */
function RecordDuesNote({ hidden }: { hidden: boolean }) {
  const auth = useAuth();
  const canRecord = RECORD_PERMISSIONS.every((p) => auth.can(p));
  return (
    <div
      role="note"
      aria-label="Pencatatan iuran di luar aplikasi"
      className={cn(
        "flex flex-col gap-2 rounded-md p-3 text-sm",
        hidden ? "bg-warning-bg text-warning" : "bg-neutral-bg text-text-muted",
      )}
    >
      <p>
        Anggota di platform yang instruksinya disembunyikan tidak dapat mengunggah bukti iuran. Aktivasi dan
        perpanjangan mereka dicatat pengurus lewat Catat iuran di Verifikasi Pembayaran setelah dana
        dicocokkan dengan mutasi rekening penerima.
        {canRecord
          ? ""
          : " Pencatatan memerlukan izin melihat dan memutus pembayaran (payments.read dan payments.decide); pastikan ada pengurus dengan izin itu sebelum menyembunyikan instruksi."}
      </p>
      {canRecord ? (
        <Link
          to="/payments"
          search={{ tab: "verify", record: true }}
          className={cn(buttonClass({ variant: "outline", size: "sm" }), "self-start")}
        >
          Catat iuran
        </Link>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Kebijakan baca-saja

function PoliciesCard({ settings: s }: { settings: Settings }) {
  return (
    <Card aria-labelledby="pengaturan-kebijakan" className="flex flex-col gap-4 pb-5">
      <CardHeader
        titleId="pengaturan-kebijakan"
        title="Kebijakan yang disahkan PRD"
        description="Nilai ini hanya dapat dibaca; perubahannya melalui change request dan migrasi (D4, D5, D6, v3.2)."
      />
      <div className="flex flex-col gap-4 px-5">
        <KeyValueList
          items={[
            { label: "Periode keanggotaan", value: `${s.membership.period_months} bulan kalender per iuran` },
            {
              label: "Status hampir habis",
              value: `${s.membership.expiring_days} hari sebelum masa aktif berakhir`,
            },
            {
              label: "Jendela perpanjangan",
              value: `${s.membership.renewal_window_days} hari sebelum berakhir`,
            },
            { label: "Tahan kursi reservasi", value: `${s.events.hold_hours} jam` },
            { label: "Check-in dibuka", value: `${s.events.checkin_before_hours} jam sebelum acara` },
            { label: "Batal mandiri dengan refund penuh", value: `Sampai H-${s.events.self_cancel_days}` },
            {
              label: "Eskalasi bukti tiket",
              value: `${s.events.review_escalation_business_days} hari kerja`,
            },
            {
              label: "Panjang pesan chat",
              value: `${s.chat.max_text_chars.toLocaleString("id-ID")} karakter`,
            },
            { label: "Anggota grup chat", value: `Maksimal ${s.chat.max_group_members} orang` },
          ]}
        />
      </div>
    </Card>
  );
}
