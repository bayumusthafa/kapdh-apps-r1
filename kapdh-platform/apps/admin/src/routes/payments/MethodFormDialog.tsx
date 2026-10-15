import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { useApiMutation } from "../../api/query";
import { Button } from "../../components/ui/Button";
import { RadioGroup, Switch } from "../../components/ui/Choice";
import { Dialog } from "../../components/ui/Dialog";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input, Textarea } from "../../components/ui/Input";
import { requiredText } from "../../lib/validation";
import { METHOD_KIND_LABEL } from "./labels";
import { METHODS_KEY } from "./queries";

type Method = components["schemas"]["AdminPaymentMethod"];
type MethodKind = components["schemas"]["PaymentMethodKind"];

export const INSTRUCTIONS_MAX = 1000;

const schema = z.object({
  kind: z.enum(["bank", "ewallet"], { error: "Pilih jenis rekening." }),
  provider: requiredText("Nama bank atau e-wallet", 1, 80),
  account_number: requiredText("Nomor rekening", 1, 64),
  account_holder: requiredText("Nama pemilik rekening", 1, 120),
  instructions: z
    .string()
    .max(INSTRUCTIONS_MAX, `Petunjuk maksimal ${INSTRUCTIONS_MAX} karakter.`)
    .refine((v) => !/<[^>]*>/.test(v), "Petunjuk berupa teks polos tanpa HTML."),
  active: z.boolean(),
  sort_order: z
    .number({ error: "Urutan tampil wajib berupa angka 0 sampai 32767." })
    .int("Urutan tampil berupa bilangan bulat.")
    .min(0, "Urutan tampil minimal 0.")
    .max(32767, "Urutan tampil maksimal 32767."),
});

type Values = z.infer<typeof schema>;

function valuesOf(m: Method | null, nextSortOrder: number): Values {
  return m
    ? {
        kind: m.kind,
        provider: m.provider,
        account_number: m.account_number,
        account_holder: m.account_holder,
        instructions: m.instructions ?? "",
        active: m.active,
        sort_order: m.sort_order,
      }
    : {
        kind: "bank",
        provider: "",
        account_number: "",
        account_holder: "",
        instructions: "",
        active: true,
        sort_order: nextSortOrder,
      };
}

interface SaveVars {
  values: Values;
  /** Versi yang dibaca untuk If-Match; tidak ada untuk metode baru. */
  version: string | null;
}

/** Body permintaan sesuai yang dikirim ke server (teks dipangkas, petunjuk kosong = null). */
function requestBody(v: Values) {
  const instructions = v.instructions.trim();
  return {
    kind: v.kind,
    provider: v.provider.trim(),
    account_number: v.account_number.trim(),
    account_holder: v.account_holder.trim(),
    instructions: instructions === "" ? null : instructions,
    active: v.active,
    sort_order: v.sort_order,
  };
}

/**
 * Isian sama persis dengan versi dasar: menyimpan tidak mengubah apa pun, sehingga tidak boleh membuat versi dan
 * entri audit baru tanpa perubahan (AC F15-3).
 */
function sameAsBase(v: Values, base: Method): boolean {
  const body = requestBody(v);
  return (
    body.kind === base.kind &&
    body.provider === base.provider &&
    body.account_number === base.account_number &&
    body.account_holder === base.account_holder &&
    body.instructions === (base.instructions ?? null) &&
    body.active === base.active &&
    body.sort_order === base.sort_order
  );
}

/**
 * Tambah/ubah rekening tujuan transfer (F-15, AC F15-3, F15-4, D13). Rekening menentukan ke mana anggota
 * mentransfer dana, sehingga setiap penyimpanan diaudit server; reautentikasi tidak diminta (keputusan PO
 * 2026-10-15, ADR-025: reautentikasi hanya untuk tindakan kredensial).
 * - Metode yang sudah dipakai payment (`in_use`): jenis, penyedia, nomor dan nama pemilik terkunci; hanya
 *   petunjuk, status aktif dan urutan yang dapat diubah. Untuk rekening baru: nonaktifkan lalu buat metode baru,
 *   agar snapshot pada tagihan lama tidak pernah berbeda diam-diam dari rekening yang berlaku.
 * - Konflik versi (admin lain menyimpan lebih dulu): perubahan tidak dikirim ulang; versi terbaru ditampilkan dan
 *   admin memilih "Muat versi terbaru" sebelum menyimpan lagi (AC F15-4).
 */
