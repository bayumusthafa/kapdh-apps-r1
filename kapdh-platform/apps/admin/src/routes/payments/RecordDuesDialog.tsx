import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { membershipLabelFor } from "@kapdh/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { unwrap, useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { MembershipStatusBadge, PaymentStageBadge } from "../../components/ui/Badge";
import { Button, buttonClass } from "../../components/ui/Button";
import { Checkbox, RadioGroup } from "../../components/ui/Choice";
import { Combobox, type ComboboxOption } from "../../components/ui/Combobox";
import { Dialog } from "../../components/ui/Dialog";
import { FileUpload } from "../../components/ui/Files";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input, Textarea } from "../../components/ui/Input";
import { ErrorState, Loading } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { formatDate, formatDateTime, formatRupiah } from "../../lib/format";
import { PAYMENT_TYPE_LABEL } from "../../lib/labels";
import { requiredText } from "../../lib/validation";
import { memberKeys } from "../members/queries";
import { METHOD_KIND_LABEL } from "./labels";
import { FEES_KEY, METHODS_KEY, PAYMENTS_KEY, paymentDetailKey } from "./queries";
import { DUES_TYPES, duesUnavailableReason, feesUnconfigured, recordBlockReason } from "./recordEligibility";

type S = components["schemas"];
type Detail = S["AdminPaymentDetail"];
type MemberDetail = S["AdminMemberDetail"];
type DuesType = S["MembershipPaymentType"];
type FileRef = S["FileRef"];
type RecordBody = S["AdminRecordPaymentRequest"];

export const RECORD_REASON_MAX = 500;
export const TRANSFER_NOTE_MAX = 200;

const schema = z.object({
  user_id: z.string().min(1, "Pilih alumni pemilik iuran."),
  type: z
    .enum(["registration", "renewal"])
    .nullable()
    .refine((v) => Boolean(v), { message: "Pilih jenis iuran." }),
  payment_method_id: z
    .string()
    .nullable()
    .refine((v) => Boolean(v), { message: "Pilih rekening penerima dana." }),
  proof_file_id: z
    .string()
    .nullable()
    .refine((v) => Boolean(v), { message: "Unggah bukti verifikasi dana." }),
  transfer_note: z
    .string()
    .max(TRANSFER_NOTE_MAX, `Catatan transfer maksimal ${TRANSFER_NOTE_MAX} karakter.`),
  funds_verified: z
    .boolean()
    .refine((v) => v, { message: "Centang setelah dana dicocokkan dengan mutasi rekening penerima." }),
  reason: requiredText("Catatan verifikasi", 3, RECORD_REASON_MAX),
});
type Values = z.infer<typeof schema>;

const EMPTY: Values = {
  user_id: "",
  type: null,
  payment_method_id: null,
  proof_file_id: null,
  transfer_note: "",
  funds_verified: false,
  reason: "",
};

/** Payment terbuka jenis sama milik anggota (indeks payments_user_id_type_open_key): pending atau iuran ditolak. */
function isOpen(p: Pick<S["AdminPaymentItem"], "status">): boolean {
  return p.status === "pending" || p.status === "rejected";
}

interface Conflict {
  message: string;
  paymentId: string | null;
}

/**
 * "Catat iuran" (rencana cadangan D13, PRD 10.1; kontrak adminRecordPayment). Bila instruksi iuran disembunyikan di
 * suatu platform (pengaturan Instruksi bayar iuran per platform), anggota membayar langsung kepada pengurus dan
 * pengurus mencatatnya di sini setelah dana dicocokkan dengan mutasi rekening penerima. Langkahnya:
 * - pilih alumni (atau datang dari detail anggota), kelayakan jenis iuran sama dengan GET /me/fees;
 * - payment terbuka jenis sama ditampilkan: instruksi tanpa bukti atau iuran yang ditolak diselesaikan di tempat
 *   (200), bukti anggota yang menunggu verifikasi diputus lewat panel keputusan (server menjawab 409);
 * - rekening penerima (aktif atau nonaktif), bukti verifikasi (payment_proof, hanya untuk pengurus), catatan, dan
 *   centang dana sudah dicocokkan (PRD 3.4); nominal dihitung server dari biaya aktif (tidak dikirim klien).
 * Satu Idempotency-Key per isian (PRD 4.3). Daftar rekening dan biaya memerlukan settings.manage, pencarian alumni
 * memerlukan members.read (x-kapdh-access kontrak); tanpa izin itu dialog menjelaskan alasannya.
 */
