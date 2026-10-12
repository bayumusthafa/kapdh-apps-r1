import { zodResolver } from "@hookform/resolvers/zod";
import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import { api, ensureFreshAccessToken } from "../../api/client";
import { ApiError, toApiError } from "../../api/errors";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { FormError, FormField } from "./FormField";
import { Input } from "./Input";
import { PasswordInput } from "./PasswordInput";

/**
 * Reautentikasi untuk tindakan sensitif (AC F15-3, F16-1; ARCHITECTURE §4.3): admin memasukkan sandi dan kode
 * TOTP, POST /auth/reauth menerbitkan X-Reauth-Token (<= 10 menit, terikat sesi) yang dipakai untuk mengulang
 * permintaan yang tertunda. Sandi dan kode tidak disimpan; formulir dikosongkan setiap kali dialog ditutup.
 */
const schema = z.object({
  password: z.string().min(1, "Sandi wajib diisi.").max(128, "Sandi terlalu panjang."),
  totp_code: z.string().regex(/^\d{6}$/, "Masukkan 6 digit kode dari aplikasi autentikator."),
});
type Values = z.infer<typeof schema>;

export function ReauthDialog({
  open,
  reason,
  onResult,
}: {
  open: boolean;
  reason?: string;
  onResult: (token: string | null) => void;
}) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", totp_code: "" },
  });
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) form.reset({ password: "", totp_code: "" });
  }, [open, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      // /auth/reauth tidak di-refresh otomatis: 401 di sini berarti sandi/kode salah, jadi pastikan token segar.
      if (!(await ensureFreshAccessToken())) {
        form.setError("root.server", {
          type: "server",
          message: "Sesi tidak dapat diperbarui. Periksa koneksi lalu coba lagi.",
        });
        return;
      }
      const res = await api.POST("/auth/reauth", { body: values });
      if (res.data) {
        onResult(res.data.reauth_token);
        return;
      }
      const err = ApiError.fromResponse(res.error, res.response.status);
      if (res.response.status === 401) {
        form.setError("root.server", { type: "server", message: "Sandi atau kode autentikator salah." });
        form.setValue("totp_code", "");
      } else if (err.code === "VALIDATION_ERROR" && Object.keys(err.fieldErrors).length > 0) {
        for (const [field, messages] of Object.entries(err.fieldErrors)) {
          if (field === "password" || field === "totp_code")
            form.setError(field, { type: "server", message: messages.join(" ") });
        }
      } else {
        form.setError("root.server", {
          type: "server",
          message: err.retryAfterSeconds
            ? `${err.message} Coba lagi dalam ${err.retryAfterSeconds} detik.`
            : err.message,
        });
      }
    } catch (e) {
      form.setError("root.server", { type: "server", message: toApiError(e).message });
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Dialog
      open={open}
      onClose={() => onResult(null)}
      dismissable={!submitting}
      size="sm"
      initialFocusRef={passwordRef}
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
          Konfirmasi identitas
        </span>
      }
      description={
        <>
          {reason ? <span className="block font-medium text-text">{reason}</span> : null}
          Tindakan ini sensitif. Masukkan sandi dan kode autentikator untuk melanjutkan.
        </>
      }
    >
      <FormProvider {...form}>
        <form id="reauth-form" noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          <FormError message={form.formState.errors.root?.server?.message} />
          <FormField<Values, "password"> name="password" label="Sandi" required>
            {(field, a11y) => (
              <PasswordInput
                {...field}
                {...a11y}
                ref={(el) => {
                  field.ref(el);
                  passwordRef.current = el;
                }}
                autoComplete="current-password"
              />
            )}
          </FormField>
          <FormField<Values, "totp_code"> name="totp_code" label="Kode autentikator" required>
            {(field, a11y) => (
              <Input
                {...field}
                {...a11y}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="6 digit"
              />
            )}
          </FormField>
          <div className="flex flex-wrap justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => onResult(null)} disabled={submitting}>
              Batal
            </Button>
            <Button type="submit" loading={submitting} loadingText="Memeriksa...">
              Konfirmasi
            </Button>
          </div>
        </form>
      </FormProvider>
    </Dialog>
  );
}
