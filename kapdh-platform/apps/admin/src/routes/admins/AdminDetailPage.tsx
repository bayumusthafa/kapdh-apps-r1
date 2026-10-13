import { zodResolver } from "@hookform/resolvers/zod";
import type { components, Permission } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { KeyRound, MailPlus, Power, RotateCcw, ShieldOff, Trash2, UserCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type FieldValues, type Path, useForm, type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { type FetchResult, type MutationRequestContext, useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { AdminStatusBadge, Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox, RadioGroup } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Avatar, KeyValueList } from "../../components/ui/DataDisplay";
import { Dialog } from "../../components/ui/Dialog";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input, Textarea } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { PermissionGate } from "../../components/ui/PermissionGate";
import { ErrorState, Loading } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import {
  AccessChips,
  ADMINS_KEY,
  adminDetailKey,
  CatalogGate,
  PermissionEditor,
  usePermissionCatalog,
} from "./shared";

type Detail = components["schemas"]["AdminAccountDetail"];
type AdminRole = components["schemas"]["AdminRole"];

const ROLE_LABEL: Record<AdminRole, string> = { super_admin: "Super Admin", admin: "Admin" };

/** Ringkasan pesan untuk region live halaman (hasil tindakan atau data yang berubah). */
interface Notice {
  tone: "success" | "warning";
  message: string;
  seq: number;
}

/**
 * Detail admin (F-16, AC F16-1..F16-3; izin admins.manage). Ubah nama/peran/izin, nonaktifkan, aktifkan kembali,
 * kirim ulang undangan, koreksi email login, pulihkan akun (reset sandi + MFA lewat undangan ulang) dan hapus
 * identitas yang belum pernah aktif. Semua perubahan wajib reautentikasi dan If-Match; versi usang memuat data
 * terbaru tanpa menimpa (AC F15-4); penjaga Super Admin aktif terakhir ditampilkan dari galat server (AC F16-2).
 */
export function AdminDetailPage() {
  const { adminId } = useParams({ from: "/app/admins/$adminId" });
  return (
    <PermissionGate anyOf={["admins.manage"]}>
      <AdminDetail adminId={adminId} />
    </PermissionGate>
  );
}