export function RecordDuesDialog({
  open,
  initialUserId,
  onClose,
  onRecorded,
  onOpenPayment,
}: {
  open: boolean;
  /** Alumni yang sudah dipilih (tautan dari detail anggota). */
  initialUserId?: string | null;
  onClose: () => void;
  /** Iuran tercatat; `created` true untuk payment baru (201), false bila payment terbuka diselesaikan (200). */
  onRecorded: (payment: Detail, created: boolean) => void;
  /** Buka payment lain (mis. bukti anggota yang menunggu verifikasi) di panel keputusan. */
  onOpenPayment: (paymentId: string) => void;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canMembers = auth.can("members.read");
  const canMethods = auth.can("settings.manage");
  const [picked, setPicked] = useState<ComboboxOption | null>(null);
  const [proof, setProof] = useState<FileRef | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  /** Status HTTP respons berhasil: 201 payment baru, 200 payment terbuka diselesaikan di tempat. */
  const statusRef = useRef(0);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: EMPTY });
  const userId = form.watch("user_id");
  const type = form.watch("type");
  const methodId = form.watch("payment_method_id");
  const fundsVerified = form.watch("funds_verified");

  // Setiap kali dibuka formulir mulai dari awal (niat baru, Idempotency-Key baru).
  const { reset } = form;
  useEffect(() => {
    if (!open) return;
    reset({ ...EMPTY, user_id: initialUserId ?? "" });
    setPicked(null);
    setProof(null);
    setConflict(null);
  }, [open, initialUserId, reset]);

  const member = useApiQuery<MemberDetail>({
    queryKey: memberKeys.detail(userId),
    enabled: open && canMembers && userId !== "",
    request: ({ signal, headers }) =>
      api.GET("/admin/members/{userId}", { params: { path: { userId } }, signal, headers }),
  });
  const methods = useApiQuery({
    queryKey: [...METHODS_KEY, "record-options"],
    enabled: open && canMethods,
    request: ({ signal, headers }) =>
      api.GET("/admin/payment-methods", { params: { query: { limit: 100 } }, signal, headers }),
  });
  const fees = useApiQuery({
    queryKey: FEES_KEY,
    enabled: open && canMethods,
    request: ({ signal, headers }) => api.GET("/admin/settings/fees", { signal, headers }),
  });
  const openPayment = useApiQuery({
    queryKey: [...PAYMENTS_KEY, "record-open", { userId, type }],
    enabled: open && userId !== "" && type !== null,
    request: ({ signal, headers }) =>
      api.GET("/admin/payments", {
        params: { query: { user_id: userId, type: type ?? "registration", limit: 100 } },
        signal,
        headers,
      }),
    select: (page) => page.items.find(isOpen) ?? null,
  });

  const m = member.data && member.data.user_id === userId ? member.data : undefined;
  const block = m ? recordBlockReason(m, auth.profile?.admin_id) : null;
  const unavailable = m ? duesUnavailableReason(m) : null;

  // Jenis iuran bawaan: satu-satunya jenis yang layak; jenis yang tidak lagi layak dikosongkan.
  const { setValue } = form;
  const firstAvailable = unavailable ? (DUES_TYPES.find((t) => unavailable[t] === null) ?? null) : null;
  const typeUnavailable = type !== null && unavailable !== null && unavailable[type] !== null;
  const resetType = unavailable !== null && (type === null || typeUnavailable) && type !== firstAvailable;
  useEffect(() => {
    if (resetType) setValue("type", firstAvailable);
  }, [resetType, firstAvailable, setValue]);

  const current = openPayment.data ?? null;
  const awaitingReview = current?.stage === "awaiting_review";
  const fee = fees.data
    ? type === "registration"
      ? fees.data.registration_total
      : type === "renewal"
        ? fees.data.renewal_fee
        : null
    : null;
  const amount = current ? current.amount : fee;
  const method = methods.data?.items.find((x) => x.id === methodId) ?? null;
  /**
   * Payment baru memakai nominal `fees` versi aktif; server menolak 403 bila nominal belum tersimpan (versi 0, nilai
   * bawaan kode) atau total jenis iuran itu 0.00 (gagal tertutup, kontrak adminRecordPayment). Tagihan terbuka yang
   * diselesaikan di tempat memakai snapshot-nya sendiri sehingga tidak terpengaruh.
   */
  const feesUnset =
    type !== null && openPayment.isSuccess && current === null && fees.data !== undefined
      ? feesUnconfigured(fees.data, type)
      : false;

  const record = useApiMutation<Detail, RecordBody, Values>({
    setError: form.setError,
    request: async (body, ctx) => {
      const res = await api.POST("/admin/payments", {
        params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
        body,
      });
      statusRef.current = res.response.status;
      return res;
    },
    onReloadLatest: (error) => {
      const latest = error.current as Partial<Detail> | undefined;
      setConflict({
        message: error.message,
        paymentId: typeof latest?.id === "string" ? latest.id : null,
      });
      void queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY });
      void queryClient.invalidateQueries({ queryKey: memberKeys.detail(userId) });
    },
    onError: (error: ApiError) => {
      // Bukti tidak dapat dipakai (bukan unggahan sendiri, sudah terpakai): admin wajib mengunggah ulang.
      if (error.code === "FILE_INVALID") {
        setProof(null);
        form.setValue("proof_file_id", null);
        form.setError("proof_file_id", { type: "server", message: error.message });
      }
      // Konflik kepentingan, izin dicabut, atau nominal iuran belum ditetapkan (gagal tertutup): pesan server, lalu
      // biaya dimuat ulang agar catatan nominal di dialog mengikuti keadaan server.
      if (error.code === "FORBIDDEN") {
        form.setError("root.server", { type: "server", message: error.message });
        void queryClient.invalidateQueries({ queryKey: FEES_KEY });
      }
      // Status akun atau kelayakan berubah sejak dimuat (400 user_id/type): muat ulang data anggota.
      if (error.fieldErrors.user_id || error.fieldErrors.type)
        void queryClient.invalidateQueries({ queryKey: memberKeys.detail(userId) });
    },
    successMessage: (data) => recordedMessage(data, statusRef.current === 201),
    onSuccess: (data) => {
      queryClient.setQueryData(paymentDetailKey(data.id), data);
      void queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY });
      void queryClient.invalidateQueries({ queryKey: memberKeys.detail(userId) });
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
      onRecorded(data, statusRef.current === 201);
    },
  });

  const ready =
    canMembers &&
    canMethods &&
    m !== undefined &&
    block === null &&
    !typeUnavailable &&
    !awaitingReview &&
    !feesUnset;

  function submit(v: Values) {
    if (!ready || v.type === null || v.payment_method_id === null || v.proof_file_id === null) return;
    setConflict(null);
    const note = v.transfer_note.trim();
    record.mutate({
      user_id: v.user_id,
      type: v.type,
      payment_method_id: v.payment_method_id,
      proof_file_id: v.proof_file_id,
      ...(note ? { transfer_note: note } : {}),
      funds_verified: true,
      reason: v.reason.trim(),
    });
  }

  function changeMember(option: ComboboxOption | null) {
    setPicked(option);
    setConflict(null);
    form.clearErrors();
    form.setValue("user_id", option?.value ?? "");
    form.setValue("type", null);
  }

  const errors = form.formState.errors;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!record.isPending}
      size="lg"
      title="Catat iuran di luar aplikasi"
      description="Rencana cadangan D13: catat iuran yang dananya sudah Anda cocokkan dengan mutasi rekening penerima. Keanggotaan langsung aktif atau diperpanjang setelah disimpan."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={record.isPending}>
            Batal
          </Button>
          <Button
            type="submit"
            form="catat-iuran"
            disabled={!ready}
            loading={record.isPending}
            loadingText="Menyimpan..."
          >
            Catat iuran
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id="catat-iuran"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => void form.handleSubmit(submit)(e)}
        >
          <FormError message={errors.root?.server?.message} />
          {conflict ? (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md bg-warning-bg p-3 text-sm text-warning"
            >
              <p>{conflict.message}</p>
              {conflict.paymentId ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => onOpenPayment(conflict.paymentId!)}
                >
                  Buka pembayaran itu
                </Button>
              ) : null}
            </div>
          ) : null}

          {!canMembers ? (
            <p role="note" className="rounded-md bg-neutral-bg p-3 text-sm text-text-muted">
              Memilih alumni memerlukan izin melihat data anggota (members.read). Mintalah Super Admin
              menambah izin itu, atau mintalah pengurus lain mencatat iuran ini.
            </p>
          ) : userId === "" ? (
            <Combobox
              label="Alumni"
              required
              value={picked}
              onValueChange={changeMember}
              loadOptions={loadMembers}
              placeholder="Cari nama, No. KTA, email atau kota"
              hint="Iuran hanya untuk akun alumni yang aktif dan tidak dibatasi."
              error={errors.user_id?.message}
            />
          ) : (
            <MemberSummary
              query={member}
              member={m}
              error={errors.user_id?.message}
              onChange={() => changeMember(null)}
              disabled={record.isPending}
            />
          )}

          {block ? (
            <p role="note" className="rounded-md bg-warning-bg p-3 text-sm text-warning">
              {block}
            </p>
          ) : null}

          {m && !block && unavailable ? (
            <>
              <RadioGroup<DuesType>
                legend="Jenis iuran"
                required
                value={type}
                onValueChange={(v) => form.setValue("type", v, { shouldDirty: true })}
                error={errors.type?.message}
                options={DUES_TYPES.map((t) => ({
                  value: t,
                  label: PAYMENT_TYPE_LABEL[t],
                  description: unavailable[t] ?? duesDescription(t, fees.data),
                  disabled: unavailable[t] !== null,
                }))}
              />
              {type !== null && unavailable[type] === null ? (
                <OpenPaymentNote
                  loading={openPayment.isPending}
                  error={openPayment.isError ? openPayment.error : null}
                  onRetry={() => void openPayment.refetch()}
                  current={current}
                  fee={fee}
                  feesVersion={fees.data?.version ?? null}
                  feesUnset={feesUnset}
                  onOpenPayment={onOpenPayment}
                />
              ) : null}
            </>
          ) : null}

          {m && !block && !typeUnavailable && type !== null && !awaitingReview && !feesUnset ? (
            <>
              {!canMethods ? (
                <p role="note" className="rounded-md bg-neutral-bg p-3 text-sm text-text-muted">
                  Daftar rekening penerima hanya dapat dibaca admin berizin kelola pengaturan
                  (settings.manage). Mintalah pengurus dengan izin itu mencatat iuran ini.
                </p>
              ) : methods.isPending ? (
                <Loading label="Memuat rekening penerima..." rows={2} />
              ) : methods.isError ? (
                <ErrorState
                  error={methods.error}
                  onRetry={() => void methods.refetch()}
                  compact
                  title="Rekening penerima gagal dimuat"
                />
              ) : (
                <RadioGroup<string>
                  legend="Rekening penerima dana"
                  required
                  variant="card"
                  value={methodId}
                  onValueChange={(v) => form.setValue("payment_method_id", v, { shouldDirty: true })}
                  error={errors.payment_method_id?.message}
                  hint="Rekening organisasi tempat dana diterima; rekening nonaktif tetap dapat dipilih."
                  options={methods.data.items.map((x) => ({
                    value: x.id,
                    label: `${METHOD_KIND_LABEL[x.kind]} ${x.provider}${x.active ? "" : " (nonaktif)"}`,
                    description: `${x.account_number} a.n. ${x.account_holder}`,
                  }))}
                />
              )}
              <FileUpload
                purpose="payment_proof"
                label="Bukti verifikasi dana"
                required
                hint="Tangkapan mutasi atau bukti transfer yang dikirim anggota lewat kontak dukungan. Tutup transaksi pihak lain. Bukti ini hanya untuk pengurus dan tidak pernah ditampilkan kepada anggota."
                value={proof}
                onChange={(f) => {
                  setProof(f);
                  form.setValue("proof_file_id", f?.id ?? null, {
                    shouldValidate: form.formState.isSubmitted,
                  });
                }}
                error={errors.proof_file_id?.message}
                previewAlt="Pratinjau bukti verifikasi dana"
                disabled={record.isPending}
              />
              <FormField<Values, "transfer_note">
                name="transfer_note"
                label="Catatan transfer (opsional)"
                hint="Mis. bank pengirim dan tanggal mutasi."
              >
                {(field, a11y) => (
                  <Input {...field} {...a11y} maxLength={TRANSFER_NOTE_MAX} autoComplete="off" />
                )}
              </FormField>
              <FormField<Values, "reason">
                name="reason"
                label="Catatan verifikasi"
                required
                hint="Mis. tanggal mutasi dan rekening penerima. Hanya terlihat pengurus dan tercatat di audit."
              >
                {(field, a11y) => (
                  <Textarea {...field} {...a11y} rows={3} maxLength={RECORD_REASON_MAX} showCount />
                )}
              </FormField>
              <Checkbox
                boxed
                label={
                  amount
                    ? `Saya sudah mencocokkan dana ${formatRupiah(amount)} dengan mutasi rekening ${method?.provider ?? "penerima"}.`
                    : `Saya sudah mencocokkan dana iuran dengan mutasi rekening ${method?.provider ?? "penerima"}.`
                }
                checked={fundsVerified}
                onCheckedChange={(v) =>
                  form.setValue("funds_verified", v, { shouldValidate: form.formState.isSubmitted })
                }
                error={errors.funds_verified?.message}
              />
            </>
          ) : null}
        </form>
      </FormProvider>
    </Dialog>
  );
}

