import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Copy, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { ApiError, toApiError } from "../../api/errors";
import { useAuth } from "../../auth/session";
import { AuthLayout } from "../../components/layout/AuthLayout";
import { Button } from "../../components/ui/Button";
import { KeyValueList } from "../../components/ui/DataDisplay";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { QrCode } from "../../components/ui/QrCode";
import { Loading } from "../../components/ui/States";
import { formatDateTime } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { BackupCodesPanel } from "./BackupCodesPanel";
import { Steps } from "./InvitePage";

type Enrollment = components["schemas"]["AdminTotpEnrollment"];
type EnrollmentResult = components["schemas"]["AdminTotpEnrollmentResult"];

const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Masukkan 6 digit kode dari aplikasi autentikator."),
});
type Values = z.infer<typeof codeSchema>;

/** Secret base32 dikelompokkan per 4 karakter agar mudah diketik manual. */
export function groupSecret(secret: string): string {
  return secret.replace(/=+$/, "").replace(/(.{4})(?=.)/g, "$1 ");
}

type Stage =
  | { kind: "starting" }
  | { kind: "scan"; enrollment: Enrollment }
  | { kind: "codes"; result: EnrollmentResult }
  /** Token pendaftaran tidak berlaku (401): kedaluwarsa 30 menit, dinonaktifkan, atau diundang ulang. */
  | { kind: "expired" }
  /** Aktivasi sudah selesai (403), mis. respons konfirmasi sebelumnya hilang. */
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * /login/enroll: pendaftaran TOTP admin undangan (F-02, F-16, PRD 8.2 langkah 4-5). Satu-satunya kredensial adalah
 * token pendaftaran dari penerimaan undangan (audience kapdh-admin-enroll, 30 menit, hanya di memori).
 * - POST /admin/auth/totp/enroll: QR dari `otpauth_uri` dibangkitkan di peramban (rahasia tidak dikirim ke pihak
 *   ketiga) beserta secret teks sebagai alternatif aksesibel (N-11). Boleh diulang selama token berlaku.
 * - POST /admin/auth/totp/confirm: kode benar mengaktifkan admin, menerbitkan 10 backup code (sekali tampil) dan
 *   sesi admin. Sesi baru dipasang SETELAH admin menyatakan backup code sudah disimpan.
 * - 401 = token tidak berlaku (minta undangan ulang); 403 = aktivasi sudah selesai (masuk lewat /login; backup
 *   code yang belum sempat disimpan dibuat ulang di halaman Akun); kode salah = galat isian beserta sisa percobaan.
 */
