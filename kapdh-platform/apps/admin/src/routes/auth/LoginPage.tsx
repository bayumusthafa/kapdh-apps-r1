import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useAuth } from "../../auth/session";
import { AuthLayout } from "../../components/layout/AuthLayout";
import { Button } from "../../components/ui/Button";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { PasswordInput } from "../../components/ui/PasswordInput";
import { emailSchema } from "../../lib/validation";

const schema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Kata sandi wajib diisi.").max(128, "Kata sandi terlalu panjang."),
});
type Values = z.infer<typeof schema>;

/**
 * Masuk web admin tahap 1: email + kata sandi (F-02, AC F02-2). Akun admin terpisah dari akun alumni (PRD 2.3).
 * Hasilnya hanya mfa_token; API admin baru dapat dipakai setelah TOTP/backup code. Tata letak guidelines hlm. 10.
 */
export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const search = useSearch({ from: "/login" });
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });
  const reason = auth.lastLogoutReason;

  const onSubmit = form.handleSubmit(async (values) => {
    const result = await auth.login(values.email.trim(), values.password);
    if (result.ok) {
      form.reset({ email: values.email, password: "" });
      await navigate({
        to: result.next === "enroll" ? "/login/enroll" : "/login/mfa",
        search: search.redirect ? { redirect: search.redirect } : {},
      });
      return;
    }
    const e = result.error;
    form.setValue("password", "");
    if (e.status === 401)
      form.setError("root.server", { type: "server", message: "Email atau kata sandi salah." });
    else if (e.code === "VALIDATION_ERROR" && Object.keys(e.fieldErrors).length > 0) {
      for (const [field, messages] of Object.entries(e.fieldErrors))
        if (field === "email" || field === "password")
          form.setError(field, { type: "server", message: messages.join(" ") });
    } else
      form.setError("root.server", {
        type: "server",
        message: e.retryAfterSeconds
          ? `${e.message} Coba lagi dalam ${e.retryAfterSeconds} detik.`
          : e.message,
      });
  });

  return (
    <AuthLayout title="Selamat Datang Kembali!" subtitle="Kelola data alumni KAPDH dengan mudah dan aman.">
      {reason === "idle" || reason === "expired" ? (
        <p role="status" className="rounded-md bg-warning-bg px-3 py-2.5 text-sm text-warning">
          {reason === "idle"
            ? "Sesi berakhir karena tidak ada aktivitas selama 30 menit. Silakan masuk kembali."
            : "Sesi berakhir. Silakan masuk kembali."}
        </p>
      ) : null}
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormError message={form.formState.errors.root?.server?.message} />
        <FormField<Values, "email"> control={form.control} name="email" label="Email" required>
          {(field, a11y) => (
            <Input
              {...field}
              {...a11y}
              type="email"
              autoComplete="username"
              inputMode="email"
              placeholder="Masukkan email admin"
            />
          )}
        </FormField>
        <FormField<Values, "password"> control={form.control} name="password" label="Kata sandi" required>
          {(field, a11y) => (
            <PasswordInput
              {...field}
              {...a11y}
              autoComplete="current-password"
              placeholder="Masukkan kata sandi"
            />
          )}
        </FormField>
        <Button
          type="submit"
          variant="gradient"
          fullWidth
          loading={form.formState.isSubmitting}
          loadingText="Memeriksa..."
        >
          Masuk
        </Button>
        <p className="text-xs text-text-muted">
          Gunakan akun admin KAPDH. Akun alumni pribadi tidak dapat dipakai di web admin.
        </p>
      </form>
    </AuthLayout>
  );
}