/** Pencarian alumni (GET /admin/members, members.read) untuk Combobox. */
async function loadMembers(q: string, signal: AbortSignal): Promise<ComboboxOption[]> {
  const page = await unwrap(api.GET("/admin/members", { params: { query: { q, limit: 10 } }, signal }));
  return page.items.map((x) => ({
    value: x.user_id,
    label: x.full_name,
    description: `${x.member_number ?? "Belum bernomor"} | ${membershipLabelFor(x.effective_status)}`,
  }));
}

function duesDescription(t: DuesType, fees: S["FeeSettings"] | undefined): string {
  if (!fees) return t === "registration" ? "Aktivasi keanggotaan pertama." : "Masa aktif bertambah 12 bulan.";
  return t === "registration"
    ? `Aktivasi keanggotaan pertama. Biaya aktif ${formatRupiah(fees.registration_total)}.`
    : `Masa aktif bertambah 12 bulan. Biaya aktif ${formatRupiah(fees.renewal_fee)}.`;
}

function MemberSummary({
  query,
  member,
  error,
  onChange,
  disabled,
}: {
  query: { isPending: boolean; isError: boolean; error: ApiError | null; refetch: () => unknown };
  member: MemberDetail | undefined;
  error?: string;
  onChange: () => void;
  disabled: boolean;
}) {
  return (
    <section
      aria-label="Alumni terpilih"
      className="flex flex-col gap-2 rounded-md border border-divider p-3"
    >
      {member ? (
        <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-semibold">{member.full_name}</span>
            <span className="text-xs text-text-muted">
              {[member.member_number ?? "Belum bernomor", member.cohort_code].join(" | ")}
            </span>
            <span className="text-xs text-text-muted">
              {member.expires_at
                ? `Masa aktif sampai ${formatDate(member.expires_at)}`
                : "Belum pernah memiliki masa aktif"}
            </span>
          </div>
          <MembershipStatusBadge status={member.effective_status} />
        </div>
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          compact
          title="Data alumni gagal dimuat"
        />
      ) : (
        <Loading label="Memuat data alumni..." rows={2} />
      )}
      {error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
      <Button variant="ghost" size="sm" className="self-start" onClick={onChange} disabled={disabled}>
        Ganti alumni
      </Button>
    </section>
  );
}

/** Payment terbuka jenis sama: menentukan apakah pencatatan membuat payment baru, menyelesaikan, atau ditolak 409. */
function OpenPaymentNote({
  loading,
  error,
  onRetry,
  current,
  fee,
  feesVersion,
  feesUnset,
  onOpenPayment,
}: {
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  current: S["AdminPaymentItem"] | null;
  fee: string | null;
  feesVersion: string | null;
  /** Nominal iuran belum ditetapkan: payment baru akan ditolak server (403, gagal tertutup). */
  feesUnset: boolean;
  onOpenPayment: (paymentId: string) => void;
}) {
  if (loading) return <Loading label="Memeriksa tagihan iuran yang sudah ada..." rows={1} />;
  if (error)
    return (
      <ErrorState error={error} onRetry={onRetry} compact title="Tagihan iuran yang ada gagal diperiksa" />
    );
  if (!current && feesUnset)
    return (
      <div role="note" className="flex flex-col gap-2 rounded-md bg-warning-bg p-3 text-sm text-warning">
        <p>
          Nominal iuran ini belum ditetapkan atau bernilai nol, sehingga iuran baru belum dapat dicatat.
          Simpan nominal iuran yang disahkan bendahara di tab Biaya terlebih dahulu.
        </p>
        <Link
          to="/payments"
          search={{ tab: "fees" }}
          className={cn(buttonClass({ variant: "outline", size: "sm" }), "self-start")}
        >
          Buka tab Biaya
        </Link>
      </div>
    );
  if (!current)
    return (
      <p role="note" className="rounded-md bg-info-bg p-3 text-sm text-info">
        Belum ada tagihan terbuka untuk iuran ini. Pembayaran baru dibuat dengan biaya aktif
        {fee ? ` ${formatRupiah(fee)}` : ""}
        {feesVersion ? ` (versi biaya ${feesVersion})` : ""}; nominal dihitung server.
      </p>
    );
  if (current.stage === "awaiting_review")
    return (
      <div role="note" className="flex flex-col gap-2 rounded-md bg-warning-bg p-3 text-sm text-warning">
        <p>
          Anggota sudah mengirim bukti untuk iuran ini ({formatRupiah(current.amount)}, dikirim{" "}
          {formatDateTime(current.submitted_at)}). Putuskan bukti itu dari antrean verifikasi; iuran tidak
          dapat dicatat dua kali.
        </p>
        <Button variant="outline" size="sm" className="self-start" onClick={() => onOpenPayment(current.id)}>
          Buka bukti anggota
        </Button>
      </div>
    );
  return (
    <div role="note" className="flex flex-col gap-1 rounded-md bg-info-bg p-3 text-sm text-info">
      <p className="flex flex-wrap items-center gap-2">
        Tagihan terbuka {formatRupiah(current.amount)} dibuat {formatDateTime(current.created_at)}{" "}
        <PaymentStageBadge stage={current.stage} />
      </p>
      <p>
        {current.stage === "needs_fix"
          ? "Bukti anggota pernah ditolak. Tagihan yang sama diselesaikan dengan bukti verifikasi Anda sebagai versi berikutnya; alasan penolakan lama tetap di histori."
          : "Belum ada bukti dari anggota. Tagihan yang sama diselesaikan sebagai lunas; nominalnya tetap."}
      </p>
    </div>
  );
}

function recordedMessage(p: Detail, created: boolean): string {
  const who = p.member?.full_name ?? "anggota";
  const kind = PAYMENT_TYPE_LABEL[p.type].toLowerCase();
  const until = p.period ? ` Masa aktif sampai ${formatDate(p.period.expires_at)}.` : "";
  return created
    ? `Iuran ${kind} ${who} tercatat lunas.${until}`
    : `Tagihan ${kind} ${who} yang sudah ada diselesaikan sebagai lunas.${until}`;
}