function AdminDetail({ adminId }: { adminId: string }) {
  const auth = useAuth();
  const detail = useApiQuery({
    queryKey: adminDetailKey(adminId),
    request: ({ signal, headers }) =>
      api.GET("/admin/admins/{adminId}", { params: { path: { adminId } }, signal, headers }),
  });
  const [notice, setNotice] = useState<Notice | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const notify = (tone: Notice["tone"], message: string) =>
    setNotice((n) => ({ tone, message, seq: (n?.seq ?? 0) + 1 }));
  // Hasil tindakan diumumkan; fokus dipindah ke ringkasan bila tombol pemicu hilang (N-11).
  const seq = notice?.seq ?? 0;
  useEffect(() => {
    if (seq === 0) return;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus();
  }, [seq]);

  const breadcrumbs = [{ label: "Manajemen Admin", to: "/admins" as const }, { label: "Detail Admin" }];
  if (detail.isPending)
    return (
      <>
        <PageHeader title="Detail Admin" breadcrumbs={breadcrumbs} />
        <Card className="p-2">
          <Loading label="Memuat detail admin..." rows={6} />
        </Card>
      </>
    );
  if (detail.isError)
    return (
      <>
        <PageHeader title="Detail Admin" breadcrumbs={breadcrumbs} />
        <Card>
          <ErrorState
            error={detail.error}
            onRetry={() => void detail.refetch()}
            title="Detail admin gagal dimuat"
          />
        </Card>
      </>
    );
  const a = detail.data;
  const self = a.id === auth.profile?.admin_id;
  return (
    <>
      <PageHeader
        title={a.display_name}
        description="Peran, izin, status dan pemulihan akun admin. Setiap perubahan tercatat di audit (AC F16-1)."
        breadcrumbs={[{ label: "Manajemen Admin", to: "/admins" }, { label: a.display_name }]}
      />
      <div
        ref={headingRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={
          notice
            ? cn(
                "rounded-md p-3 text-sm font-medium outline-none",
                notice.tone === "success" ? "bg-success-bg text-success" : "bg-warning-bg text-warning",
              )
            : "outline-none"
        }
      >
        {notice?.message ?? ""}
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex flex-col gap-5">
          <IdentityCard admin={a} self={self} />
          <StatusCard admin={a} self={self} notify={notify} />
        </div>
        <AccessCard key={`${a.id}:${a.version}`} admin={a} self={self} notify={notify} />
      </div>
    </>
  );
}

function IdentityCard({ admin: a, self }: { admin: Detail; self: boolean }) {
  return (
    <Card aria-labelledby="admin-identitas" className="flex flex-col gap-4 pb-5">
      <CardHeader titleId="admin-identitas" title="Identitas" />
      <div className="flex flex-col gap-4 px-5">
        <div className="flex items-center gap-3">
          <Avatar name={a.display_name} src={a.linked_alumni?.avatar_url} size="lg" />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2 font-semibold">
              {a.display_name}
              {self ? <Badge tone="info">Akun Anda</Badge> : null}
            </span>
            <span className="break-all text-sm text-text-muted">{a.email}</span>
            <span className="flex flex-wrap items-center gap-2">
              <AdminStatusBadge status={a.status} />
            </span>
          </div>
        </div>
        <AccessChips admin={a} />
        <KeyValueList
          items={[
            {
              label: "Akun alumni tertaut",
              value: a.linked_alumni
                ? `${a.linked_alumni.full_name} (${a.linked_alumni.member_number ?? "belum bernomor"})`
                : "Tidak tertaut",
              wide: true,
            },
            {
              label: "Autentikator (TOTP)",
              value: a.mfa_enrolled ? "Terverifikasi" : "Belum terdaftar",
            },
            { label: "Sesi aktif", value: String(a.active_session_count) },
            {
              label: "Login terakhir",
              value: a.last_login_at ? formatDateTime(a.last_login_at) : "Belum pernah",
            },
            { label: "Dibuat", value: formatDateTime(a.created_at) },
            { label: "Diundang oleh", value: a.invited_by?.display_name ?? "Bootstrap/akun dihapus" },
            {
              label: "Aktif sejak",
              value: a.activated_at ? formatDateTime(a.activated_at) : "Belum pernah aktif",
            },
            ...(a.invite_expires_at
              ? [{ label: "Undangan berlaku sampai", value: formatDateTime(a.invite_expires_at) }]
              : []),
            ...(a.disabled_at ? [{ label: "Nonaktif sejak", value: formatDateTime(a.disabled_at) }] : []),
            { label: "Versi izin", value: String(a.permissions_version) },
          ]}
        />
      </div>
    </Card>
  );
}

/**
 * Mutasi detail admin bersama: reautentikasi, If-Match dari versi yang dibaca, versi usang memuat data terbaru
 * (AC F15-4), dan galat server ditampilkan di formulir/dialog yang memicu (termasuk penjaga Super Admin terakhir,
 * AC F16-2). Galat isian yang tidak ada di formulir ditampilkan sebagai galat formulir.
 */
function useDetailMutation<T, V extends FieldValues>({
  admin,
  reauthReason,
  form,
  fields,
  request,
  onSuccess,
  onConflict,
  notify,
}: {
  admin: Detail;
  reauthReason: string;
  form: UseFormReturn<V>;
  fields: readonly Path<V>[];
  request: (vars: V, ctx: MutationRequestContext) => Promise<FetchResult<T>>;
  onSuccess: (data: T) => void;
  onConflict: () => void;
  notify: (tone: Notice["tone"], message: string) => void;
}) {
  const queryClient = useQueryClient();
  const applyCurrent = (error: ApiError) => {
    const current = error.current as Detail | undefined;
    if (current && typeof current === "object" && "version" in current)
      queryClient.setQueryData(adminDetailKey(admin.id), current);
    else void queryClient.invalidateQueries({ queryKey: adminDetailKey(admin.id) });
    void queryClient.invalidateQueries({ queryKey: [...ADMINS_KEY, "list"] });
  };
  return useApiMutation<T, V>({
    requiresReauth: true,
    reauthReason,
    toastErrors: false,
    request,
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ADMINS_KEY });
      onSuccess(data);
    },
    onReloadLatest: (error) => {
      applyCurrent(error);
      onConflict();
      notify(
        "warning",
        "Data admin ini sudah diubah pengurus lain. Tampilan dimuat ulang ke versi terbaru; periksa lalu ulangi bila masih perlu.",
      );
    },
    onError: (error) => {
      if (error.ui.action === "reload_latest" || error.reauthCancelled) return;
      if (error.current !== undefined) applyCurrent(error);
      let placed = false;
      const rootMessages: string[] = [];
      for (const [field, messages] of Object.entries(error.fieldErrors)) {
        if ((fields as readonly string[]).includes(field)) {
          form.setError(
            field as Path<V>,
            { type: "server", message: messages.join(" ") },
            { shouldFocus: !placed },
          );
          placed = true;
        } else rootMessages.push(messages.join(" "));
      }
      if (rootMessages.length > 0 || !placed)
        form.setError("root.server" as Path<V>, {
          type: "server",
          message: rootMessages.length > 0 ? rootMessages.join(" ") : error.message,
        });
    },
  });
}