export function EnrollPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const state = auth.state;
  const mfaToken = state.status === "mfa" && state.enrollmentRequired ? state.mfaToken : null;
  const expiresAt = state.status === "mfa" ? state.expiresAt : undefined;
  const [stage, setStage] = useState<Stage>({ kind: "starting" });
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const started = useRef(false);

  const failFromStatus = useCallback((err: ApiError) => {
    if (err.status === 401) setStage({ kind: "expired" });
    else if (err.status === 403) setStage({ kind: "done" });
    else
      setStage({
        kind: "error",
        message: err.retryAfterSeconds
          ? `${err.message} Coba lagi dalam ${err.retryAfterSeconds} detik.`
          : err.message,
      });
  }, []);

  const start = useCallback(async () => {
    if (!mfaToken) return;
    setStage({ kind: "starting" });
    try {
      const res = await api.POST("/admin/auth/totp/enroll", { body: { mfa_token: mfaToken } });
      if (res.data) setStage({ kind: "scan", enrollment: res.data });
      else failFromStatus(ApiError.fromResponse(res.error, res.response.status));
    } catch (e) {
      failFromStatus(toApiError(e));
    }
  }, [mfaToken, failFromStatus]);

  // Mulai sekali per halaman (pengulangan membuat secret baru yang menggantikan secret sebelumnya).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  function backToLogin() {
    auth.cancelLogin();
    void navigate({ to: "/login", search: {} });
  }

  async function finish(result: EnrollmentResult) {
    setAdopting(true);
    setAdoptError(null);
    const err = await auth.completeEnrollment(result.session);
    setAdopting(false);
    if (!err) {
      void navigate({ href: "/", replace: true });
      return;
    }
    setAdoptError(
      err.status === 401
        ? "Aktivasi berhasil, tetapi sesi tidak dapat dipakai. Masuk lewat halaman masuk dengan sandi dan kode autentikator."
        : err.message,
    );
  }

  const subtitle =
    stage.kind === "codes"
      ? "Autentikator terdaftar dan akun admin Anda aktif."
      : "Akun admin wajib memakai aplikasi autentikator (TOTP) sebelum aktif.";

  return (
    <AuthLayout title="Daftarkan autentikator" subtitle={subtitle}>
      <Steps current={stage.kind === "codes" ? 3 : 2} />
      {expiresAt && (stage.kind === "scan" || stage.kind === "starting") ? <Deadline expiresAt={expiresAt} /> : null}

      {stage.kind === "starting" ? <Loading label="Menyiapkan kode QR..." rows={4} /> : null}

      {stage.kind === "scan" && mfaToken ? (
        <ScanAndConfirm
          enrollment={stage.enrollment}
          mfaToken={mfaToken}
          onRestart={() => void start()}
          onConfirmed={(result) => setStage({ kind: "codes", result })}
          onFailed={failFromStatus}
        />
      ) : null}

      {stage.kind === "codes" ? (
        <>
          <FormError message={adoptError} />
          <BackupCodesPanel
            codes={stage.result.backup_codes}
            generatedAt={stage.result.backup_codes_generated_at}
            doneLabel="Masuk ke Dashboard"
            pending={adopting}
            onDone={() => void finish(stage.result)}
          />
          {adoptError ? (
            <Button variant="outline" fullWidth onClick={backToLogin}>
              Ke halaman masuk
            </Button>
          ) : null}
        </>
      ) : null}

      {stage.kind === "expired" ? (
        <Outcome
          tone="danger"
          title="Waktu pendaftaran habis atau undangan tidak berlaku"
          body="Token pendaftaran hanya berlaku 30 menit sejak undangan diterima dan tidak dapat diperpanjang. Minta undangan ulang ke Super Admin KAPDH, lalu ulangi langkah aktivasi."
          action={
            <Button variant="outline" fullWidth onClick={backToLogin}>
              Ke halaman masuk
            </Button>
          }
        />
      ) : null}

      {stage.kind === "done" ? (
        <Outcome
          tone="success"
          title="Aktivasi sudah selesai"
          body="Masuk dengan sandi dan kode autentikator yang baru didaftarkan. Bila backup code belum sempat disimpan, buat ulang di halaman Akun setelah masuk; backup code lama otomatis tidak berlaku."
          action={
            <Button fullWidth onClick={backToLogin}>
              Masuk sekarang
            </Button>
          }
        />
      ) : null}

      {stage.kind === "error" ? (
        <Outcome
          tone="danger"
          title="Pendaftaran belum dapat dimulai"
          body={stage.message}
          action={
            <Button
              variant="outline"
              fullWidth
              leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
              onClick={() => void start()}
            >
              Coba lagi
            </Button>
          }
        />
      ) : null}

      {stage.kind === "scan" || stage.kind === "starting" || stage.kind === "error" ? (
        <Button variant="ghost" fullWidth className="text-text-muted" onClick={backToLogin}>
          Batalkan dan kembali ke halaman masuk
        </Button>
      ) : null}
    </AuthLayout>
  );
}

function Deadline({ expiresAt }: { expiresAt: string }) {
  const now = useNow(15_000);
  const minutes = Math.max(0, Math.ceil((Date.parse(expiresAt) - now.getTime()) / 60_000));
  return (
    <p className="rounded-md bg-info-bg px-3 py-2 text-sm text-info">
      Selesaikan sebelum {formatDateTime(expiresAt)} (sisa sekitar {minutes} menit).
    </p>
  );
}

function Outcome({
  tone,
  title,
  body,
  action,
}: {
  tone: "danger" | "success";
  title: string;
  body: string;
  action: ReactNode;
}) {
  return (
    <>
      <div
        role="alert"
        className={
          tone === "danger"
            ? "flex flex-col gap-1 rounded-md bg-danger-bg p-4 text-sm text-danger"
            : "flex flex-col gap-1 rounded-md bg-success-bg p-4 text-sm text-success"
        }
      >
        <p className="font-semibold">{title}</p>
        <p className="text-text">{body}</p>
      </div>
      {action}
    </>
  );
}

