import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { MailCheck, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { ApiError, toApiError } from "../../api/errors";
import { useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { AuthLayout } from "../../components/layout/AuthLayout";
import { AdminRoleBadge, Badge } from "../../components/ui/Badge";
import { Button, buttonClass } from "../../components/ui/Button";
import { KeyValueList } from "../../components/ui/DataDisplay";
import { FormError, FormField } from "../../components/ui/FormField";
import { PasswordInput } from "../../components/ui/PasswordInput";
import { newPasswordSchema, PasswordRules } from "../../components/ui/PasswordRules";
import { Loading } from "../../components/ui/States";
import { formatDateTime } from "../../lib/format";
import { PERMISSION_LABEL } from "../../lib/labels";

type Preview = components["schemas"]["AdminInvitationPreview"];

/** Batas panjang token sesuai kontrak AdminInvitationTokenRequest. */
const TOKEN_MIN = 16;
const TOKEN_MAX = 512;

/**
 * Ambil token undangan dari fragmen `#t=<token>` (kontrak admin-auth C1). Fragmen tidak pernah dikirim peramban ke
 * server/proxy maupun Referer, sehingga token tidak tercatat di log akses (ARCHITECTURE §2 butir 3).
 */
export function parseInviteToken(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const t = new URLSearchParams(raw).get("t");
  return t && t.length >= TOKEN_MIN && t.length <= TOKEN_MAX ? t : null;
}

const schema = z
  .object({
    password: newPasswordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Konfirmasi sandi tidak sama." });
type Values = z.infer<typeof schema>;

type Stage = { kind: "form" } | { kind: "invalid"; reason: "missing" | "expired" };

/**
 * /invite#t=<token>: penerimaan undangan admin (F-16, PRD 3.16 dan 8.2 langkah 2-3).
 * - Token dibaca SEKALI dari fragmen URL, fragmen segera dihapus dari bilah alamat lewat navigasi `replace`
 *   (history.replaceState) agar tidak tersimpan di riwayat atau tangkapan layar, lalu disimpan hanya di memori
 *   komponen dan dikirim di body JSON (tidak pernah di path/query).
 * - POST /admin/auth/invitations/preview menampilkan nama, peran, izin dan masa berlaku tanpa mengonsumsi token;
 *   410 OTP_EXPIRED = undangan tidak berlaku (tidak dibedakan sebabnya).
 * - POST /admin/auth/invitations/accept mengganti sandi awal (aturan byte PRD 2.5) dan menerbitkan token
 *   pendaftaran TOTP 30 menit; admin lanjut ke /login/enroll. Admin tetap `invited` sampai TOTP dikonfirmasi.
 */
export function InvitePage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const hash = useRouterState({ select: (s) => s.location.hash });
  // Dibaca sekali saat halaman dibuka; nilai di memori saja (bukan state URL, bukan penyimpanan peramban).
  const tokenRef = useRef<string | null | undefined>(undefined);
  if (tokenRef.current === undefined) tokenRef.current = parseInviteToken(hash);
  const token = tokenRef.current;
  const [stage, setStage] = useState<Stage>(token ? { kind: "form" } : { kind: "invalid", reason: "missing" });
  const authenticated = auth.state.status === "authenticated";

  // Hapus fragmen dari bilah alamat (history.replaceState lewat router) segera setelah token dibaca.
  useEffect(() => {
    if (hash) void navigate({ to: "/invite", replace: true });
  }, [hash, navigate]);

  const preview = useApiQuery<Preview>({
    queryKey: ["admin-invitation-preview"],
    enabled: stage.kind === "form" && token !== null && !authenticated,
    staleTime: Infinity,
    gcTime: 0,
    request: ({ signal }) =>
      api.POST("/admin/auth/invitations/preview", { body: { invite_token: token ?? "" }, signal }),
  });
  const previewGone = preview.error?.status === 410 || preview.error?.code === "OTP_EXPIRED";
  useEffect(() => {
    if (previewGone) setStage({ kind: "invalid", reason: "expired" });
  }, [previewGone]);

  if (authenticated && auth.profile)
    return (
      <AuthLayout title="Undangan admin" subtitle="Aktivasi akun admin KAPDH melalui undangan dari Super Admin.">
        <p role="note" className="rounded-md bg-warning-bg p-3 text-sm text-warning">
          Anda sedang masuk sebagai <strong>{auth.profile.display_name}</strong>. Undangan ini untuk identitas admin
          lain; keluar dahulu agar sesi Anda tidak tertimpa.
        </p>
        <Button variant="primary" fullWidth onClick={() => void auth.logout("manual")}>
          Keluar lalu lanjutkan undangan
        </Button>
        <Link to="/" className={buttonClass({ variant: "outline", fullWidth: true })}>
          Kembali ke Dashboard
        </Link>
      </AuthLayout>
    );

  if (stage.kind === "invalid")
    return (
      <AuthLayout title="Undangan admin" subtitle="Aktivasi akun admin KAPDH melalui undangan dari Super Admin.">
        <div role="alert" className="flex flex-col gap-2 rounded-md bg-danger-bg p-4 text-sm text-danger">
          <p className="font-semibold">
            {stage.reason === "missing" ? "Tautan undangan tidak lengkap" : "Undangan tidak berlaku"}
          </p>
          <p className="text-text">
            {stage.reason === "missing"
              ? "Buka tautan undangan persis seperti di email (termasuk bagian setelah tanda #). Bila tetap gagal, minta undangan ulang ke Super Admin."
              : "Undangan sudah kedaluwarsa, sudah dipakai, atau dibatalkan. Minta undangan baru ke Super Admin KAPDH."}
          </p>
        </div>
        <Link to="/login" className={buttonClass({ variant: "outline", fullWidth: true })}>
          Ke halaman masuk
        </Link>
      </AuthLayout>
    );

  return (
    <AuthLayout title="Undangan admin" subtitle="Aktivasi akun admin KAPDH melalui undangan dari Super Admin.">
      <Steps current={1} />
      {preview.isPending ? (
        <Loading label="Memeriksa undangan..." rows={3} />
      ) : preview.isError ? (
        <div role="alert" className="flex flex-col gap-3 rounded-md bg-danger-bg p-4 text-sm text-danger">
          <p>{preview.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => void preview.refetch()}>
            Coba lagi
          </Button>
        </div>
      ) : (
        <>
          <InvitationSummary preview={preview.data} />
          <AcceptForm
            token={token ?? ""}
            onGone={() => setStage({ kind: "invalid", reason: "expired" })}
            onAccepted={(mfaToken, expiresAt) => {
              auth.beginEnrollment(mfaToken, expiresAt);
              void navigate({ to: "/login/enroll", search: {} });
            }}
          />
        </>
      )}
    </AuthLayout>
  );
}

/** Tahapan aktivasi admin (PRD 8.2): sandi baru, autentikator, backup code. */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  const steps = ["Buat sandi", "Daftarkan autentikator", "Simpan backup code"];
  return (
    <ol aria-label="Tahapan aktivasi" className="flex flex-wrap gap-2 text-xs">
      {steps.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "selesai" : n === current ? "sedang berjalan" : "belum";
        return (
          <li
            key={label}
            aria-current={n === current ? "step" : undefined}
            className={
              n === current
                ? "rounded-pill bg-primary px-3 py-1 font-semibold text-on-primary"
                : n < current
                  ? "rounded-pill bg-green-100 px-3 py-1 font-semibold text-primary"
                  : "rounded-pill bg-neutral-bg px-3 py-1 text-text-muted"
            }
          >
            {n}. {label}
            <span className="sr-only"> ({state})</span>
          </li>
        );
      })}
    </ol>
  );
}

