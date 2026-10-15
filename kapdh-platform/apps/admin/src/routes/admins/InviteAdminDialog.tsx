import { zodResolver } from "@hookform/resolvers/zod";
import type { components, Permission } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MailCheck } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { useApiMutation, useApiQuery } from "../../api/query";
import { MembershipStatusBadge } from "../../components/ui/Badge";
import { Button, buttonClass } from "../../components/ui/Button";
import { RadioGroup } from "../../components/ui/Choice";
import { Avatar } from "../../components/ui/DataDisplay";
import { Dialog } from "../../components/ui/Dialog";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState, ErrorState, Loading } from "../../components/ui/States";
import { formatDateTime } from "../../lib/format";
import { ADMINS_KEY, CatalogGate, PermissionEditor } from "./shared";

type Candidate = components["schemas"]["AdminCandidate"];
type InvitationResult = components["schemas"]["AdminInvitationResult"];
type AdminRole = components["schemas"]["AdminRole"];

/** Alasan alumni tidak dapat didelegasikan (kontrak AdminCandidateIneligibleReason). */
export const INELIGIBLE_LABEL: Record<components["schemas"]["AdminCandidateIneligibleReason"], string> = {
  already_admin: "Sudah tertaut ke identitas admin",
  account_inactive: "Akun belum terverifikasi atau dinonaktifkan",
  suspended: "Sedang dibatasi pengurus (suspend)",
};

type Mode = "alumni" | "email";

const schema = z
  .object({
    mode: z.enum(["alumni", "email"]),
    alumni_user_id: z.string().optional(),
    email: z.string().trim().max(254, "Email terlalu panjang."),
    display_name: z.string().trim().max(120, "Nama tampilan maksimal 120 karakter."),
    role: z.enum(["admin", "super_admin"]),
    permissions: z.array(z.string()),
  })
  .superRefine((v, ctx) => {
    const emailOk = z.email().safeParse(v.email).success;
    if (v.mode === "email") {
      if (v.email === "")
        ctx.addIssue({ code: "custom", path: ["email"], message: "Email login wajib diisi." });
      if (v.display_name === "")
        ctx.addIssue({ code: "custom", path: ["display_name"], message: "Nama tampilan wajib diisi." });
    }
    if (v.email !== "" && !emailOk)
      ctx.addIssue({ code: "custom", path: ["email"], message: "Format email tidak valid." });
  });
type Values = z.infer<typeof schema>;

/**
 * "Delegasi User jadi Admin" (F-16, PRD 3.16, guideline hlm. 15): Super Admin memilih alumni (pencarian nama, No.
 * KTA atau email; alumni yang tidak memenuhi syarat ditandai alasannya) atau mengundang lewat email, lalu menentukan
 * peran dan izin berlabel. Sistem membuat identitas admin BARU yang terpisah dari akun alumni; tautan undangan hanya
 * dikirim lewat email (tidak pernah tampil di layar). Wajib Idempotency-Key (AC F16-1); reautentikasi tidak
 * diminta (keputusan PO 2026-10-15, ADR-025: reautentikasi hanya untuk kirim ulang undangan, koreksi email login dan
 * pemulihan).
 */
