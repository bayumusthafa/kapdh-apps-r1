import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { membershipLabelFor } from "@kapdh/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { useApiMutation } from "../../api/query";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { FormError, FormField } from "../../components/ui/FormField";
import { Textarea } from "../../components/ui/Input";
import { formatDateTime } from "../../lib/format";
import type { MemberNotice } from "./MemberDetailPage";
import {
  isPreconditionFailure,
  type MemberDetail,
  memberFromConflict,
  memberKeys,
  reloadMember,
  storeMember,
} from "./queries";

type ResetResult = components["schemas"]["AdminMemberPasswordResetResult"];

interface DialogProps {
  member: MemberDetail;
  open: boolean;
  onClose: () => void;
  onDone: (notice: MemberNotice) => void;
}

/** Teks baku server bila pesan pencabutan tidak diisi (kontrak AdminMemberUnsuspendRequest). */
export const DEFAULT_UNSUSPEND_MESSAGE = "Pembatasan akun Anda telah dicabut pengurus";

const CONFLICT_MESSAGE =
  "Data anggota berubah sebelum tindakan disimpan. Data terbaru sudah dimuat; periksa lalu ulangi bila masih diperlukan.";

/** Konflik versi tindakan anggota: tampilkan data terbaru (`current`) dan umumkan, jangan menimpa (AC F15-4). */
function useConflictHandler(member: MemberDetail, onClose: () => void, onDone: (n: MemberNotice) => void) {
  const queryClient = useQueryClient();
  return (error: ApiError) => {
    const current = memberFromConflict(error, member.user_id);
    if (current) storeMember(queryClient, current);
    else void queryClient.invalidateQueries({ queryKey: memberKeys.detail(member.user_id) });
    onClose();
    onDone({ tone: "warning", message: CONFLICT_MESSAGE });
  };
}

/**
 * Prasyarat gagal dengan keadaan terkini (mis. anggota mulai menghapus akunnya, sudah dibatasi admin lain): dialog
 * ditutup, detail/histori/daftar dimuat ulang sehingga tombol mengikuti keadaan terbaru, dan alasannya diumumkan
 * (PRD 4.5 "tampil status terbaru"). Kedua bentuk galat prasyarat server ditangani (lihat isPreconditionFailure).
 */
export function usePreconditionHandler(
  member: Pick<MemberDetail, "user_id">,
  onClose: () => void,
  onDone: (n: MemberNotice) => void,
) {
  const queryClient = useQueryClient();
  return (error: ApiError): boolean => {
    if (!isPreconditionFailure(error)) return false;
    reloadMember(queryClient, member.user_id);
    onClose();
    onDone({ tone: "warning", message: `${error.message} ${PRECONDITION_SUFFIX}` });
    return true;
  };
}

const PRECONDITION_SUFFIX =
  "Tindakan tidak dijalankan. Data terbaru sudah dimuat; periksa keadaan akun sebelum mengulang.";

const suspendSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Alasan internal minimal 3 karakter dan tidak boleh hanya spasi.")
    .max(1000, "Alasan internal maksimal 1000 karakter."),
  member_message: z
    .string()
    .trim()
    .min(3, "Pesan untuk anggota minimal 3 karakter.")
    .max(500, "Pesan untuk anggota maksimal 500 karakter."),
});
type SuspendValues = z.input<typeof suspendSchema>;

interface ActionVars<T> {
  userId: string;
  version: string;
  values: T;
}

/**
 * Batasi (suspend) anggota dari halaman anggota (PRD 4.2, AC F12-3, F12-4): alasan internal (tidak pernah
 * dikirim ke anggota) dan pesan aman untuk portal pembatasan, konfirmasi dua langkah (PRD 4.5), If-Match dan
 * Idempotency-Key per niat. Izin sama dengan jalur moderasi: members.read, moderation.read, moderation.resolve.
 */