function ScanAndConfirm({
  enrollment,
  mfaToken,
  onRestart,
  onConfirmed,
  onFailed,
}: {
  enrollment: Enrollment;
  mfaToken: string;
  onRestart: () => void;
  onConfirmed: (result: EnrollmentResult) => void;
  onFailed: (err: ApiError) => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const form = useForm<Values>({ resolver: zodResolver(codeSchema), defaultValues: { code: "" } });

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setCopyStatus("Secret disalin ke papan klip.");
    } catch {
      setCopyStatus("Gagal menyalin otomatis. Ketik secret secara manual.");
    }
  }

  const onSubmit = form.handleSubmit(async ({ code }) => {
    try {
      const res = await api.POST("/admin/auth/totp/confirm", {
        body: { mfa_token: mfaToken, totp_code: code.trim() },
      });
      if (res.data) {
        onConfirmed(res.data);
        return;
      }
      const err = ApiError.fromResponse(res.error, res.response.status);
      form.setValue("code", "");
      if (err.code === "VALIDATION_ERROR" && err.fieldErrors.totp_code) {
        form.setError("code", { type: "server", message: err.fieldErrors.totp_code.join(" ") }, {
          shouldFocus: true,
        });
      } else if (err.status === 401 || err.status === 403) onFailed(err);
      else
        form.setError("root.server", {
          type: "server",
          message: err.retryAfterSeconds
            ? `${err.message} Coba lagi dalam ${err.retryAfterSeconds} detik.`
            : err.message,
        });
    } catch (e) {
      // Hasil tidak diketahui (jaringan): mengulang dengan token yang sama aman; bila percobaan sebelumnya
      // berhasil, server menjawab 403 "Aktivasi sudah selesai" (kontrak adminConfirmTotpEnrollment).
      form.setError("root.server", { type: "server", message: toApiError(e).message });
    }
  });

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="judul-pindai" className="flex flex-col gap-3">
        <h2 id="judul-pindai" className="font-heading text-h3 font-semibold">
          1. Pindai kode QR
        </h2>
        <p className="text-sm text-text-muted">
          Buka aplikasi autentikator (mis. Google Authenticator, Microsoft Authenticator, Aegis), pilih tambah akun,
          lalu pindai kode berikut.
        </p>
        <div className="flex justify-center">
          <QrCode value={enrollment.otpauth_uri} label="Kode QR pendaftaran autentikator KAPDH Admin" size={192} />
        </div>
        <div className="flex flex-col gap-2 rounded-md border border-divider p-3">
          <p className="text-xs text-text-muted">Tidak bisa memindai? Masukkan secret ini secara manual:</p>
          <p className="break-all font-mono text-sm font-semibold tracking-wider" aria-label="Secret autentikator">
            {groupSecret(enrollment.secret)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Copy aria-hidden="true" className="size-4" />}
              onClick={() => void copySecret()}
            >
              Salin secret
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
              onClick={onRestart}
            >
              Buat kode QR baru
            </Button>
          </div>
          <p role="status" aria-live="polite" className="text-xs text-text-muted">
            {copyStatus}
          </p>
          <KeyValueList
            className="pt-1"
            items={[
              { label: "Penerbit", value: enrollment.issuer },
              { label: "Akun", value: enrollment.account_name },
              { label: "Jenis", value: `Berbasis waktu, ${enrollment.algorithm}` },
              { label: "Kode", value: `${enrollment.digits} digit setiap ${enrollment.period_seconds} detik` },
            ]}
          />
        </div>
      </section>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4" aria-labelledby="judul-konfirmasi">
        <h2 id="judul-konfirmasi" className="font-heading text-h3 font-semibold">
          2. Konfirmasi kode
        </h2>
        <FormError message={form.formState.errors.root?.server?.message} />
        <FormField<Values, "code"> control={form.control} name="code" label="Kode autentikator" required>
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
        <Button
          type="submit"
          variant="gradient"
          fullWidth
          loading={form.formState.isSubmitting}
          loadingText="Memeriksa..."
        >
          Konfirmasi dan aktifkan akun
        </Button>
      </form>
    </div>
  );
}