export function InviteAdminDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("alumni");
  const [step, setStep] = useState<"pick" | "details">("pick");
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [result, setResult] = useState<InvitationResult | null>(null);
  const [q, setQ] = useState("");
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { mode: "alumni", email: "", display_name: "", role: "admin", permissions: [] },
  });
  const role = form.watch("role");
  const permissions = form.watch("permissions") as Permission[];

  const candidates = useApiQuery({
    queryKey: [...ADMINS_KEY, "candidates", { q }],
    enabled: open && mode === "alumni" && step === "pick",
    request: ({ signal, headers }) =>
      api.GET("/admin/admins/candidates", {
        params: { query: { limit: 20, ...(q ? { q } : {}) } },
        signal,
        headers,
      }),
  });

  const invite = useApiMutation<InvitationResult, Values, Values>({
    setError: form.setError,
    request: (v, ctx) =>
      api.POST("/admin/admins", {
        params: {
          header: { "Idempotency-Key": ctx.idempotencyKey },
        },
        body: {
          ...(v.alumni_user_id ? { alumni_user_id: v.alumni_user_id } : {}),
          ...(v.email ? { email: v.email } : {}),
          ...(v.display_name ? { display_name: v.display_name } : {}),
          role: v.role,
          permissions: v.role === "super_admin" ? [] : (v.permissions as Permission[]),
        },
      }),
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ADMINS_KEY });
    },
  });

  function reset() {
    setMode("alumni");
    setStep("pick");
    setChosen(null);
    setResult(null);
    setQ("");
    form.reset({ mode: "alumni", email: "", display_name: "", role: "admin", permissions: [] });
    invite.reset();
  }

  function close() {
    reset();
    onClose();
  }

  function pick(c: Candidate) {
    setChosen(c);
    form.reset({
      mode: "alumni",
      alumni_user_id: c.user_id,
      email: "",
      display_name: "",
      role: "admin",
      permissions: [],
    });
    setStep("details");
  }

  function changeMode(next: Mode) {
    setMode(next);
    setChosen(null);
    setStep(next === "email" ? "details" : "pick");
    form.reset({ mode: next, email: "", display_name: "", role: "admin", permissions: [] });
  }

  const errors = form.formState.errors;
  return (
    <Dialog
      open={open}
      onClose={close}
      dismissable={!invite.isPending}
      size="lg"
      title="Delegasi User jadi Admin"
      description="Pilih alumni yang akan dijadikan admin, atau undang lewat email. Identitas admin terpisah dari akun alumni."
    >
      {result ? (
        <div className="flex flex-col gap-4">
          <div
            role="status"
            className="flex items-start gap-3 rounded-md bg-success-bg p-4 text-sm text-success"
          >
            <MailCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <div className="flex flex-col gap-1 text-text">
              <p className="font-semibold text-success">Undangan dijadwalkan</p>
              <p>
                Tautan undangan dikirim ke <strong>{result.admin.email}</strong> dan berlaku sampai{" "}
                {formatDateTime(result.invitation_expires_at)}. Tautan tidak ditampilkan di sini; admin baru
                wajib membuat sandi dan mendaftarkan autentikator sebelum aktif.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="outline" onClick={reset}>
              Undang admin lain
            </Button>
            <Link
              to="/admins/$adminId"
              params={{ adminId: result.admin.id }}
              className={buttonClass({ variant: "primary" })}
              onClick={close}
            >
              Lihat detail admin
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <RadioGroup<Mode>
            legend="Sumber undangan"
            orientation="horizontal"
            value={mode}
            onValueChange={changeMode}
            options={[
              {
                value: "alumni",
                label: "Pilih alumni",
                description: "Tertaut untuk cek konflik kepentingan",
              },
              { value: "email", label: "Undang lewat email", description: "Admin tanpa akun alumni" },
            ]}
          />

          {mode === "alumni" && step === "pick" ? (
            <div className="flex flex-col gap-3">
              <SearchInput
                label="Cari alumni"
                labelHidden
                value={q}
                onValueChange={setQ}
                placeholder="Cari nama, No. KTA, atau email..."
              />
              {candidates.isPending ? (
                <Loading label="Mencari alumni..." rows={3} />
              ) : candidates.isError ? (
                <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} compact />
              ) : candidates.data.items.length === 0 ? (
                <EmptyState compact title="Alumni tidak ditemukan" description="Ubah kata kunci pencarian." />
              ) : (
                <ul aria-label="Kandidat admin" className="flex flex-col gap-2">
                  {candidates.data.items.map((c) => (
                    <li
                      key={c.user_id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-divider p-3"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar name={c.full_name} src={c.avatar_url} />
                        <div className="flex min-w-0 flex-col text-sm">
                          <span className="font-semibold">{c.full_name}</span>
                          <span className="font-mono text-xs">{c.member_number ?? "Belum bernomor"}</span>
                          <span className="break-all text-xs text-text-muted">{c.email}</span>
                          {c.profession ? (
                            <span className="text-xs text-text-muted">{c.profession}</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <MembershipStatusBadge status={c.effective_status} />
                        {c.eligible ? (
                          <Button
                            size="sm"
                            aria-label={`Jadikan Admin ${c.full_name}`}
                            onClick={() => pick(c)}
                          >
                            Jadikan Admin
                          </Button>
                        ) : (
                          <span className="text-xs text-text-muted">
                            Tidak dapat dipilih:{" "}
                            {c.ineligible_reason ? INELIGIBLE_LABEL[c.ineligible_reason] : ""}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {step === "details" ? (
            <form
              noValidate
              className="flex flex-col gap-4"
              onSubmit={(e) => void form.handleSubmit((v) => invite.mutate(v))(e)}
            >
              <FormError message={errors.root?.server?.message} />
              {chosen ? (
                <div className="flex flex-col gap-2 rounded-md bg-green-50 p-3 text-sm">
                  <p>
                    Alumni terpilih: <strong>{chosen.full_name}</strong> (
                    {chosen.member_number ?? "belum bernomor"})
                  </p>
                  {errors.alumni_user_id?.message ? (
                    <p role="alert" className="font-medium text-danger">
                      {errors.alumni_user_id.message}
                    </p>
                  ) : null}
                  <Button variant="ghost" size="sm" className="self-start" onClick={() => setStep("pick")}>
                    Ganti alumni
                  </Button>
                </div>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField<Values, "display_name">
                  control={form.control}
                  name="display_name"
                  label="Nama tampilan admin"
                  required={mode === "email"}
                  hint={chosen ? `Kosongkan untuk memakai "${chosen.full_name}".` : undefined}
                >
                  {(field, a11y) => <Input {...field} {...a11y} maxLength={120} autoComplete="off" />}
                </FormField>
                <FormField<Values, "email">
                  control={form.control}
                  name="email"
                  label="Email login admin"
                  required={mode === "email"}
                  hint={
                    chosen
                      ? `Kosongkan untuk memakai email akun alumni (${chosen.email}). Tautan undangan dikirim ke alamat ini.`
                      : "Tautan undangan dikirim ke alamat ini."
                  }
                >
                  {(field, a11y) => <Input {...field} {...a11y} type="email" autoComplete="off" />}
                </FormField>
              </div>
              <RadioGroup<AdminRole>
                legend="Peran"
                value={role}
                onValueChange={(v) => form.setValue("role", v, { shouldDirty: true })}
                error={errors.role?.message}
                options={[
                  { value: "admin", label: "Admin", description: "Hanya izin yang dipilih di bawah." },
                  {
                    value: "super_admin",
                    label: "Super Admin",
                    description:
                      "Semua izin termasuk mengelola admin, dengan sesi MFA; reautentikasi untuk tindakan kredensial.",
                  },
                ]}
              />
              {role === "admin" ? (
                <CatalogGate>
                  {(catalog) => (
                    <PermissionEditor
                      catalog={catalog}
                      value={permissions}
                      onChange={(next) => form.setValue("permissions", next, { shouldDirty: true })}
                      error={errors.permissions?.message}
                    />
                  )}
                </CatalogGate>
              ) : (
                <p className="rounded-md bg-info-bg p-3 text-sm text-info">
                  Super Admin memiliki seluruh izin. PRD 8.2 mensyaratkan minimal dua Super Admin aktif.
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-3">
                <Button variant="outline" onClick={close} disabled={invite.isPending}>
                  Batal
                </Button>
                <Button type="submit" loading={invite.isPending} loadingText="Mengirim...">
                  Kirim undangan
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
