import { Navigate, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useAuth } from "../auth/session";
import { Button, TextField } from "../components/ui";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.state.status === "restoring") return <RestoringScreen />;
  if (auth.state.status === "authenticated") return <Navigate to="/" />;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    const err = await auth.login(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
    setBusy(false);
    if (err) setError(err);
    else await navigate({ to: "/login/mfa" });
  }

  return (
    <AuthShell title="Masuk ke Web Admin" subtitle="Gunakan akun admin KAPDH, terpisah dari akun alumni.">
      {auth.lastLogoutReason === "idle" || auth.lastLogoutReason === "expired" ? (
        <p role="status" className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">
          {auth.lastLogoutReason === "idle"
            ? "Sesi berakhir karena tidak ada aktivitas selama 30 menit."
            : "Sesi berakhir. Silakan masuk kembali."}
        </p>
      ) : null}
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <TextField label="Email" name="email" type="email" autoComplete="username" required />
        <TextField
          label="Sandi"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          error={error}
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Memeriksa..." : "Masuk"}
        </Button>
      </form>
    </AuthShell>
  );
}

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-brand p-4">
      <div className="flex w-full max-w-md flex-col gap-6 rounded-xl border border-divider bg-surface p-8 shadow-card">
        <div className="flex flex-col gap-1">
          <span className="font-heading text-sm font-bold tracking-wide text-primary">KAPDH</span>
          <h1 className="font-heading text-h1 font-semibold">{title}</h1>
          <p className="text-sm text-text-muted">{subtitle}</p>
        </div>
        {children}
      </div>
    </main>
  );
}

/** Ditampilkan sebentar saat sesi dipulihkan dari cookie refresh setelah halaman dimuat ulang. */
export function RestoringScreen() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center text-sm text-text-muted"
    >
      Memuat sesi...
    </div>
  );
}
