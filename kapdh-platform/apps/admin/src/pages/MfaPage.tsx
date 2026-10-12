import { Navigate, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useAuth } from "../auth/session";
import { Button, TextField } from "../components/ui";
import { AuthShell, RestoringScreen } from "./LoginPage";

/** Admin wajib TOTP sebelum API admin dapat dipakai (AC F02-2). */
export function MfaPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [useBackup, setUseBackup] = useState(false);

  if (auth.state.status === "restoring") return <RestoringScreen />;
  if (auth.state.status === "anonymous") return <Navigate to="/login" />;
  if (auth.state.status === "authenticated") return <Navigate to="/" />;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    if (!useBackup && !/^\d{6}$/.test(code)) {
      setError("Masukkan 6 digit kode dari aplikasi autentikator.");
      return;
    }
    if (useBackup && !/^[0-9A-Fa-f]{10}$/.test(code)) {
      setError("Backup code terdiri dari 10 karakter.");
      return;
    }
    setBusy(true);
    const err = await auth.verifyMfa(code);
    setBusy(false);
    if (err) setError(err);
    else await navigate({ to: "/" });
  }

  return (
    <AuthShell
      title="Verifikasi dua langkah"
      subtitle={
        useBackup
          ? "Masukkan salah satu backup code. Setiap kode hanya bisa dipakai sekali."
          : "Buka aplikasi autentikator dan masukkan kode 6 digit."
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {useBackup ? (
          <TextField
            key="backup"
            label="Backup code"
            name="code"
            autoComplete="off"
            maxLength={10}
            error={error}
            autoFocus
          />
        ) : (
          <TextField
            key="totp"
            label="Kode autentikator"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            error={error}
            autoFocus
          />
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "Memeriksa..." : "Verifikasi"}
        </Button>
        <button
          type="button"
          className="min-h-11 text-sm font-semibold text-primary underline"
          onClick={() => {
            setUseBackup((v) => !v);
            setError(null);
          }}
        >
          {useBackup ? "Pakai kode autentikator" : "Tidak bisa membuka autentikator? Pakai backup code"}
        </button>
      </form>
    </AuthShell>
  );
}