export function SuspendDialog({ member, open, onClose, onDone }: DialogProps) {
  const queryClient = useQueryClient();
  const form = useForm<SuspendValues>({
    resolver: zodResolver(suspendSchema),
    defaultValues: { reason: "", member_message: "" },
  });
  const { reset } = form;
  useEffect(() => {
    if (open) reset({ reason: "", member_message: "" });
  }, [open, reset]);
  const onConflict = useConflictHandler(member, onClose, onDone);
  const onPrecondition = usePreconditionHandler(member, onClose, onDone);

  const suspend = useApiMutation<MemberDetail, ActionVars<SuspendValues>, SuspendValues>({
    // Satu Idempotency-Key per niat: anggota + versi yang dilihat + isi (PRD 4.3).
    intent: (v) => v,
    setError: form.setError,
    request: (v, ctx) =>
      api.POST("/admin/members/{userId}/suspend", {
        params: {
          path: { userId: v.userId },
          header: { "If-Match": v.version, "Idempotency-Key": ctx.idempotencyKey },
        },
        body: { reason: v.values.reason, member_message: v.values.member_message, confirm: true },
      }),
    onReloadLatest: (error) => onConflict(error),
    onError: onPrecondition,
    onSuccess: (data) => {
      storeMember(queryClient, data);
      onClose();
      onDone({
        tone: "success",
        message: `${data.full_name} dibatasi. Seluruh sesi anggota dicabut; profil disembunyikan dari direktori, verifikasi KTA menjadi Tidak aktif dan tiketnya tidak berlaku untuk check-in.`,
      });
    },
  });

  const submit = form.handleSubmit((values) =>
    suspend.mutate({ userId: member.user_id, version: member.version, values }),
  );

  return (
    <ConfirmDialog
      open={open}
      onCancel={onClose}
      onConfirm={() => submit()}
      pending={suspend.isPending}
      title={`Batasi akun ${member.full_name}?`}
      description="Anggota langsung dibatasi sampai pembatasan dicabut. Tanggal masa aktif tidak berubah (PRD 4.2)."
      confirmLabel="Batasi akun"
      acknowledgement="Saya memahami seluruh sesi anggota dicabut dan aksesnya dibatasi ke portal pembatasan."
    >
      <ul className="list-inside list-disc text-sm text-text">
        <li>Status keanggotaan menjadi Dibatasi dan mengalahkan masa aktif.</li>
        <li>Profil disembunyikan dari direktori dan verifikasi KTA menjadi Tidak aktif.</li>
        <li>Tiket anggota tidak berlaku untuk check-in; refund diputuskan per kasus.</li>
        <li>Anggota dapat mengajukan banding dari portal pembatasan.</li>
      </ul>
      <FormProvider {...form}>
        <div className="flex flex-col gap-3">
          <FormError message={form.formState.errors.root?.server?.message} />
          <FormField<SuspendValues, "reason">
            name="reason"
            label="Alasan internal"
            required
            hint="Untuk audit dan histori; tidak pernah dikirim ke anggota."
          >
            {(field, a11y) => <Textarea {...field} {...a11y} rows={3} maxLength={1000} />}
          </FormField>
          <FormField<SuspendValues, "member_message">
            name="member_message"
            label="Pesan untuk anggota"
            required
            hint="Ditampilkan di portal pembatasan anggota. Jangan memuat data pelapor."
          >
            {(field, a11y) => <Textarea {...field} {...a11y} rows={2} maxLength={500} />}
          </FormField>
        </div>
      </FormProvider>
    </ConfirmDialog>
  );
}

const unsuspendSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Alasan minimal 3 karakter dan tidak boleh hanya spasi.")
    .max(1000, "Alasan maksimal 1000 karakter."),
  member_message: z
    .string()
    .trim()
    .refine((v) => v === "" || v.length >= 3, "Pesan untuk anggota minimal 3 karakter.")
    .refine((v) => v.length <= 500, "Pesan untuk anggota maksimal 500 karakter."),
});
type UnsuspendValues = z.input<typeof unsuspendSchema>;

/**
 * Cabut pembatasan (PRD 4.2, AC F12-5): status dihitung ulang server dari masa aktif (bukan otomatis KTA Aktif),
 * banding aktif ditutup sebagai dikabulkan, satu notifikasi ke anggota dengan pesan opsional.
 */
