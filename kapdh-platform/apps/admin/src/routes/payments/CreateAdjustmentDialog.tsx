import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { useApiMutation } from "../../api/query";
import { Button } from "../../components/ui/Button";
import { Checkbox, RadioGroup } from "../../components/ui/Choice";
import { Dialog } from "../../components/ui/Dialog";
import { FileUpload } from "../../components/ui/Files";
import { MoneyField } from "../../components/ui/FormatFields";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input, Textarea } from "../../components/ui/Input";
import { formatRupiah } from "../../lib/format";
import { moneySchema, requiredText } from "../../lib/validation";
import { compareMoney, subtractMoney, sumMoney } from "./money";
import { invalidateAdjustments } from "./queries";

type Detail = components["schemas"]["AdminPaymentDetail"];
type Adjustment = components["schemas"]["AdminPaymentAdjustment"];
type AdjustmentKind = components["schemas"]["PaymentAdjustmentKind"];
type FileRef = components["schemas"]["FileRef"];

export const ADJUSTMENT_REASON_MAX = 500;

/** Sisa nominal yang masih dapat direfund: nominal payment dikurangi refund pending dan selesai (D6). */
export function refundableRemaining(p: Pick<Detail, "amount" | "adjustments">): string {
  const used = sumMoney(
    p.adjustments.filter((a) => a.kind === "refund" && a.status !== "cancelled").map((a) => a.amount),
  );
  return subtractMoney(p.amount, used) ?? "0.00";
}

const destinationSchema = z.object({
  provider: z.string().max(80, "Maksimal 80 karakter."),
  account_number: z.string().max(64, "Maksimal 64 karakter."),
  account_holder: z.string().max(120, "Maksimal 120 karakter."),
});

/** Formulir penyesuaian; batas refund dihitung dari sisa nominal (server tetap memeriksa ulang dengan kunci). */
function schemaFor(remaining: string) {
  return z
    .object({
      kind: z.enum(["refund", "correction"]),
      amount: moneySchema,
      reason: requiredText("Alasan", 3, ADJUSTMENT_REASON_MAX),
      with_destination: z.boolean(),
      refund_destination: destinationSchema,
      evidence_file_id: z.string().nullable(),
    })
    .superRefine((v, ctx) => {
      if (v.kind !== "refund") return;
      if (compareMoney(v.amount, "0.00") === 0)
        ctx.addIssue({ code: "custom", path: ["amount"], message: "Nominal refund harus lebih dari 0." });
      if (compareMoney(v.amount, remaining) === 1)
        ctx.addIssue({
          code: "custom",
          path: ["amount"],
          message: `Melebihi sisa yang dapat direfund (${formatRupiah(remaining)}).`,
        });
      if (!v.with_destination) return;
      const labels = {
        provider: "Nama bank atau e-wallet",
        account_number: "Nomor rekening",
        account_holder: "Nama pemilik rekening",
      } as const;
      for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
        if (v.refund_destination[key].trim() === "")
          ctx.addIssue({
            code: "custom",
            path: ["refund_destination", key],
            message: `${labels[key]} wajib diisi.`,
          });
      }
    });
}

type Values = z.infer<ReturnType<typeof schemaFor>>;

const EMPTY_DESTINATION = { provider: "", account_number: "", account_holder: "" };

/**
 * Catat refund atau koreksi atas payment paid tanpa mengubah payment asal (PRD 3.4, 4.3, D6; ARCHITECTURE §2
 * butir 13). Refund: nominal > 0 dan total refund tidak melebihi nominal payment; pemilik diberi notifikasi untuk
 * mengirim rekening tujuan lewat aplikasi. Rekening yang diterima bendahara lewat kontak dukungan resmi dapat
 * dicatat di sini (cadangan, D6) dan hanya disimpan selama proses refund (D2).
 */
