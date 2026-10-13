import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Info, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { useApiMutation, useApiQuery } from "../../api/query";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { KeyValueList } from "../../components/ui/DataDisplay";
import { MoneyField } from "../../components/ui/FormatFields";
import { FormError, FormField } from "../../components/ui/FormField";
import { Textarea } from "../../components/ui/Input";
import { ErrorState, Loading } from "../../components/ui/States";
import { formatDateTime, formatRupiah } from "../../lib/format";
import { moneySchema } from "../../lib/validation";
import { addMoney, compareMoney } from "./money";
import { FEES_KEY } from "./queries";

type Fees = components["schemas"]["FeeSettings"];

export const FEE_REASON_MAX = 500;

const schema = z.object({
  registration_fee: moneySchema,
  card_fee: moneySchema,
  renewal_fee: moneySchema,
  reason: z.string().max(FEE_REASON_MAX, `Catatan maksimal ${FEE_REASON_MAX} karakter.`),
});
type Values = z.infer<typeof schema>;

function valuesOf(f: Fees): Values {
  return {
    registration_fee: f.registration_fee,
    card_fee: f.card_fee,
    renewal_fee: f.renewal_fee,
    reason: "",
  };
}

/** Komponen biaya sama persis dengan versi tertentu (tanpa memandang catatan). */
function sameAmounts(v: Pick<Values, "registration_fee" | "card_fee" | "renewal_fee">, f: Fees): boolean {
  return (
    compareMoney(v.registration_fee, f.registration_fee) === 0 &&
    compareMoney(v.card_fee, f.card_fee) === 0 &&
    compareMoney(v.renewal_fee, f.renewal_fee) === 0
  );
}

/**
 * Tab Biaya Pembayaran (guidelines hlm. 17, PRD 3.3, D4): komponen iuran register alumni baru, pembuatan KTA dan
 * perpanjangan per tahun. Nominal baru menjadi versi `fees` berikutnya dan HANYA berlaku untuk tagihan yang
 * dibuat sesudahnya; tagihan lama tetap memakai snapshot dan versi biayanya (AC F03-5, F15-3). Penyimpanan meminta
 * reautentikasi dan memakai If-Match versi yang dibaca; bila admin lain menyimpan lebih dulu, versi terbaru
 * ditampilkan dan admin memilih memuat ulang, bukan menimpa diam-diam (AC F15-4).
 */
export function FeesTab() {
  const fees = useApiQuery({
    queryKey: FEES_KEY,
    request: ({ signal, headers }) => api.GET("/admin/settings/fees", { signal, headers }),
  });
  if (fees.isPending)
    return (
      <Card className="p-2">
        <Loading label="Memuat biaya pembayaran..." rows={5} />
      </Card>
    );
  if (fees.isError)
    return (
      <Card>
        <ErrorState error={fees.error} onRetry={() => void fees.refetch()} title="Biaya gagal dimuat" />
      </Card>
    );
  return <FeesEditor latest={fees.data} />;
}