function InvitationSummary({ preview }: { preview: Preview }) {
  const all = preview.role === "super_admin";
  return (
    <section aria-labelledby="ringkasan-undangan" className="flex flex-col gap-3 rounded-lg border border-divider p-4">
      <h2 id="ringkasan-undangan" className="flex items-center gap-2 font-heading text-h3 font-semibold">
        <MailCheck aria-hidden="true" className="size-5 text-primary" />
        {preview.display_name}
      </h2>
      <KeyValueList
        items={[
          { label: "Email login", value: preview.email_masked },
          { label: "Peran", value: <AdminRoleBadge role={preview.role} /> },
          {
            label: "Diundang oleh",
            value: preview.invited_by_display_name ?? "Prosedur bootstrap Super Admin (PRD 8.2)",
          },
          { label: "Berlaku sampai", value: formatDateTime(preview.expires_at) },
          {
            label: "Izin setelah aktif",
            wide: true,
            value: all ? (
              <Badge tone="primary" icon={<ShieldCheck />}>
                Seluruh izin (Super Admin)
              </Badge>
            ) : preview.permissions.length === 0 ? (
              "Belum ada izin; Super Admin dapat menambahkannya kemudian."
            ) : (
              <ul aria-label="Izin undangan" className="mt-1 flex flex-wrap gap-1.5">
                {preview.permissions.map((p) => (
                  <li key={p}>
                    <Badge tone="info">{PERMISSION_LABEL[p] ?? p}</Badge>
                  </li>
                ))}
              </ul>
            ),
          },
        ]}
      />
    </section>
  );
}