export function MethodFormDialog({
  open,
  method,
  nextSortOrder,
  onClose,
}: {
  open: boolean;
  /** null = metode baru. */
  method: Method | null;
  nextSortOrder: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  /** Versi dasar formulir (berubah saat admin memuat versi terbaru setelah konflik). */
  const [base, setBase] = useState<Method | null>(method);
  const [conflict, setConflict] = useState<Method | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: valuesOf(method, nextSortOrder),
  });
  const { reset } = form;

  useEffect(() => {
    if (!open) return;
    setBase(method);
    setConflict(null);
    reset(valuesOf(method, nextSortOrder));
  }, [open, method, nextSortOrder, reset]);

  const editing = base !== null;
  const locked = base?.in_use ?? false;

  const save = useApiMutation<Method, SaveVars, Values>({
    setError: form.setError,
    successMessage: editing ? "Metode pembayaran diperbarui." : "Metode pembayaran ditambahkan.",
    request: (v, ctx) => {
      const body = requestBody(v.values);
      if (v.version === null || !base)
        return api.POST("/admin/payment-methods", {
          params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
          body,
        });
      return api.PUT("/admin/payment-methods/{methodId}", {
        params: { path: { methodId: base.id }, header: { "If-Match": v.version } },
        body,
      });
    },
    onReloadLatest: (error) => {
      const current = asMethod(error.current);
      if (current) setConflict(current);
      void queryClient.invalidateQueries({ queryKey: METHODS_KEY });
    },
    onError: (error) => {
      // Metode dihapus admin lain saat formulir terbuka: tutup dan muat ulang daftar.
      if (error.code === "NOT_FOUND") {
        void queryClient.invalidateQueries({ queryKey: METHODS_KEY });
        onClose();
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      onClose();
    },
  });

  function reloadLatest() {
    if (!conflict) return;
    setBase(conflict);
    reset(valuesOf(conflict, nextSortOrder));
    setConflict(null);
  }

  const watched = form.watch();
  const kind = watched.kind;
  const active = watched.active;
  // Ubah tanpa perubahan apa pun: Simpan nonaktif (seperti tab Biaya), tidak ada PUT.
  const unchanged = base !== null && sameAsBase(watched, base);
  const errors = form.formState.errors;

  function submit(values: Values) {
    if (base !== null && sameAsBase(values, base)) return;
    save.mutate({ values, version: base?.version ?? null });
  }
  const kindOptions: { value: MethodKind; label: string; disabled: boolean }[] = (
    ["bank", "ewallet"] as const
  ).map((k) => ({ value: k, label: METHOD_KIND_LABEL[k], disabled: locked }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!save.isPending}
      title={editing ? "Ubah metode pembayaran" : "Tambah metode pembayaran"}
      description="Rekening tujuan transfer milik organisasi yang ditampilkan ke alumni. Penyimpanan tercatat di audit."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Batal
          </Button>
          <Button
            type="submit"
            form="metode-bayar"
            loading={save.isPending}
            loadingText="Menyimpan..."
            disabled={conflict !== null || unchanged}
          >
            Simpan metode
          </Button>
        </>
      }
    >
      {conflict ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning-bg p-3 text-sm"
        >
          <p className="flex items-start gap-2 font-semibold text-warning">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            Metode ini sudah diubah admin lain. Perubahan Anda belum disimpan.
          </p>
          <p className="text-text">
            Versi terbaru: {METHOD_KIND_LABEL[conflict.kind]} {conflict.provider}, {conflict.account_number}{" "}
            a.n. {conflict.account_holder}, {conflict.active ? "aktif" : "nonaktif"}, urutan{" "}
            {conflict.sort_order}.
          </p>
          <div>
            <Button size="sm" variant="outline" onClick={reloadLatest}>
              Muat versi terbaru
            </Button>
          </div>
        </div>
      ) : null}
      <FormProvider {...form}>
        <form
          id="metode-bayar"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(submit)}
        >
          <FormError message={errors.root?.server?.message} />
          {locked ? (
            <p role="note" className="rounded-md bg-info-bg p-3 text-sm text-info">
              Metode ini sudah dipakai pembayaran sehingga jenis, penyedia, nomor dan nama pemilik rekening
              tidak dapat diubah. Untuk rekening baru, nonaktifkan metode ini lalu tambah metode baru.
            </p>
          ) : null}
          <RadioGroup<MethodKind>
            legend="Jenis rekening"
            value={kind}
            onValueChange={(v) => form.setValue("kind", v, { shouldDirty: true })}
            options={kindOptions}
            orientation="horizontal"
            error={errors.kind?.message}
            required
          />
          <FormField<Values, "provider"> name="provider" label="Nama bank atau e-wallet" required>
            {(field, a11y) => <Input {...field} {...a11y} maxLength={80} disabled={locked} />}
          </FormField>
          <FormField<Values, "account_number"> name="account_number" label="Nomor rekening" required>
            {(field, a11y) => (
              <Input
                {...field}
                {...a11y}
                maxLength={64}
                disabled={locked}
                autoComplete="off"
                inputMode="text"
              />
            )}
          </FormField>
          <FormField<Values, "account_holder"> name="account_holder" label="Nama pemilik rekening" required>
            {(field, a11y) => <Input {...field} {...a11y} maxLength={120} disabled={locked} />}
          </FormField>
          <FormField<Values, "instructions">
            name="instructions"
            label="Petunjuk tambahan"
            hint="Teks polos tanpa HTML, mis. kode bank untuk transfer antarbank."
          >
            {(field, a11y) => (
              <Textarea {...field} {...a11y} rows={3} maxLength={INSTRUCTIONS_MAX} showCount />
            )}
          </FormField>
          <FormField<Values, "sort_order">
            name="sort_order"
            label="Urutan tampil"
            hint="Angka kecil tampil lebih dahulu di aplikasi."
            required
          >
            {(field, a11y) => (
              <Input
                {...a11y}
                ref={field.ref}
                name={field.name}
                onBlur={field.onBlur}
                type="number"
                min={0}
                max={32767}
                step={1}
                inputMode="numeric"
                value={Number.isNaN(field.value) ? "" : field.value}
                onChange={(e) => field.onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
              />
            )}
          </FormField>
          <Switch
            label="Tampilkan ke alumni"
            description="Metode nonaktif tidak dapat dipilih untuk pembayaran baru; tagihan lama tetap memakai snapshot-nya."
            checked={active}
            onCheckedChange={(v) => form.setValue("active", v, { shouldDirty: true })}
          />
        </form>
      </FormProvider>
    </Dialog>
  );
}

/** `current` pada 409 berbentuk AdminPaymentMethod (kontrak adminUpdatePaymentMethod). */
function asMethod(value: unknown): Method | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Partial<Method>;
  return typeof v.id === "string" && typeof v.version === "string" && typeof v.provider === "string"
    ? (value as Method)
    : null;
}