export function CreateAdjustmentDialog({
  open,
  payment,
  onClose,
  onCreated,
  onConflict,
}: {
  open: boolean;
  payment: Detail;
  onClose: () => void;
  onCreated: (adjustment: Adjustment, message: string) => void;
  /** Payment tidak lagi paid (409): data terbaru dimuat ulang. */
  onConflict: () => void;
}) {
  const queryClient = useQueryClient();
  const remaining = refundableRemaining(payment);
  const schema = useMemo(() => schemaFor(remaining), [remaining]);
  const [evidence, setEvidence] = useState<FileRef | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      kind: "refund",
      amount: "",
      reason: "",
      with_destination: false,
      refund_destination: EMPTY_DESTINATION,
      evidence_file_id: null,
    },
  });
  const kind = form.watch("kind");
  const withDestination = form.watch("with_destination");

  // Setiap kali dibuka formulir mulai dari awal (niat baru, Idempotency-Key baru).
  const { reset } = form;
  useEffect(() => {
    if (open) {
      reset();
      setEvidence(null);
    }
  }, [open, reset]);

  const create = useApiMutation<Adjustment, Values, Values>({
    setError: form.setError,
    request: (v, ctx) =>
      api.POST("/admin/payments/{paymentId}/adjustments", {
        params: { path: { paymentId: payment.id }, header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: {
          kind: v.kind,
          amount: v.amount,
          reason: v.reason,
          ...(v.kind === "refund" && v.with_destination
            ? {
                refund_destination: {
                  provider: v.refund_destination.provider.trim(),
                  account_number: v.refund_destination.account_number.trim(),
                  account_holder: v.refund_destination.account_holder.trim(),
                },
              }
            : {}),
          ...(v.evidence_file_id ? { evidence_file_id: v.evidence_file_id } : {}),
        },
      }),
    onReloadLatest: () => {
      onClose();
      onConflict();
    },
    onSuccess: (adjustment) => {
      invalidateAdjustments(queryClient, payment.id);
      onCreated(adjustment, createdMessage(adjustment, payment));
      onClose();
    },
  });

  const errors = form.formState.errors;
  const kindOptions: { value: AdjustmentKind; label: string; description: string }[] = [
    {
      value: "refund",
      label: "Refund",
      description: `Pengembalian dana ke pemilik, tenggat 7 hari kerja (D6). Sisa yang dapat direfund ${formatRupiah(remaining)}.`,
    },
    {
      value: "correction",
      label: "Koreksi",
      description: "Catatan keuangan administratif; status lunas dan nominal pembayaran tidak berubah.",
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!create.isPending}
      title="Catat penyesuaian"
      description={`Pembayaran ${formatRupiah(payment.amount)} tetap berstatus lunas; penyesuaian dicatat terpisah dan diaudit.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            Batal
          </Button>
          <Button type="submit" form="buat-penyesuaian" loading={create.isPending} loadingText="Menyimpan...">
            Simpan penyesuaian
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id="buat-penyesuaian"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit((v) => create.mutate(v))}
        >
          <FormError message={errors.root?.server?.message} />
          <RadioGroup<AdjustmentKind>
            legend="Jenis penyesuaian"
            value={kind}
            onValueChange={(v) => form.setValue("kind", v, { shouldDirty: true })}
            options={kindOptions}
            variant="card"
            error={errors.kind?.message}
            required
          />
          <FormField<Values, "amount"> name="amount" label="Nominal" required>
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
          <FormField<Values, "reason">
            name="reason"
            label="Alasan (internal pengurus)"
            hint="Tidak dikirim kepada anggota. Contoh: event dibatalkan, kelebihan transfer."
            required
          >
            {(field, a11y) => (
              <Textarea {...field} {...a11y} rows={3} maxLength={ADJUSTMENT_REASON_MAX} showCount />
            )}
          </FormField>
          {kind === "refund" ? (
            <>
              <Checkbox
                label="Catat rekening tujuan yang diterima lewat kontak dukungan resmi"
                description={
                  payment.member
                    ? "Biasanya pemilik mengirim rekening sendiri lewat aplikasi setelah diberi notifikasi."
                    : "Akun pemilik sudah dihapus: gunakan rekening pengirim yang terlihat di mutasi."
                }
                checked={withDestination}
                onCheckedChange={(v) => form.setValue("with_destination", v)}
              />
              {withDestination ? <DestinationFields /> : null}
            </>
          ) : null}
          <FileUpload
            purpose="adjustment_evidence"
            label="Bukti pendukung (opsional)"
            hint="Bukti transfer refund dapat juga dilampirkan saat menandai selesai."
            value={evidence}
            onChange={(f) => {
              setEvidence(f);
              form.setValue("evidence_file_id", f?.id ?? null);
            }}
            error={errors.evidence_file_id?.message}
            previewAlt="Pratinjau bukti penyesuaian"
          />
        </form>
      </FormProvider>
    </Dialog>
  );
}

/** Isian rekening tujuan refund (data sensitif: tidak pernah dicatat di audit, ARCHITECTURE §2 butir 3). */
export function DestinationFields() {
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-divider p-3">
      <legend className="px-1 text-sm font-medium">Rekening tujuan refund</legend>
      <FormField<{ refund_destination: typeof EMPTY_DESTINATION }, "refund_destination.provider">
        name="refund_destination.provider"
        label="Nama bank atau e-wallet"
        required
      >
        {(field, a11y) => <Input {...field} {...a11y} maxLength={80} autoComplete="off" />}
      </FormField>
      <FormField<{ refund_destination: typeof EMPTY_DESTINATION }, "refund_destination.account_number">
        name="refund_destination.account_number"
        label="Nomor rekening"
        required
      >
        {(field, a11y) => <Input {...field} {...a11y} maxLength={64} autoComplete="off" />}
      </FormField>
      <FormField<{ refund_destination: typeof EMPTY_DESTINATION }, "refund_destination.account_holder">
        name="refund_destination.account_holder"
        label="Nama pemilik rekening"
        required
      >
        {(field, a11y) => <Input {...field} {...a11y} maxLength={120} autoComplete="off" />}
      </FormField>
    </fieldset>
  );
}

function createdMessage(a: Adjustment, p: Pick<Detail, "member">): string {
  if (a.kind === "correction") return "Koreksi dicatat tanpa mengubah status lunas.";
  if (!p.member) return "Refund dicatat. Akun pemilik sudah dihapus sehingga tidak ada notifikasi.";
  return a.has_refund_destination
    ? "Refund dicatat beserta rekening tujuan. Pemilik diberi notifikasi."
    : "Refund dicatat. Pemilik diberi notifikasi untuk mengirim rekening tujuan.";
}