function FeesEditor({ latest }: { latest: Fees }) {
  const queryClient = useQueryClient();
  /** Versi yang menjadi dasar formulir (If-Match). */
  const [base, setBase] = useState<Fees>(latest);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: valuesOf(latest) });
  const { reset } = form;
  const dirty = form.formState.isDirty;

  // Versi baru dari server (muat ulang/admin lain) diterapkan langsung bila admin belum mengubah apa pun; bila
  // sedang mengubah, formulir tidak ditimpa dan peringatan konflik ditampilkan (AC F15-4).
  const outdated = latest.version !== base.version;
  useEffect(() => {
    if (outdated && !dirty) {
      setBase(latest);
      reset(valuesOf(latest));
    }
  }, [outdated, dirty, latest, reset]);
  const conflict = outdated && dirty;

  const save = useApiMutation<Fees, { values: Values; version: string }, Values>({
    requiresReauth: true,
    reauthReason: "Mengubah biaya iuran",
    setError: form.setError,
    request: (v, ctx) =>
      api.PUT("/admin/settings/fees", {
        params: { header: { "If-Match": v.version, "X-Reauth-Token": ctx.reauthToken ?? "" } },
        body: {
          registration_fee: v.values.registration_fee,
          card_fee: v.values.card_fee,
          renewal_fee: v.values.renewal_fee,
          ...(v.values.reason.trim() ? { reason: v.values.reason.trim() } : {}),
        },
      }),
    successMessage: (f) =>
      `Biaya versi ${f.version} disimpan. Berlaku untuk tagihan yang dibuat mulai sekarang.`,
    onReloadLatest: (error) => {
      const current = asFees(error.current);
      if (current) queryClient.setQueryData(FEES_KEY, current);
      else void queryClient.invalidateQueries({ queryKey: FEES_KEY });
    },
    onSuccess: (f) => {
      queryClient.setQueryData(FEES_KEY, f);
      setBase(f);
      reset(valuesOf(f));
    },
  });

  function reloadLatest() {
    setBase(latest);
    reset(valuesOf(latest));
  }

  const watched = form.watch();
  const newTotal = addMoney(watched.registration_fee, watched.card_fee);
  const unchanged = sameAmounts(watched, base);
  const errors = form.formState.errors;

  return (
    <div className="flex flex-wrap items-start gap-5">
      <Card aria-labelledby="biaya-aktif" className="flex min-w-0 flex-[1_1_320px] flex-col gap-4 pb-5">
        <CardHeader
          titleId="biaya-aktif"
          title="Biaya aktif"
          description={`Versi ${latest.version}, berlaku sejak ${formatDateTime(latest.effective_from)}`}
        />
        <div className="px-5">
          <KeyValueList
            items={[
              { label: "Register alumni baru", value: formatRupiah(latest.registration_fee) },
              { label: "Pembuatan KTA", value: formatRupiah(latest.card_fee) },
              {
                label: "Total iuran pendaftaran",
                value: <span className="font-semibold">{formatRupiah(latest.registration_total)}</span>,
              },
              { label: "Perpanjangan KTA per tahun", value: formatRupiah(latest.renewal_fee) },
              {
                label: "Ditetapkan oleh",
                value: latest.updated_by ? latest.updated_by.display_name : "Nilai awal go-live (D4)",
                wide: true,
              },
            ]}
          />
        </div>
        <p role="note" className="mx-5 flex items-start gap-2 rounded-md bg-info-bg p-3 text-sm text-info">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            Perubahan biaya hanya berlaku untuk tagihan yang dibuat setelah disimpan. Tagihan yang sudah
            dibuat, termasuk yang sedang menunggu verifikasi, tetap memakai nominal dan versi biaya saat
            tagihan dibuat.
          </span>
        </p>
      </Card>

      <Card aria-labelledby="ubah-biaya" className="flex min-w-0 flex-[1_1_360px] flex-col gap-4 pb-5">
        <CardHeader
          titleId="ubah-biaya"
          title="Ubah biaya"
          description="Penyimpanan meminta konfirmasi identitas dan tercatat di audit."
        />
        <FormProvider {...form}>
          <form
            noValidate
            className="flex flex-col gap-4 px-5"
            onSubmit={form.handleSubmit((values) => save.mutate({ values, version: base.version }))}
          >
            {conflict ? (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning-bg p-3 text-sm"
              >
                <p className="flex items-start gap-2 font-semibold text-warning">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  Biaya sudah diubah admin lain (versi {latest.version}). Perubahan Anda belum disimpan.
                </p>
                <p className="text-text">
                  Versi terbaru: register {formatRupiah(latest.registration_fee)}, KTA{" "}
                  {formatRupiah(latest.card_fee)}, perpanjangan {formatRupiah(latest.renewal_fee)}.
                </p>
                <div>
                  <Button size="sm" variant="outline" onClick={reloadLatest}>
                    Muat versi terbaru
                  </Button>
                </div>
              </div>
            ) : null}
            <FormError message={errors.root?.server?.message} />
            <MoneyFormField name="registration_fee" label="Register alumni baru" />
            <MoneyFormField name="card_fee" label="Pembuatan KTA" />
            <MoneyFormField name="renewal_fee" label="Perpanjangan KTA per tahun" />
            <p className="text-sm" aria-live="polite">
              Total iuran pendaftaran baru:{" "}
              <span className="font-semibold">{newTotal ? formatRupiah(newTotal) : "-"}</span>
            </p>
            <FormField<Values, "reason">
              name="reason"
              label="Catatan perubahan"
              hint="Opsional, untuk audit. Contoh: keputusan rapat pengurus."
            >
              {(field, a11y) => (
                <Textarea {...field} {...a11y} rows={2} maxLength={FEE_REASON_MAX} showCount />
              )}
            </FormField>
            <div className="flex flex-wrap justify-end gap-3">
              <Button
                variant="outline"
                disabled={!dirty || save.isPending}
                onClick={() => reset(valuesOf(base))}
              >
                Batalkan perubahan
              </Button>
              <Button
                type="submit"
                loading={save.isPending}
                loadingText="Menyimpan..."
                disabled={conflict || unchanged}
              >
                Simpan biaya baru
              </Button>
            </div>
          </form>
        </FormProvider>
      </Card>
    </div>
  );
}

function MoneyFormField({
  name,
  label,
}: {
  name: "registration_fee" | "card_fee" | "renewal_fee";
  label: string;
}) {
  return (
    <FormField<Values, typeof name> name={name} label={label} required>
      {(field, a11y) => (
        <MoneyField
          {...a11y}
          name={field.name}
          ref={field.ref}
          value={field.value}
          onValueChange={field.onChange}
          onBlur={field.onBlur}
        />
      )}
    </FormField>
  );
}

/** `current` pada 409 berbentuk FeeSettings (kontrak adminUpdateFees). */
function asFees(value: unknown): Fees | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Partial<Fees>;
  return typeof v.version === "string" && typeof v.registration_fee === "string" ? (value as Fees) : null;
}
