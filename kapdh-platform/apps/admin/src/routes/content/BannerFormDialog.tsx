import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useController, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { toApiError } from "../../api/errors";
import { unwrap, useApiMutation } from "../../api/query";
import { Button } from "../../components/ui/Button";
import { Switch } from "../../components/ui/Choice";
import { Dialog } from "../../components/ui/Dialog";
import { DateTimeField } from "../../components/ui/FormatFields";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { useToast } from "../../components/ui/Toast";
import { requiredText } from "../../lib/validation";
import { BannerTargetField } from "./BannerTargetField";
import { ConflictNotice } from "./ConflictNotice";
import { ContentImageField } from "./ContentImageField";
import {
  type AdminBanner,
  type BannerTargetType,
  conflictCurrent,
  type ContentImage,
  invalidateContent,
  type S,
} from "./contentApi";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nilai formulir banner; nama field sama dengan kontrak agar `field_errors` server terpasang di tempatnya. */
export interface BannerFormValues {
  title: string;
  image_file_id: ContentImage | null;
  target_type: BannerTargetType;
  target_value: string | null;
  target_label: string | null;
  sort_order: string;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
}

export const bannerSchema = z
  .object({
    title: requiredText("Judul", 1, 120),
    image_file_id: z.object({ file_id: z.string(), url: z.string() }).nullable(),
    target_type: z.enum(["none", "post", "event", "page", "url"]),
    target_value: z.string().nullable(),
    target_label: z.string().nullable(),
    sort_order: z
      .string()
      .trim()
      .regex(/^\d{1,5}$/, "Urutan berupa angka 0 sampai 32767.")
      .refine((v) => Number(v) <= 32767, "Urutan berupa angka 0 sampai 32767."),
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    active: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (!v.image_file_id)
      ctx.addIssue({ code: "custom", path: ["image_file_id"], message: "Gambar banner wajib diunggah." });
    if (v.target_type !== "none" && !v.target_value)
      ctx.addIssue({ code: "custom", path: ["target_value"], message: "Pilih tujuan banner." });
    if (v.target_type === "url" && v.target_value) {
      let https = false;
      try {
        https = new URL(v.target_value).protocol === "https:";
      } catch {
        https = false;
      }
      if (!https)
        ctx.addIssue({
          code: "custom",
          path: ["target_value"],
          message: "Tautan luar harus diawali https://.",
        });
    }
    if (v.target_type === "event" && v.target_value && !UUID.test(v.target_value))
      ctx.addIssue({ code: "custom", path: ["target_value"], message: "ID event tidak valid." });
    if (!v.starts_at)
      ctx.addIssue({ code: "custom", path: ["starts_at"], message: "Tanggal mulai tayang wajib diisi." });
    if (v.starts_at && v.ends_at && Date.parse(v.ends_at) <= Date.parse(v.starts_at))
      ctx.addIssue({
        code: "custom",
        path: ["ends_at"],
        message: "Selesai tayang harus setelah mulai tayang.",
      });
  });

function toBannerForm(b: AdminBanner | null): BannerFormValues {
  return {
    title: b?.title ?? "",
    image_file_id: b?.image ?? null,
    target_type: b?.target.type ?? "none",
    target_value: b?.target.value ?? null,
    target_label: b ? (b.target.label ?? b.target.value) : null,
    sort_order: String(b?.sort_order ?? 0),
    starts_at: b?.starts_at ?? null,
    ends_at: b?.ends_at ?? null,
    active: b?.active ?? true,
  };
}

const sameInstant = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

/** Field yang berubah; tujuan selalu dikirim berpasangan (kontrak AdminBannerUpdateRequest). */
export function bannerChanges(v: BannerFormValues, base: AdminBanner): S["AdminBannerUpdateRequest"] {
  const out: S["AdminBannerUpdateRequest"] = {};
  if (v.title.trim() !== base.title) out.title = v.title.trim();
  if (v.image_file_id && v.image_file_id.file_id !== base.image.file_id)
    out.image_file_id = v.image_file_id.file_id;
  const value = v.target_type === "none" ? null : v.target_value;
  if (v.target_type !== base.target.type || value !== base.target.value) {
    out.target_type = v.target_type;
    out.target_value = value;
  }
  if (Number(v.sort_order) !== base.sort_order) out.sort_order = Number(v.sort_order);
  if (v.starts_at && !sameInstant(v.starts_at, base.starts_at)) out.starts_at = v.starts_at;
  if (!sameInstant(v.ends_at, base.ends_at)) out.ends_at = v.ends_at;
  if (v.active !== base.active) out.active = v.active;
  return out;
}

function createBody(v: BannerFormValues): S["AdminBannerCreateRequest"] {
  return {
    title: v.title.trim(),
    image_file_id: v.image_file_id!.file_id,
    target_type: v.target_type,
    target_value: v.target_type === "none" ? null : v.target_value,
    sort_order: Number(v.sort_order),
    starts_at: v.starts_at!,
    ends_at: v.ends_at,
    active: v.active,
  };
}

/**
 * Formulir banner (F-08, AC F08-2, F15-4): gambar, judul, tujuan tervalidasi, jendela tayang (WIB), urutan dan
 * status aktif. Banner baru memakai Idempotency-Key; perubahan mengirim field yang berubah dengan If-Match, dan
 * konflik versi ditawarkan muat ulang tanpa menimpa.
 */
