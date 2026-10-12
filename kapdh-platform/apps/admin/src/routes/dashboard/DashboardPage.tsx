import { Link } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";
import { useAuth } from "../../auth/session";
import { usePendingPaymentsCount } from "../../components/layout/usePendingPayments";
import { buttonClass } from "../../components/ui/Button";
import { Card, StatCard } from "../../components/ui/Card";
import { PageHeader } from "../../components/ui/PageHeader";
import { UnderConstruction } from "../../components/ui/States";

/**
 * Dasbor pengurus (F-15). Kartu pembayaran menunggu sudah memakai data API (izin payments.read). Ringkasan lain
 * (antrean terlambat, laporan terbuka, event mendatang, job gagal) dibangun irisan governance setelah kontrak
 * admin-dashboard tersedia; semuanya tersaring sesuai izin (AC F15-1).
 */
export function DashboardPage() {
  const auth = useAuth();
  const pending = usePendingPaymentsCount();
  const canPayments = auth.can("payments.read");
  return (
    <>
      <PageHeader title="Dashboard" description="Ringkasan pekerjaan yang perlu tindakan sesuai izin Anda." />
      {canPayments ? (
        <div className="flex flex-wrap gap-4">
          <StatCard
            label="Pembayaran menunggu"
            value={pending.data ?? (pending.isError ? "-" : 0)}
            hint={pending.isError ? "Jumlah gagal dimuat" : "Perlu diverifikasi admin"}
            icon={<CreditCard />}
            tone="warning"
            loading={pending.isPending}
            action={
              <Link
                to="/payments"
                className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-4" })}
              >
                Buka antrean pembayaran
              </Link>
            }
          />
        </div>
      ) : null}
      <Card>
        <UnderConstruction
          feature="Ringkasan dasbor lengkap"
          items={[
            "Reservasi dan antrean yang terlambat",
            "Laporan moderasi terbuka",
            "Event mendatang",
            "Job atau notifikasi yang gagal",
          ]}
        />
      </Card>
    </>
  );
}
