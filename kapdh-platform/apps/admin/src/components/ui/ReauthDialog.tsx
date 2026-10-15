import { zodResolver } from "@hookform/resolvers/zod";
import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import { api, hasFreshAccessToken, probeSession } from "../../api/client";
import { ApiError, toApiError } from "../../api/errors";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { FormError, FormField } from "./FormField";
import { Input } from "./Input";
import { PasswordInput } from "./PasswordInput";

/**
 * Reautentikasi untuk tindakan kredensial (ARCHITECTURE §4.3, ADR-025): admin memasukkan sandi dan kode
 * TOTP, POST /auth/reauth menerbitkan X-Reauth-Token (<= 10 menit, terikat sesi) yang dipakai untuk mengulang
 * permintaan yang tertunda. Sandi dan kode tidak disimpan; formulir dikosongkan setiap kali dialog ditutup.
 * Kredensial salah dijawab server 400 VALIDATION_ERROR per isian (`field_errors.password`/`totp_code`) dan
 * ditampilkan di isiannya. 401 berarti access token tidak berlaku: sesi diperiksa lebih dulu; bila sesi sudah
 * berakhir dialog ditutup dan admin dibawa ke halaman masuk (bukan terjebak di pesan yang keliru).
 */
const schema = z.object({
  password: z.string().min(1, "Sandi wajib diisi.").max(128, "Sandi terlalu panjang."),
  totp_code: z.string().regex(/^\d{6}$/, "Masukkan 6 digit kode dari aplikasi autentikator."),
});
type Values = z.infer<typeof schema>;

const SESSION_UNREACHABLE = "Server tidak dapat dihubungi. Periksa koneksi lalu coba lagi.";

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
      /**
       * Status sesi di luar kredensial: `ended` = sesi berakhir (onSessionExpired sudah membawa admin ke halaman
       * masuk; dialog ditutup tanpa token), `unavailable` = server tidak terjangkau.
       */
      const sessionProblem = (state: Awaited<ReturnType<typeof probeSession>>): boolean => {
        if (state === "ended") {
          onResult(null);
          return true;
        }
        if (state === "unavailable") {
          form.setError("root.server", { type: "server", message: SESSION_UNREACHABLE });
          return true;
        }
        return false;
      };
      // /auth/reauth tidak di-refresh otomatis (401 bisa berarti sandi/kode salah): pastikan token segar dulu.
      if (!hasFreshAccessToken() && sessionProblem(await probeSession())) return;
      const send = () => api.POST("/auth/reauth", { body: values });
      let res = await send();
      if (res.response.status === 401) {
        // 401 juga terjadi bila access token sudah tidak berlaku walau belum habis waktunya (diputar tab lain,
        // sesi dicabut). Periksa sesi; bila token baru saja diganti, kirim ulang sekali dengan token baru.
        const state = await probeSession();
        if (sessionProblem(state)) return;
        if (state === "renewed") res = await send();
      }
      if (res.data) {
        onResult(res.data.reauth_token);
        return;
      }
      const err = ApiError.fromResponse(res.error, res.response.status);
      if (res.response.status === 401) {
        form.setError("root.server", { type: "server", message: "Sandi atau kode autentikator salah." });
        form.setValue("totp_code", "");
      } else if (err.code === "VALIDATION_ERROR" && Object.keys(err.fieldErrors).length > 0) {
        // Kontrak auth: sandi/kode salah = 400 VALIDATION_ERROR per isian beserta sisa percobaan.
        for (const [field, messages] of Object.entries(err.fieldErrors)) {
          if (field === "password" || field === "totp_code")
            form.setError(field, { type: "server", message: messages.join(" ") });
        }
        // Kode TOTP hanya berlaku sekali per langkah: kosongkan agar admin memasukkan kode baru.
        if (err.fieldErrors.totp_code) form.setValue("totp_code", "");
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
