import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, MonitorSmartphone, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { AdminRoleBadge, Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { KeyValueList } from "../../components/ui/DataDisplay";
import { useCursorPaging } from "../../components/ui/DataTable";
import { Dialog } from "../../components/ui/Dialog";
import { FormError, FormField } from "../../components/ui/FormField";
import { PageHeader } from "../../components/ui/PageHeader";
import { PasswordInput } from "../../components/ui/PasswordInput";
import { newPasswordSchema, PasswordRules } from "../../components/ui/PasswordRules";
import { ErrorState, Loading } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";
import { formatDateTime } from "../../lib/format";
import { PERMISSION_LABEL } from "../../lib/labels";
import { BackupCodesPanel } from "../auth/BackupCodesPanel";

type Session = components["schemas"]["Session"];
type BackupCodes = components["schemas"]["AdminBackupCodes"];

/** Sisa backup code yang memicu saran buat ulang. */
export const LOW_BACKUP_CODES = 3;
const SESSION_PAGE_SIZE = 20;
export const SESSIONS_KEY = ["auth-sessions"] as const;

/**
 * Akun admin sendiri (F-02, F-16, N-08): identitas dan izin efektif dari GET /admin/me, ganti sandi dengan sandi
 * lama (AC F02-4), daftar perangkat yang masuk beserta pencabutan dan keluar dari semua perangkat (AC F02-6), serta
 * buat ulang backup code dengan reautentikasi (kode hanya tampil sekali).
 */
export function AccountPage() {
  return (
    <>
      <PageHeader title="Akun saya" description="Identitas admin, izin efektif dan keamanan akun." />
      <div className="grid gap-5 xl:grid-cols-2">
        <ProfileCard />
        <BackupCodesCard />
        <ChangePasswordCard />
        <SessionsCard />
      </div>
    </>
  );
}

function ProfileCard() {
  const auth = useAuth();
  const profile = auth.profile;
  if (!profile) return null;
  return (
    <Card aria-labelledby="akun-profil" className="flex flex-col gap-4 pb-5">
      <CardHeader titleId="akun-profil" title="Profil admin" />
      <div className="px-5">
        <KeyValueList
          items={[
            { label: "Nama", value: profile.display_name },
            { label: "Email login admin", value: profile.email ?? "-" },
            { label: "Peran", value: <AdminRoleBadge role={profile.role} /> },
            {
              label: "Tertaut ke akun alumni",
              value:
                profile.has_linked_alumni === undefined
                  ? "-"
                  : profile.has_linked_alumni
                    ? "Ya; pembayaran akun alumni itu diputus pengurus lain (PRD 2.3)"
                    : "Tidak",
            },
            {
              label: "Login sebelumnya",
              value: profile.previous_login_at
                ? formatDateTime(profile.previous_login_at)
                : "Belum ada (ini login pertama)",
              wide: true,
            },
            {
              label: `Izin efektif (versi ${profile.permissions_version})`,
              wide: true,
              value: (
                <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Daftar izin">
                  {profile.permissions.map((p) => (
                    <li key={p}>
                      <Badge tone="primary">{PERMISSION_LABEL[p] ?? p}</Badge>
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
        {profile.previous_login_at ? (
          <p className="mt-3 text-xs text-text-muted">
            Tidak mengenali login sebelumnya? Ganti sandi, keluarkan perangkat yang tidak dikenal, lalu
            hubungi Super Admin.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ Ganti sandi

const passwordSchema = z
  .object({
    current_password: z.string().min(1, "Sandi saat ini wajib diisi.").max(128, "Sandi terlalu panjang."),
    new_password: newPasswordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.new_password === v.confirm, {
    path: ["confirm"],
    message: "Konfirmasi sandi tidak sama.",
  });
type PasswordValues = z.infer<typeof passwordSchema>;

function ChangePasswordCard() {
  const queryClient = useQueryClient();
  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { current_password: "", new_password: "", confirm: "" },
    mode: "onTouched",
  });
  const change = useApiMutation<void, PasswordValues, PasswordValues>({
    setError: form.setError,
    request: (v) =>
      api.POST("/admin/auth/password/change", {
        body: { current_password: v.current_password, new_password: v.new_password },
      }),
    onSuccess: () => {
      form.reset({ current_password: "", new_password: "", confirm: "" });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (error) => {
      // Sandi tidak pernah dipertahankan setelah percobaan gagal kecuali isian yang tidak salah.
      if (error.fieldErrors.current_password) form.setValue("current_password", "");
    },
    successMessage: "Sandi admin diganti. Sesi di perangkat lain sudah dicabut.",
  });
  const newPassword = form.watch("new_password");
  return (
    <Card aria-labelledby="akun-sandi" className="flex flex-col gap-4 pb-5">
      <CardHeader
        titleId="akun-sandi"
        title="Ganti sandi"
        description="Mensyaratkan sandi saat ini. Setelah berhasil, sesi di perangkat lain dicabut; perangkat ini tetap masuk (AC F02-4)."
      />
      <form
        noValidate
        className="flex flex-col gap-4 px-5"
        onSubmit={(e) => void form.handleSubmit((v) => change.mutate(v))(e)}
      >
        <FormError message={form.formState.errors.root?.server?.message} />
        <FormField<PasswordValues, "current_password">
          control={form.control}
          name="current_password"
          label="Sandi saat ini"
          required
        >
          {(field, a11y) => <PasswordInput {...field} {...a11y} autoComplete="current-password" />}
        </FormField>
        <FormField<PasswordValues, "new_password">
          control={form.control}
          name="new_password"
          label="Sandi baru"
          required
        >
          {(field, a11y) => (
            <PasswordInput
              {...field}
              {...a11y}
              aria-describedby={[a11y["aria-describedby"], "syarat-sandi-akun"].filter(Boolean).join(" ")}
              autoComplete="new-password"
            />
          )}
        </FormField>
        <PasswordRules id="syarat-sandi-akun" value={newPassword} />
        <FormField<PasswordValues, "confirm">
          control={form.control}
          name="confirm"
          label="Ulangi sandi baru"
          required
        >
          {(field, a11y) => <PasswordInput {...field} {...a11y} autoComplete="new-password" />}
        </FormField>
        <Button type="submit" className="self-start" loading={change.isPending} loadingText="Menyimpan...">
          Ganti sandi
        </Button>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ Sesi perangkat

function sessionLabel(s: Session): string {
  return s.device_name ?? (s.platform === "web" ? "Peramban web" : "Perangkat tanpa nama");
}

function SessionsCard() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const paging = useCursorPaging("sesi", SESSION_PAGE_SIZE);
  const [revoking, setRevoking] = useState<Session | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const sessions = useApiQuery({
    queryKey: [...SESSIONS_KEY, { cursor: paging.cursor }],
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/auth/sessions", {
        params: { query: { limit: SESSION_PAGE_SIZE, ...(paging.cursor ? { cursor: paging.cursor } : {}) } },
        signal,
        headers,
      }),
  });

  const revoke = useApiMutation<void, Session>({
    request: (s) => api.DELETE("/auth/sessions/{sessionId}", { params: { path: { sessionId: s.id } } }),
    onSuccess: (_d, s) => {
      setRevoking(null);
      toast.success(`${sessionLabel(s)} sudah dikeluarkan.`);
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (error) => {
      setRevoking(null);
      if (error.code === "NOT_FOUND") void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });

  const logoutAll = useApiMutation<void, void>({
    request: () => api.POST("/auth/logout-all"),
    onSuccess: async () => {
      setConfirmAll(false);
      // Semua sesi termasuk sesi ini sudah dicabut server (AC F02-6); akhiri sesi lokal.
      await auth.logout("manual");
    },
    onError: () => setConfirmAll(false),
  });

  // Sesi saat ini ditampilkan paling atas (kontrak listSessions).
  const items = [...(sessions.data?.items ?? [])].sort((a, b) => Number(b.current) - Number(a.current));

  return (
    <Card aria-labelledby="akun-sesi" className="flex flex-col gap-4 pb-5 xl:col-span-2">
      <CardHeader
        titleId="akun-sesi"
        title="Perangkat yang masuk"
        description="Keluarkan perangkat yang tidak dikenal. Keluar dari semua perangkat mencabut sesi HTTP dan socket di semua perangkat, termasuk perangkat ini (AC F02-6)."
        actions={
          <Button
            variant="danger"
            size="sm"
            leftIcon={<LogOut aria-hidden="true" className="size-4" />}
            onClick={() => setConfirmAll(true)}
          >
            Keluar dari semua perangkat
          </Button>
        }
      />
      <div className="px-5">
        {sessions.isPending ? (
          <Loading label="Memuat daftar perangkat..." rows={3} />
        ) : sessions.isError ? (
          <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} compact />
        ) : (
          <>
            <ul aria-label="Daftar perangkat" className="flex flex-col divide-y divide-divider">
              {items.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <MonitorSmartphone aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
                    <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                      <span className="flex flex-wrap items-center gap-2 font-semibold">
                        {sessionLabel(s)}
                        {s.current ? <Badge tone="success">Perangkat ini</Badge> : null}
                      </span>
                      <span className="text-xs text-text-muted">
                        Masuk sejak {formatDateTime(s.created_at)} | aktivitas terakhir{" "}
                        {formatDateTime(s.last_seen_at)} | berakhir {formatDateTime(s.expires_at)}
                      </span>
                    </div>
                  </div>
                  {s.current ? (
                    <span className="text-xs text-text-muted">
                      Gunakan tombol Keluar untuk perangkat ini.
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Keluarkan ${sessionLabel(s)}`}
                      onClick={() => setRevoking(s)}
                    >
                      Keluarkan
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {paging.pageIndex > 0 || sessions.data.next_cursor ? (
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  focusableWhenDisabled
                  disabled={paging.pageIndex === 0 || sessions.isFetching}
                  onClick={paging.prev}
                >
                  Halaman sebelumnya
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  focusableWhenDisabled
                  disabled={!sessions.data.next_cursor || sessions.isFetching}
                  onClick={() => sessions.data.next_cursor && paging.next(sessions.data.next_cursor)}
                >
                  Halaman berikutnya
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      <ConfirmDialog
        open={revoking !== null}
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking);
        }}
        pending={revoke.isPending}
        title="Keluarkan perangkat ini?"
        description={
          revoking
            ? `${sessionLabel(revoking)} (masuk sejak ${formatDateTime(revoking.created_at)}) harus masuk ulang dengan sandi dan kode autentikator.`
            : undefined
        }
        confirmLabel="Keluarkan perangkat"
        acknowledgement="Saya memahami perangkat tersebut langsung keluar."
      />
      <ConfirmDialog
        open={confirmAll}
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => logoutAll.mutate()}
        pending={logoutAll.isPending}
        title="Keluar dari semua perangkat?"
        description="Semua sesi admin Anda, termasuk perangkat ini, langsung tidak berlaku. Anda perlu masuk ulang dengan sandi dan kode autentikator."
        confirmLabel="Keluar dari semua perangkat"
        acknowledgement="Saya memahami semua perangkat akan keluar."
      />
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ Backup code

function BackupCodesCard() {
  const auth = useAuth();
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<BackupCodes | null>(null);
  const remaining = auth.profile?.backup_codes_remaining;
  const regenerate = useApiMutation<BackupCodes, void>({
    requiresReauth: true,
    reauthReason: "Membuat ulang backup code",
    request: (_v, ctx) =>
      api.POST("/admin/auth/backup-codes", {
        params: { header: { "X-Reauth-Token": ctx.reauthToken ?? "" } },
      }),
    onSuccess: (data) => {
      setConfirm(false);
      setResult(data);
    },
    onError: () => setConfirm(false),
  });
  const low = remaining !== undefined && remaining <= LOW_BACKUP_CODES;
  return (
    <Card aria-labelledby="akun-backup" className="flex flex-col gap-4 pb-5">
      <CardHeader
        titleId="akun-backup"
        title="Backup code"
        description="Kode sekali pakai untuk masuk bila aplikasi autentikator tidak tersedia (F-02)."
      />
      <div className="flex flex-col gap-3 px-5">
        <p className="flex items-center gap-2 text-sm">
          <KeyRound aria-hidden="true" className="size-4 text-primary" />
          {remaining === undefined
            ? "Sisa backup code tidak diketahui."
            : `Sisa ${remaining} dari 10 backup code.`}
        </p>
        {low ? (
          <p role="note" className="flex items-start gap-2 rounded-md bg-warning-bg p-3 text-sm text-warning">
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            Backup code hampir habis. Buat ulang sekarang agar tidak terkunci saat autentikator hilang.
          </p>
        ) : null}
        <Button variant="outline" className="self-start" onClick={() => setConfirm(true)}>
          Buat ulang backup code
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onCancel={() => setConfirm(false)}
        onConfirm={() => regenerate.mutate()}
        pending={regenerate.isPending}
        title="Buat ulang backup code?"
        description="Sepuluh kode baru dibuat dan SEMUA backup code lama langsung tidak berlaku. Anda akan diminta sandi dan kode autentikator."
        confirmLabel="Buat kode baru"
        acknowledgement="Saya memahami backup code lama tidak berlaku lagi."
      />
      <Dialog
        open={result !== null}
        onClose={() => undefined}
        dismissable={false}
        title="Backup code baru"
        size="md"
      >
        {result ? (
          <BackupCodesPanel
            codes={result.backup_codes}
            generatedAt={result.generated_at}
            doneLabel="Selesai"
            onDone={() => {
              // Kode dibuang dari memori; sisa kode di profil dimuat ulang.
              setResult(null);
              void auth.refreshProfile({ background: false });
            }}
          />
        ) : null}
      </Dialog>
    </Card>
  );
}
