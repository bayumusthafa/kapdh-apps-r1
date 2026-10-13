import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "../../auth/session";
import { AuthLayout } from "../../components/layout/AuthLayout";
import { Button, buttonClass } from "../../components/ui/Button";
import { UnderConstruction } from "../../components/ui/States";

/**
 * /login/enroll: pendaftaran TOTP admin undangan (F-16, PRD 8.2 langkah 4-5). Menurut kontrak admin-auth final,
 * satu-satunya jalan ke sini adalah respons penerimaan undangan (`totp_enrollment_required: true`, token
 * pendaftaran 30 menit); login tidak pernah membuka pendaftaran. Layar pendaftaran (QR otpauth, verifikasi kode,
 * backup code) dibangun irisan governance bersama halaman /invite.
 */
export function EnrollPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  return (
    <AuthLayout
      title="Daftarkan autentikator"
      subtitle="Akun admin Anda belum memiliki aplikasi autentikator (TOTP). Pendaftaran wajib sebelum akun aktif."
    >
      <div className="rounded-lg border border-divider">
        <UnderConstruction
          feature="Pendaftaran autentikator untuk admin undangan"
          items={[
            "Pindai kode QR dengan aplikasi autentikator",
            "Konfirmasi dengan kode 6 digit",
            "Simpan backup code sekali pakai",
          ]}
        />
      </div>
      <p className="text-sm text-text-muted">
        Sementara itu, hubungi Super Admin KAPDH untuk bantuan aktivasi akun.
      </p>
      <Button
        variant="outline"
        fullWidth
        onClick={() => {
          auth.cancelLogin();
          void navigate({ to: "/login" });
        }}
      >
        Kembali ke halaman masuk
      </Button>
    </AuthLayout>
  );
}

/**
 * /invite#t=<token>: penerimaan undangan admin (ganti sandi awal lewat token sekali pakai lalu daftar TOTP, F-16).
 * Token dibaca dari fragmen URL (tidak pernah dari path/query). Layar ini belum membaca maupun mengirim token;
 * alurnya dibangun irisan governance.
 */
export function InvitePage() {
  return (
    <AuthLayout
      title="Undangan admin"
      subtitle="Aktivasi akun admin KAPDH melalui undangan dari Super Admin."
    >
      <div className="rounded-lg border border-divider">
        <UnderConstruction
          feature="Penerimaan undangan admin"
          items={["Buat kata sandi baru", "Daftarkan aplikasi autentikator", "Simpan backup code"]}
        />
      </div>
      <Link to="/login" className={buttonClass({ variant: "outline", fullWidth: true })}>
        Ke halaman masuk
      </Link>
    </AuthLayout>
  );
}