// ------------------------------------------------------------------------------------------------ Peran & izin

const accessSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, "Nama tampilan wajib diisi.")
    .max(120, "Nama tampilan maksimal 120 karakter."),
  role: z.enum(["admin", "super_admin"]),
  permissions: z.array(z.string()),
  reason: z.string().max(500, "Alasan maksimal 500 karakter."),
});
type AccessValues = z.infer<typeof accessSchema>;

function AccessCard({
  admin: a,
  self,
  notify,
}: {
  admin: Detail;
  self: boolean;
  notify: (tone: Notice["tone"], message: string) => void;
}) {
  const catalog = usePermissionCatalog();
  const [confirm, setConfirm] = useState(false);
  const original: AccessValues = {
    display_name: a.display_name,
    role: a.role,
    permissions: a.role === "super_admin" ? [] : a.permissions,
    reason: "",
  };
  const form = useForm<AccessValues>({ resolver: zodResolver(accessSchema), defaultValues: original });
  const role = form.watch("role");
  const permissions = form.watch("permissions") as Permission[];

  const save = useDetailMutation<Detail, AccessValues>({
    admin: a,
    reauthReason: `Mengubah peran dan izin ${a.display_name}`,
    form,
    fields: ["display_name", "role", "permissions", "reason"],
    request: (v, ctx) => {
      const body: components["schemas"]["AdminUpdateRequest"] = {};
      if (v.display_name.trim() !== a.display_name) body.display_name = v.display_name.trim();
      if (v.role !== a.role) body.role = v.role;
      const perms = v.role === "admin" ? (v.permissions as Permission[]) : [];
      const before = a.role === "admin" ? a.permissions : [];
      if (v.role === "admin" && (v.role !== a.role || perms.join() !== before.join()))
        body.permissions = perms;
      if (v.reason.trim()) body.reason = v.reason.trim();
      return api.PATCH("/admin/admins/{adminId}", {
        params: {
          path: { adminId: a.id },
          header: { "If-Match": a.version, "X-Reauth-Token": ctx.reauthToken ?? "" },
        },
        body,
      });
    },
    onSuccess: (data) => {
      setConfirm(false);
      notify("success", `Perubahan ${data.display_name} tersimpan (versi izin ${data.permissions_version}).`);
    },
    onConflict: () => setConfirm(false),
    notify,
  });

  const labelOf = (p: Permission) => catalog.data?.permissions.find((c) => c.permission === p)?.label ?? p;
  const before = a.role === "admin" ? a.permissions : [];
  const after = role === "admin" ? permissions : [];
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  const nameChanged = form.watch("display_name").trim() !== a.display_name;
  const roleChanged = role !== a.role;
  const changed = nameChanged || roleChanged || added.length > 0 || removed.length > 0;

  const errors = form.formState.errors;
  return (
    <Card aria-labelledby="admin-akses" className="flex flex-col gap-4 pb-5">
      <CardHeader
        titleId="admin-akses"
        title="Peran & izin"
        description="Izin dievaluasi server di setiap permintaan; perubahan langsung berlaku walau token admin belum kedaluwarsa (AC F16-3)."
      />
      <form
        noValidate
        className="flex flex-col gap-4 px-5"
        onSubmit={(e) =>
          void form.handleSubmit(() => {
            if (changed) setConfirm(true);
          })(e)
        }
      >
        {self ? (
          <p role="note" className="rounded-md bg-info-bg p-3 text-sm text-info">
            Ini akun Anda sendiri. Super Admin aktif terakhir tidak dapat diturunkan (AC F16-2).
          </p>
        ) : null}
        <FormError message={errors.root?.server?.message} />
        <FormField<AccessValues, "display_name">
          control={form.control}
          name="display_name"
          label="Nama tampilan"
          required
        >
          {(field, a11y) => <Input {...field} {...a11y} maxLength={120} />}
        </FormField>
        <RadioGroup<AdminRole>
          legend="Peran"
          value={role}
          onValueChange={(v) => form.setValue("role", v, { shouldDirty: true })}
          error={errors.role?.message}
          options={[
            { value: "admin", label: "Admin", description: "Hanya izin yang dipilih." },
            {
              value: "super_admin",
              label: "Super Admin",
              description: "Semua izin termasuk mengelola admin.",
            },
          ]}
        />
        {role === "admin" ? (
          <CatalogGate>
            {(c) => (
              <PermissionEditor
                catalog={c}
                value={permissions}
                onChange={(next) => form.setValue("permissions", next, { shouldDirty: true })}
                error={errors.permissions?.message}
              />
            )}
          </CatalogGate>
        ) : (
          <p className="rounded-md bg-info-bg p-3 text-sm text-info">Super Admin memiliki seluruh izin.</p>
        )}
        <FormField<AccessValues, "reason">
          control={form.control}
          name="reason"
          label="Alasan perubahan (opsional)"
          hint="Tercatat di audit. Jangan menulis sandi atau kode."
        >
          {(field, a11y) => <Textarea {...field} {...a11y} rows={2} maxLength={500} />}
        </FormField>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!changed} loading={save.isPending} loadingText="Menyimpan...">
            Simpan perubahan
          </Button>
          {changed ? (
            <Button variant="ghost" onClick={() => form.reset(original)}>
              Batalkan perubahan
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={confirm}
        tone="primary"
        onCancel={() => setConfirm(false)}
        onConfirm={() => save.mutate(form.getValues())}
        pending={save.isPending}
        title="Simpan perubahan izin?"
        description={`Perubahan untuk ${a.display_name} berlaku pada permintaan berikutnya dan tercatat di audit.`}
        confirmLabel="Simpan perubahan"
      >
        <ul aria-label="Ringkasan perubahan" className="flex flex-col gap-1 text-sm">
          {nameChanged ? <li>Nama tampilan: {form.getValues("display_name").trim()}</li> : null}
          {roleChanged ? (
            <li>
              Peran: {ROLE_LABEL[a.role]} menjadi {ROLE_LABEL[role]}
            </li>
          ) : null}
          {added.length > 0 ? <li>Izin ditambah: {added.map(labelOf).join(", ")}</li> : null}
          {removed.length > 0 ? <li>Izin dicabut: {removed.map(labelOf).join(", ")}</li> : null}
        </ul>
      </ConfirmDialog>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ Status & pemulihan

type Action = "disable" | "activate" | "resend" | "email" | "recover" | "delete";

function StatusCard({
  admin: a,
  self,
  notify,
}: {
  admin: Detail;
  self: boolean;
  notify: (tone: Notice["tone"], message: string) => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const neverActive = a.activated_at === null;
  const canDisable = a.status !== "disabled";
  const canActivate = a.status === "disabled" && !neverActive && a.mfa_enrolled;
  const canResend = a.status === "invited" || (a.status === "disabled" && neverActive);
  const canEmail = canResend;
  const canRecover = !neverActive && a.status !== "invited" && !self;
  const canDelete = neverActive;
  const close = () => setAction(null);
  return (
    <Card aria-labelledby="admin-status" className="flex flex-col gap-4 pb-5">
      <CardHeader
        titleId="admin-status"
        title="Status & pemulihan"
        description="Menonaktifkan mencabut semua sesi admin. Pemulihan mereset sandi dan autentikator lewat undangan ulang."
      />
      <div className="flex flex-col gap-2 px-5">
        {canActivate ? (
          <Button
            variant="outline"
            leftIcon={<UserCheck aria-hidden="true" className="size-4" />}
            onClick={() => setAction("activate")}
          >
            Aktifkan kembali
          </Button>
        ) : null}
        {canResend ? (
          <Button
            variant="outline"
            leftIcon={<MailPlus aria-hidden="true" className="size-4" />}
            onClick={() => setAction("resend")}
          >
            Kirim ulang undangan
          </Button>
        ) : null}
        {canEmail ? (
          <Button
            variant="outline"
            leftIcon={<RotateCcw aria-hidden="true" className="size-4" />}
            onClick={() => setAction("email")}
          >
            Koreksi email login
          </Button>
        ) : null}
        {canRecover ? (
          <Button
            variant="outline"
            leftIcon={<KeyRound aria-hidden="true" className="size-4" />}
            onClick={() => setAction("recover")}
          >
            Pulihkan akun (reset sandi &amp; autentikator)
          </Button>
        ) : null}
        {canDisable ? (
          <Button
            variant="danger"
            leftIcon={<Power aria-hidden="true" className="size-4" />}
            onClick={() => setAction("disable")}
          >
            {a.status === "invited" ? "Nonaktifkan (batalkan undangan)" : "Nonaktifkan admin"}
          </Button>
        ) : null}
        {canDelete ? (
          <Button
            variant="danger"
            leftIcon={<Trash2 aria-hidden="true" className="size-4" />}
            onClick={() => setAction("delete")}
          >
            Hapus identitas admin
          </Button>
        ) : null}
        {a.status === "disabled" && !neverActive && !a.mfa_enrolled ? (
          <p className="text-xs text-text-muted">
            Admin ini tidak lagi memiliki autentikator terverifikasi; aktifkan lewat Pulihkan akun.
          </p>
        ) : null}
        {self ? (
          <p className="flex items-start gap-1.5 text-xs text-text-muted">
            <ShieldOff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            Akun sendiri tidak dapat dipulihkan dari sini; gunakan ganti sandi atau backup code di halaman
            Akun.
          </p>
        ) : null}
      </div>
      {action === "disable" ? <DisableDialog admin={a} onClose={close} notify={notify} /> : null}
      {action === "activate" ? <ActivateDialog admin={a} onClose={close} notify={notify} /> : null}
      {action === "resend" ? <ResendDialog admin={a} onClose={close} notify={notify} /> : null}
      {action === "email" ? <EmailDialog admin={a} onClose={close} notify={notify} /> : null}
      {action === "recover" ? <RecoverDialog admin={a} onClose={close} notify={notify} /> : null}
      {action === "delete" ? <DeleteDialog admin={a} onClose={close} /> : null}
    </Card>
  );
}

interface DialogProps {
  admin: Detail;
  onClose: () => void;
  notify: (tone: Notice["tone"], message: string) => void;
}

const reasonField = z
  .string()
  .trim()
  .min(3, "Alasan minimal 3 karakter.")
  .max(500, "Alasan maksimal 500 karakter.");

const disableSchema = z.object({
  reason: reasonField,
  acknowledged: z.literal(true, "Centang pernyataan ini."),
});
type DisableValues = z.infer<typeof disableSchema>;

function DisableDialog({ admin: a, onClose, notify }: DialogProps) {
  const form = useForm<DisableValues>({
    resolver: zodResolver(disableSchema),
    defaultValues: { reason: "", acknowledged: false as unknown as true },
  });
  const disable = useDetailMutation<Detail, DisableValues>({
    admin: a,
    reauthReason: `Menonaktifkan ${a.display_name}`,
    form,
    fields: ["reason"],
    request: (v, ctx) =>
      api.PATCH("/admin/admins/{adminId}", {
        params: {
          path: { adminId: a.id },
          header: { "If-Match": a.version, "X-Reauth-Token": ctx.reauthToken ?? "" },
        },
        body: { status: "disabled", reason: v.reason.trim() },
      }),
    onSuccess: (data) => {
      onClose();
      notify("success", `${data.display_name} dinonaktifkan; semua sesinya dicabut.`);
    },
    onConflict: onClose,
    notify,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      dismissable={!disable.isPending}
      title={a.status === "invited" ? "Batalkan undangan admin?" : "Nonaktifkan admin?"}
      description={`${a.display_name} tidak dapat masuk lagi dan semua sesinya dicabut. Riwayat dan audit tetap tersimpan.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={disable.isPending}>
            Batal
          </Button>
          <Button
            variant="danger-solid"
            loading={disable.isPending}
            onClick={() => void form.handleSubmit((v) => disable.mutate(v))()}
          >
            Nonaktifkan
          </Button>
        </>
      }
    >
      <FormError message={form.formState.errors.root?.server?.message} />
      <FormField<DisableValues, "reason">
        control={form.control}
        name="reason"
        label="Alasan (dicatat di audit)"
        required
      >
        {(field, a11y) => <Textarea {...field} {...a11y} rows={3} maxLength={500} />}
      </FormField>
      <AckField
        label="Saya memahami admin ini langsung keluar dari semua perangkat."
        checked={form.watch("acknowledged") === true}
        onChange={(v) =>
          form.setValue("acknowledged", v as true, { shouldValidate: form.formState.isSubmitted })
        }
        error={form.formState.errors.acknowledged?.message}
      />
    </Dialog>
  );
}

/** Pernyataan memahami akibat (langkah kedua konfirmasi tindakan destruktif, PRD 4.5). */
function AckField({
  checked,
  onChange,
  error,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  error?: string;
  label: string;
}) {
  return <Checkbox label={label} checked={checked} onCheckedChange={onChange} error={error} />;
}

const plainSchema = z.object({});
type PlainValues = z.infer<typeof plainSchema>;

function ActivateDialog({ admin: a, onClose, notify }: DialogProps) {
  const form = useForm<PlainValues>({ resolver: zodResolver(plainSchema), defaultValues: {} });
  const activate = useDetailMutation<Detail, PlainValues>({
    admin: a,
    reauthReason: `Mengaktifkan kembali ${a.display_name}`,
    form,
    fields: [],
    request: (_v, ctx) =>
      api.PATCH("/admin/admins/{adminId}", {
        params: {
          path: { adminId: a.id },
          header: { "If-Match": a.version, "X-Reauth-Token": ctx.reauthToken ?? "" },
        },
        body: { status: "active" },
      }),
    onSuccess: (data) => {
      onClose();
      notify("success", `${data.display_name} aktif kembali dengan sandi dan autentikator lamanya.`);
    },
    onConflict: onClose,
    notify,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!activate.isPending}
      title="Aktifkan kembali admin?"
      description={`${a.display_name} dapat masuk lagi dengan sandi dan autentikator yang sama. Bila kredensial diduga bocor, gunakan Pulihkan akun.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={activate.isPending}>
            Batal
          </Button>
          <Button loading={activate.isPending} onClick={() => activate.mutate({})}>
            Aktifkan kembali
          </Button>
        </>
      }
    >
      <FormError message={form.formState.errors.root?.server?.message} />
    </Dialog>
  );
}

function ResendDialog({ admin: a, onClose, notify }: DialogProps) {
  const form = useForm<PlainValues>({ resolver: zodResolver(plainSchema), defaultValues: {} });
  const resend = useDetailMutation<components["schemas"]["AdminInvitationResult"], PlainValues>({
    admin: a,
    reauthReason: `Mengirim ulang undangan ${a.display_name}`,
    form,
    fields: [],
    request: (_v, ctx) =>
      api.POST("/admin/admins/{adminId}/invitation", {
        params: {
          path: { adminId: a.id },
          header: {
            "If-Match": a.version,
            "X-Reauth-Token": ctx.reauthToken ?? "",
            "Idempotency-Key": ctx.idempotencyKey,
          },
        },
      }),
    onSuccess: (data) => {
      onClose();
      notify(
        "success",
        `Undangan baru dikirim ke ${data.admin.email}, berlaku sampai ${formatDateTime(data.invitation_expires_at)}. Tautan lama tidak berlaku.`,
      );
    },
    onConflict: onClose,
    notify,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!resend.isPending}
      title="Kirim ulang undangan?"
      description={`Tautan undangan baru dikirim ke ${a.email}; tautan sebelumnya langsung tidak berlaku.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={resend.isPending}>
            Batal
          </Button>
          <Button loading={resend.isPending} onClick={() => resend.mutate({})}>
            Kirim ulang undangan
          </Button>
        </>
      }
    >
      <FormError message={form.formState.errors.root?.server?.message} />
    </Dialog>
  );
}

const emailSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email wajib diisi.")
    .max(254, "Email terlalu panjang.")
    .pipe(z.email({ error: "Format email tidak valid." })),
});
type EmailValues = z.infer<typeof emailSchema>;

function EmailDialog({ admin: a, onClose, notify }: DialogProps) {
  const form = useForm<EmailValues>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: a.email },
  });
  const correct = useDetailMutation<Detail, EmailValues>({
    admin: a,
    reauthReason: `Mengoreksi email login ${a.display_name}`,
    form,
    fields: ["email"],
    request: (v, ctx) =>
      api.PATCH("/admin/admins/{adminId}", {
        params: {
          path: { adminId: a.id },
          header: { "If-Match": a.version, "X-Reauth-Token": ctx.reauthToken ?? "" },
        },
        body: { email: v.email.trim() },
      }),
    onSuccess: (data) => {
      onClose();
      notify(
        "success",
        data.status === "invited"
          ? `Email login diganti ke ${data.email}; undangan baru dikirim ke alamat ini.`
          : `Email login diganti ke ${data.email}; dipakai saat undangan dikirim ulang.`,
      );
    },
    onConflict: onClose,
    notify,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!correct.isPending}
      title="Koreksi email login"
      description="Hanya untuk admin yang belum pernah aktif. Token undangan lama langsung tidak berlaku."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={correct.isPending}>
            Batal
          </Button>
          <Button
            loading={correct.isPending}
            onClick={() => void form.handleSubmit((v) => correct.mutate(v))()}
          >
            Simpan email
          </Button>
        </>
      }
    >
      <FormError message={form.formState.errors.root?.server?.message} />
      <FormField<EmailValues, "email"> control={form.control} name="email" label="Email login baru" required>
        {(field, a11y) => <Input {...field} {...a11y} type="email" autoComplete="off" />}
      </FormField>
    </Dialog>
  );
}

const recoverSchema = z.object({
  reason: reasonField,
  email: z
    .string()
    .trim()
    .max(254, "Email terlalu panjang.")
    .refine((v) => v === "" || z.email().safeParse(v).success, "Format email tidak valid."),
  acknowledged: z.literal(true, "Centang pernyataan ini."),
});
type RecoverValues = z.infer<typeof recoverSchema>;

function RecoverDialog({ admin: a, onClose, notify }: DialogProps) {
  const form = useForm<RecoverValues>({
    resolver: zodResolver(recoverSchema),
    defaultValues: { reason: "", email: "", acknowledged: false as unknown as true },
  });
  const recover = useDetailMutation<components["schemas"]["AdminRecoveryResult"], RecoverValues>({
    admin: a,
    reauthReason: `Memulihkan akun ${a.display_name}`,
    form,
    fields: ["reason", "email"],
    request: (v, ctx) =>
      api.POST("/admin/admins/{adminId}/recovery", {
        params: {
          path: { adminId: a.id },
          header: {
            "If-Match": a.version,
            "X-Reauth-Token": ctx.reauthToken ?? "",
            "Idempotency-Key": ctx.idempotencyKey,
          },
        },
        body: { reason: v.reason.trim(), ...(v.email.trim() ? { email: v.email.trim() } : {}) },
      }),
    onSuccess: (data) => {
      onClose();
      notify(
        "success",
        `Sandi dan autentikator ${data.admin.display_name} direset, ${data.revoked_session_count} sesi dicabut. Undangan pemulihan dikirim ke ${data.admin.email}, berlaku sampai ${formatDateTime(data.invitation_expires_at)}.`,
      );
    },
    onConflict: onClose,
    notify,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      dismissable={!recover.isPending}
      title="Pulihkan akun admin?"
      description={`Sandi dan autentikator ${a.display_name} direset, semua sesinya dicabut, dan undangan pemulihan dikirim lewat email. Admin wajib membuat sandi baru dan mendaftarkan autentikator lagi. Pengurus tidak pernah melihat sandi atau secret.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={recover.isPending}>
            Batal
          </Button>
          <Button
            variant="danger-solid"
            loading={recover.isPending}
            onClick={() => void form.handleSubmit((v) => recover.mutate(v))()}
          >
            Pulihkan akun
          </Button>
        </>
      }
    >
      <FormError message={form.formState.errors.root?.server?.message} />
      <FormField<RecoverValues, "reason">
        control={form.control}
        name="reason"
        label="Alasan pemulihan"
        required
        hint="Mis. perangkat autentikator hilang, identitas diverifikasi lewat telepon. Jangan menulis sandi atau kode."
      >
        {(field, a11y) => <Textarea {...field} {...a11y} rows={3} maxLength={500} />}
      </FormField>
      <FormField<RecoverValues, "email">
        control={form.control}
        name="email"
        label="Email login baru (opsional)"
        hint={`Isi hanya bila admin kehilangan akses ke ${a.email}; pemberitahuan keamanan juga dikirim ke alamat lama.`}
      >
        {(field, a11y) => <Input {...field} {...a11y} type="email" autoComplete="off" />}
      </FormField>
      <AckField
        label="Saya sudah memverifikasi identitas admin ini di luar sistem."
        checked={form.watch("acknowledged") === true}
        onChange={(v) =>
          form.setValue("acknowledged", v as true, { shouldValidate: form.formState.isSubmitted })
        }
        error={form.formState.errors.acknowledged?.message}
      />
    </Dialog>
  );
}

function DeleteDialog({ admin: a, onClose }: { admin: Detail; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const remove = useApiMutation<void, void>({
    requiresReauth: true,
    reauthReason: `Menghapus identitas admin ${a.display_name}`,
    toastErrors: false,
    request: (_v, ctx) =>
      api.DELETE("/admin/admins/{adminId}", {
        params: {
          path: { adminId: a.id },
          header: { "If-Match": a.version, "X-Reauth-Token": ctx.reauthToken ?? "" },
        },
      }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: adminDetailKey(a.id) });
      void queryClient.invalidateQueries({ queryKey: ADMINS_KEY });
      toast.success(`Identitas admin ${a.display_name} dihapus dan undangannya dibatalkan.`);
      await navigate({ to: "/admins" });
    },
    onReloadLatest: () => {
      onClose();
      void queryClient.invalidateQueries({ queryKey: adminDetailKey(a.id) });
    },
    onError: (error) => {
      if (error.ui.action === "reload_latest" || error.reauthCancelled) return;
      setMessage(Object.values(error.fieldErrors).flat().join(" ") || error.message);
    },
  });
  return (
    <ConfirmDialog
      open
      onCancel={onClose}
      onConfirm={() => remove.mutate()}
      pending={remove.isPending}
      title="Hapus identitas admin?"
      description={`Undangan ${a.display_name} dibatalkan permanen; email login dan tautan alumninya bebas dipakai undangan baru. Riwayat audit tetap ada.`}
      confirmLabel="Hapus identitas"
      confirmText={a.display_name}
    >
      <FormError message={message} />
    </ConfirmDialog>
  );
}
