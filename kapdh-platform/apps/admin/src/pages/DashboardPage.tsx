import { Link } from "@tanstack/react-router";
import { useAuth } from "../auth/session";

export function DashboardPage() {
  const auth = useAuth();
  return (
    <section className="flex flex-col gap-4">
      <h1 className="font-heading text-h1 font-semibold">Dashboard</h1>
      <p className="text-sm text-text-muted">Ringkasan antrean dan job gagal ditambahkan pada irisan F-15.</p>
      {auth.can("payments.read") ? (
        <Link
          to="/payments"
          className="self-start rounded-md bg-primary px-4 py-3 text-sm font-semibold text-on-primary"
        >
          Buka antrean pembayaran
        </Link>
      ) : null}
    </section>
  );
}

export function NotBuiltPage({ title }: { title: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h1 className="font-heading text-h1 font-semibold">{title}</h1>
      <p className="text-sm text-text-muted">Halaman ini dibangun pada irisan berikutnya.</p>
    </section>
  );
}