export function UnsuspendDialog({ member, open, onClose, onDone }: DialogProps) {
  const queryClient = useQueryClient();
  const form = useForm<UnsuspendValues>({
    resolver: zodResolver(unsuspendSchema),
    defaultValues: { reason: "", member_message: "" },
  });
  const { reset } = form;
  useEffect(() => {
    if (open) reset({ reason: "", member_message: "" });
  }, [open, reset]);
  const onConflict = useConflictHandler(member, onClose, onDone);
  const onPrecondition = usePreconditionHandler(member, onClose, onDone);

  const unsuspend = useApiMutation<MemberDetail, ActionVars<UnsuspendValues>, UnsuspendValues>({
    intent: (v) => v,
    setError: form.setError,
    request: (v, ctx) =>
      api.POST("/admin/members/{userId}/unsuspend", {
        params: {
          path: { userId: v.userId },
          header: { "If-Match": v.version, "Idempotency-Key": ctx.idempotencyKey },
        },
        body: {
          reason: v.values.reason,
          ...(v.values.member_message ? { member_message: v.values.member_message } : {}),
          confirm: true,
        },
      }),
    onReloadLatest: (error) => onConflict(error),
    onError: onPrecondition,
    onSuccess: (data) => {
      storeMember(queryClient, data);
      onClose();
      onDone({
        tone: "success",
        message: `Pembatasan ${data.full_name} dicabut. Status keanggotaan sekarang: ${membershipLabelFor(data.effective_status)}. Banding aktif anggota (bila ada) ditutup sebagai dikabulkan.`,
      });
    },
  });

  const submit = form.handleSubmit((values) =>
    unsuspend.mutate({ userId: member.user_id, version: member.version, values }),
  );

  return (
    <ConfirmDialog
      open={open}
      tone="primary"
      onCancel={onClose}
      onConfirm={() => submit()}
      pending={unsuspend.isPending}
      title={`Cabut pembatasan ${member.full_name}?`}
      description="Status keanggotaan dihitung ulang dari masa aktif: anggota yang masa aktifnya habis menjadi Kedaluwarsa dan yang belum pernah membayar menjadi KTA Tidak Aktif (AC F12-5)."
      confirmLabel="Cabut pembatasan"
    >
      <FormProvider {...form}>
        <div className="flex flex-col gap-3">
          <FormError message={form.formState.errors.root?.server?.message} />
          <FormField<UnsuspendValues, "reason">
            name="reason"
            label="Alasan pencabutan"
            required
            hint="Untuk audit, histori dan catatan banding yang ditutup."
          >
            {(field, a11y) => <Textarea {...field} {...a11y} rows={3} maxLength={1000} />}
          </FormField>
          <FormField<UnsuspendValues, "member_message">
            name="member_message"
            label="Pesan untuk anggota (opsional)"
            hint={`Bila kosong, anggota menerima: "${DEFAULT_UNSUSPEND_MESSAGE}".`}
          >
            {(field, a11y) => <Textarea {...field} {...a11y} rows={2} maxLength={500} />}
          </FormField>
        </div>
      </FormProvider>
    </ConfirmDialog>
  );
}

const resetSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Alasan minimal 3 karakter dan tidak boleh hanya spasi.")
    .max(500, "Alasan maksimal 500 karakter."),
});
type ResetValues = z.input<typeof resetSchema>;

/** Waktu tunggu cadangan bila 429 tidak membawa retry_after_seconds (server selalu mengirimnya, PRD 5.2). */
const DEFAULT_RETRY_SECONDS = 60;

/**
 * Detik tersisa sampai `until` (epoch ms); 0 bila tidak ada atau sudah lewat. Dihitung saat render dari jam
 * sekarang (tidak pernah basi) dan komponen dirender ulang selama hitung mundur berjalan.
 */
