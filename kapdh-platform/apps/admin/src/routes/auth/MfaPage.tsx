import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { safeRedirectPath } from "../../auth/guards";
import { useAuth } from "../../auth/session";
import { AuthLayout } from "../../components/layout/AuthLayout";
import { Button } from "../../components/ui/Button";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";

const totpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Masukkan 6 digit kode dari aplikasi autentikator."),
});
const backupSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9A-Fa-f]{10}$/, "Backup code terdiri dari 10 karakter (angka 0-9 dan huruf A-F)."),
});
type Values = { code: string };

/**
 * Masuk web admin tahap 2: TOTP 6 digit atau backup code sekali pakai (AC F02-2). Access token baru terbit
 * setelah tahap ini; refresh token disimpan server di cookie HttpOnly. Kode salah ditampilkan pada isian kode
 * (galat formulir 400 beserta sisa percobaan); mfa_token kedaluwarsa (401) meminta admin mulai ulang.
 */
export function MfaPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const search = useSearch({ from: "/login/mfa" });
  const [useBackup, setUseBackup] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(useBackup ? backupSchema : totpSchema),
    defaultValues: { code: "" },
  });

  const onSubmit = form.handleSubmit(async ({ code }) => {
    const err = await auth.verifyMfa(code.trim());
    if (!err) {
      await navigate({ href: safeRedirectPath(search.redirect) ?? "/", replace: true });
      return;
    }
    form.setValue("code", "");
    // Kontrak admin-auth: kode salah = 400 VALIDATION_ERROR dengan field_errors.totp_code/backup_code berisi sisa
    // percobaan (mfa_token tetap berlaku); 401 hanya bila mfa_token tidak berlaku lagi.
    const codeErrors = err.fieldErrors.totp_code ?? err.fieldErrors.backup_code;
    if (err.code === "VALIDATION_ERROR" && codeErrors) {
      form.setError("code", { type: "server", message: codeErrors.join(" ") }, { shouldFocus: true });
    } else if (err.status === 401)
      form.setError("root.server", {
        type: "server",
        message: "Sesi masuk sudah kedaluwarsa. Mulai ulang dari halaman masuk.",
      });
    else
      form.setError("root.server", {
        type: "server",
        message: err.retryAfterSeconds
          ? `${err.message} Coba lagi dalam ${err.retryAfterSeconds} detik.`
          : err.message,
      });
  });

  function toggleMode() {
    setUseBackup((v) => !v);
    form.reset({ code: "" });
  }

  return (
    <AuthLayout
      title="Verifikasi dua langkah"
      subtitle={
        useBackup
          ? "Masukkan salah satu backup code. Setiap kode hanya dapat dipakai sekali."
          : "Buka aplikasi autentikator lalu masukkan kode 6 digit untuk KAPDH Admin."
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormError message={form.formState.errors.root?.server?.message} />
        {useBackup ? (
          <FormField<Values, "code">
            key="backup"
            control={form.control}
            name="code"
            label="Backup code"
            required
          >
            {(field, a11y) => (
              <Input {...field} {...a11y} autoComplete="off" spellCheck={false} maxLength={10} autoFocus />
            )}
          </FormField>
        ) : (
          <FormField<Values, "code">
            key="totp"
            control={form.control}
            name="code"
            label="Kode autentikator"
            required
          >
            {(field, a11y) => (
              <Input
                {...field}
                {...a11y}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="6 digit"
                autoFocus
              />
            )}
          </FormField>
        )}
        <Button
          type="submit"
          variant="gradient"
          fullWidth
          loading={form.formState.isSubmitting}
          loadingText="Memeriksa..."
        >
          Verifikasi
        </Button>
        <Button variant="ghost" fullWidth onClick={toggleMode}>
          {useBackup ? "Pakai kode autentikator" : "Tidak bisa membuka autentikator? Pakai backup code"}
        </Button>
        <Button
          variant="ghost"
          fullWidth
          className="text-text-muted"
          onClick={() => {
            auth.cancelLogin();
            void navigate({ to: "/login", search: search.redirect ? { redirect: search.redirect } : {} });
          }}
        >
          Kembali ke halaman masuk
        </Button>
      </form>
    </AuthLayout>
  );
}