function AcceptForm({
  token,
  onAccepted,
  onGone,
}: {
  token: string;
  onAccepted: (mfaToken: string, expiresAt: string) => void;
  onGone: () => void;
}) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", confirm: "" },
    mode: "onTouched",
  });
  const password = form.watch("password");

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const res = await api.POST("/admin/auth/invitations/accept", {
        body: { invite_token: token, password: values.password },
      });
      if (res.data) {
        form.reset({ password: "", confirm: "" });
        onAccepted(res.data.mfa_token, res.data.mfa_expires_at);
        return;
      }
      const err = ApiError.fromResponse(res.error, res.response.status);
      if (err.status === 410 || err.code === "OTP_EXPIRED") {
        onGone();
        return;
      }
      if (err.code === "VALIDATION_ERROR" && err.fieldErrors.password) {
        form.setError("password", { type: "server", message: err.fieldErrors.password.join(" ") }, {
          shouldFocus: true,
        });
        return;
      }
      form.setError("root.server", {
        type: "server",
        message: err.retryAfterSeconds ? `${err.message} Coba lagi dalam ${err.retryAfterSeconds} detik.` : err.message,
      });
    } catch (e) {
      form.setError("root.server", { type: "server", message: toApiError(e).message });
    }
  });

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4" aria-labelledby="judul-sandi-baru">
      <h2 id="judul-sandi-baru" className="font-heading text-h3 font-semibold">
        Buat sandi admin
      </h2>
      <FormError message={form.formState.errors.root?.server?.message} />
      <FormField<Values, "password">
        control={form.control}
        name="password"
        label="Sandi baru"
        required
        hint="Sandi ini khusus akun admin; jangan memakai sandi akun alumni pribadi Anda."
      >
        {(field, a11y) => (
          <PasswordInput
            {...field}
            {...a11y}
            aria-describedby={[a11y["aria-describedby"], "syarat-sandi-undangan"].filter(Boolean).join(" ")}
            autoComplete="new-password"
          />
        )}
      </FormField>
      <PasswordRules id="syarat-sandi-undangan" value={password} />
      <FormField<Values, "confirm"> control={form.control} name="confirm" label="Ulangi sandi baru" required>
        {(field, a11y) => <PasswordInput {...field} {...a11y} autoComplete="new-password" />}
      </FormField>
      <Button
        type="submit"
        variant="gradient"
        fullWidth
        loading={form.formState.isSubmitting}
        loadingText="Menyimpan..."
      >
        Simpan sandi dan lanjutkan
      </Button>
    </form>
  );
}