export function BannerFormDialog({ banner, onClose }: { banner: AdminBanner | null; onClose: () => void }) {
  const formId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [base, setBase] = useState(banner);
  const [conflict, setConflict] = useState<{ latest: AdminBanner | null } | null>(null);
  const form = useForm<BannerFormValues>({
    resolver: zodResolver(bannerSchema),
    defaultValues: toBannerForm(banner),
  });
  const values = form.watch();
  const errors = form.formState.errors;
  const image = useController({ control: form.control, name: "image_file_id" });

  useEffect(() => {
    form.setFocus("title");
  }, [form]);

  const save = useApiMutation<AdminBanner, BannerFormValues, BannerFormValues>({
    intent: (v) => [base?.id ?? "new", base?.version, v],
    setError: form.setError,
    request: (v, ctx) =>
      base
        ? api.PATCH("/admin/content/banners/{bannerId}", {
            params: { path: { bannerId: base.id }, header: { "If-Match": base.version } },
            body: bannerChanges(v, base),
          })
        : api.POST("/admin/content/banners", {
            params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
            body: createBody(v),
          }),
    successMessage: (data) =>
      base ? `Banner "${data.title}" diperbarui.` : `Banner "${data.title}" dibuat.`,
    onSuccess: async () => {
      await invalidateContent(queryClient);
      onClose();
    },
    onReloadLatest: (error) => {
      if (base) setConflict({ latest: conflictCurrent<AdminBanner>(error, base.id) });
    },
  });

  async function reloadLatest() {
    if (!base) return;
    try {
      const latest =
        conflict?.latest ??
        (await unwrap(
          api.GET("/admin/content/banners/{bannerId}", { params: { path: { bannerId: base.id } } }),
        ));
      setConflict(null);
      setBase(latest);
      form.reset(toBannerForm(latest));
      void invalidateContent(queryClient);
      form.setFocus("title");
    } catch (e) {
      toast.error(toApiError(e).message);
    }
  }

  const unchanged = base !== null && Object.keys(bannerChanges(values, base)).length === 0;
  const fieldError = (name: string) =>
    (errors as Record<string, { message?: string } | undefined>)[name]?.message ?? null;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      dismissable={!save.isPending}
      title={base ? "Ubah banner" : "Buat banner"}
      description="Banner tampil di Beranda aplikasi selama aktif dan berada di dalam masa tayang."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Batal
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={save.isPending}
            loadingText="Menyimpan..."
            disabled={Boolean(conflict) || unchanged}
          >
            {base ? "Simpan perubahan" : "Buat banner"}
          </Button>
        </>
      }
    >
      {conflict ? (
        <ConflictNotice
          subject="Banner ini"
          updatedAt={conflict.latest?.updated_at}
          onReload={() => void reloadLatest()}
        />
      ) : null}
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit((v) => {
          if (conflict || unchanged) return;
          save.mutate(v);
        })}
      >
        <FormError message={errors.root?.server?.message} />
        <FormField<BannerFormValues, "title">
          control={form.control}
          name="title"
          label="Judul banner"
          required
          hint="Juga dibacakan sebagai label gambar oleh pembaca layar di aplikasi."
        >
          {(field, a11y) => <Input {...a11y} {...field} maxLength={120} autoComplete="off" />}
        </FormField>
        <ContentImageField
          purpose="banner_image"
          label="Gambar banner"
          required
          value={image.field.value}
          onChange={image.field.onChange}
          onBlur={image.field.onBlur}
          buttonRef={image.field.ref}
          error={image.fieldState.error?.message}
          previewAlt={`Gambar banner ${values.title || "baru"}`}
          hint="Disarankan rasio 16:9."
          disabled={save.isPending}
        />
        <BannerTargetField
          target={{ type: values.target_type, value: values.target_value, label: values.target_label }}
          onChange={(next) => {
            form.setValue("target_type", next.type, { shouldDirty: true });
            form.setValue("target_value", next.value, { shouldDirty: true });
            form.setValue("target_label", next.label, { shouldDirty: true });
            form.clearErrors(["target_type", "target_value"]);
          }}
          typeError={fieldError("target_type")}
          valueError={fieldError("target_value")}
          disabled={save.isPending}
        />
        <div className="flex flex-wrap gap-4">
          <FormField<BannerFormValues, "starts_at">
            control={form.control}
            name="starts_at"
            label="Mulai tayang"
            required
            className="flex-[1_1_220px]"
          >
            {(field, a11y) => (
              <DateTimeField
                {...a11y}
                ref={field.ref}
                name={field.name}
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
              />
            )}
          </FormField>
          <FormField<BannerFormValues, "ends_at">
            control={form.control}
            name="ends_at"
            label="Selesai tayang"
            hint="Kosongkan bila tanpa batas akhir."
            className="flex-[1_1_220px]"
          >
            {(field, a11y) => (
              <DateTimeField
                {...a11y}
                ref={field.ref}
                name={field.name}
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
                min={values.starts_at}
              />
            )}
          </FormField>
        </div>
        <FormField<BannerFormValues, "sort_order">
          control={form.control}
          name="sort_order"
          label="Urutan tampil"
          required
          hint="Angka kecil tampil lebih dahulu di Beranda."
          className="max-w-xs"
        >
          {(field, a11y) => <Input {...a11y} {...field} inputMode="numeric" maxLength={5} />}
        </FormField>
        <Switch
          label="Aktif"
          description="Nonaktifkan untuk menyembunyikan banner sementara tanpa menghapusnya."
          checked={values.active}
          onCheckedChange={(v) => form.setValue("active", v, { shouldDirty: true })}
        />
      </form>
    </Dialog>
  );
}