function useCountdown(until: number | null): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (until === null) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(timer);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/** "45 detik" atau "12 menit 5 detik". */
function formatWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} detik`;
  return rest === 0 ? `${minutes} menit` : `${minutes} menit ${rest} detik`;
}

/**
 * Super Admin memulai pemulihan sandi alumni (F-16, AC F16-4): reautentikasi dulu (X-Reauth-Token), konfirmasi
 * dua langkah, lalu server mencabut seluruh sesi anggota, mengirim notifikasi keamanan dan mengirim kode hanya ke
 * email terverifikasi. Pengurus tidak pernah melihat atau menentukan sandi maupun kode.
 */
export function PasswordResetDialog({ member, open, onClose, onDone }: DialogProps) {
  const form = useForm<ResetValues>({ resolver: zodResolver(resetSchema), defaultValues: { reason: "" } });
  const { reset } = form;
  useEffect(() => {
    if (open) reset({ reason: "" });
  }, [open, reset]);
  const onPrecondition = usePreconditionHandler(member, onClose, onDone);
  // Batas pengiriman OTP per email (PRD 2.5, 429 RATE_LIMITED → show_countdown, PRD 5.2): tombol mulai nonaktif
  // sampai waktu tunggu dari server habis. Batas berlaku per email di server, sehingga tetap berlaku bila dialog
  // ditutup lalu dibuka lagi.
  const [rateLimit, setRateLimit] = useState<{ until: number; message: string } | null>(null);
  const remaining = useCountdown(rateLimit?.until ?? null);
  const limited = rateLimit !== null && remaining > 0;
  useEffect(() => {
    if (rateLimit && remaining === 0) setRateLimit(null);
  }, [rateLimit, remaining]);

  const initiate = useApiMutation<ResetResult, { userId: string; reason: string }, ResetValues>({
    requiresReauth: true,
    reauthReason: `Memulai pemulihan sandi ${member.full_name}`,
    intent: (v) => v,
    setError: form.setError,
    request: (v, ctx) =>
      api.POST("/admin/members/{userId}/password-reset", {
        params: {
          path: { userId: v.userId },
          header: { "X-Reauth-Token": ctx.reauthToken ?? "", "Idempotency-Key": ctx.idempotencyKey },
        },
        body: { reason: v.reason, confirm: true },
      }),
    onError: (error) => {
      if (onPrecondition(error)) return;
      if (error.code === "RATE_LIMITED") {
        const seconds = Math.max(1, error.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS);
        setRateLimit({
          until: Date.now() + seconds * 1000,
          message: `${error.message} Pemulihan dapat dicoba lagi dalam ${formatWait(seconds)}.`,
        });
      }
    },
    onSuccess: (data) => {
      setRateLimit(null);
      onClose();
      onDone({
        tone: "success",
        message: `Pemulihan sandi ${member.full_name} dimulai. ${data.sessions_revoked} sesi anggota dicabut. Kode pemulihan dikirim hanya ke email terverifikasi anggota dan berlaku sampai ${formatDateTime(data.challenge_expires_at)}. Kode dan sandi tidak pernah ditampilkan ke pengurus.`,
      });
    },
  });

  const submit = form.handleSubmit((values) =>
    initiate.mutate({ userId: member.user_id, reason: values.reason }),
  );

  return (
    <ConfirmDialog
      open={open}
      onCancel={onClose}
      onConfirm={() => {
        if (!limited) void submit();
      }}
      pending={initiate.isPending}
      confirmDisabled={limited}
      title={`Mulai pemulihan sandi ${member.full_name}?`}
      description="Hanya Super Admin. Anda akan diminta mengonfirmasi identitas (sandi dan kode autentikator) sebelum dikirim."
      confirmLabel="Mulai pemulihan"
      acknowledgement="Saya memahami seluruh sesi anggota dicabut dan anggota harus membuat sandi baru."
    >
      <ul className="list-inside list-disc text-sm text-text">
        <li>Seluruh sesi aplikasi anggota dicabut dan anggota keluar dari semua perangkat.</li>
        <li>Kode pemulihan dikirim hanya ke email terverifikasi {member.email}.</li>
        <li>Anggota menerima notifikasi keamanan; pengurus tidak melihat kode maupun sandi.</li>
      </ul>
      {limited ? (
        <div className="flex flex-col gap-1 rounded-md bg-warning-bg p-3 text-sm text-warning">
          {/* Pesan dibacakan sekali; hitung mundur visual tidak diumumkan tiap detik (N-11). */}
          <p role="alert" className="font-medium">
            {rateLimit.message}
          </p>
          <p className="text-text">
            Sisa waktu tunggu: <span className="font-mono tabular-nums">{formatWait(remaining)}</span>
          </p>
        </div>
      ) : null}
      <FormProvider {...form}>
        <div className="flex flex-col gap-3">
          <FormError message={form.formState.errors.root?.server?.message} />
          <FormField<ResetValues, "reason">
            name="reason"
            label="Alasan atau dasar permintaan"
            required
            hint="Mis. permintaan anggota lewat kanal bantuan resmi; dicatat di audit."
          >
            {(field, a11y) => <Textarea {...field} {...a11y} rows={3} maxLength={500} />}
          </FormField>
        </div>
      </FormProvider>
    </ConfirmDialog>
  );
}
