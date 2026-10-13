import type { components } from "@kapdh/contracts";
import { keepPreviousData } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
  CalendarDays,
  CircleAlert,
  CreditCard,
  Flag,
  RefreshCw,
  ServerCrash,
  Ticket,
  Users,
  Wallet,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge, EventStatusBadge, MembershipStatusBadge } from "../../components/ui/Badge";
import { Button, buttonClass } from "../../components/ui/Button";
import { Card, CardHeader, StatCard } from "../../components/ui/Card";
import { DataTable } from "../../components/ui/DataTable";
import { PageHeader } from "../../components/ui/PageHeader";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState, ErrorState, Loading } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { formatDate, formatDateTime, formatRelativeAge, formatRupiah } from "../../lib/format";
import { DELETED_ACCOUNT_LABEL, PAYMENT_TYPE_LABEL } from "../../lib/labels";

type Dashboard = components["schemas"]["AdminDashboard"];
type DashboardPayments = components["schemas"]["DashboardPayments"];
type DashboardModeration = components["schemas"]["DashboardModeration"];
type DashboardJobs = components["schemas"]["DashboardJobs"];
type TypeCounts = components["schemas"]["DashboardPaymentTypeCounts"];
type Member = components["schemas"]["DashboardMember"];
type TicketSales = components["schemas"]["DashboardTicketSales"];
type UpcomingEvent = components["schemas"]["DashboardUpcomingEvent"];
type Transaction = components["schemas"]["DashboardTransaction"];
type PaymentItem = components["schemas"]["AdminPaymentItem"];

export const DASHBOARD_KEY = ["admin-dashboard"] as const;
/** Auto-refresh dasbor; hanya refetch berkala yang berlabel latar sehingga idle timeout tetap berjalan (AC F02-5). */
export const DASHBOARD_POLL_MS = 60_000;
/** Jumlah baris hasil cari Riwayat Transaksi (cuplikan; daftar lengkap di /payments). */
export const TRANSACTION_SEARCH_LIMIT = 10;

/**
 * Dasbor pengurus (F-15, AC F15-1, PRD 3.15, guideline hlm. 11-12): kartu Pengguna Aktif, Total Transaksi dan
 * Tiket Terjual; antrean kerja yang perlu tindakan (pembayaran menunggu dan lewat batas, penyesuaian/refund,
 * laporan terbuka/mendesak/lewat target, event mendatang, job gagal); tabel Pengguna, Penjualan Tiket dan Riwayat
 * Transaksi. Server hanya mengirim bagian yang diizinkan, sehingga admin pembayaran tanpa izin lain hanya melihat
 * data pembayaran. Usia antrean dihitung dari `generated_at` server, bukan jam perangkat.
 */
export function DashboardPage() {
  const dashboard = useApiQuery({
    queryKey: DASHBOARD_KEY,
    pollMs: DASHBOARD_POLL_MS,
    request: ({ signal, headers }) => api.GET("/admin/dashboard", { signal, headers }),
  });
  const d = dashboard.data;
  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          d
            ? `Ringkasan pekerjaan sesuai izin Anda. Diperbarui ${formatDateTime(d.generated_at)}.`
            : "Ringkasan pekerjaan yang perlu tindakan sesuai izin Anda."
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
            loading={dashboard.isFetching && !dashboard.isPending}
            loadingText="Memuat ulang..."
            onClick={() => void dashboard.refetch()}
          >
            Muat ulang
          </Button>
        }
      />
      {dashboard.isPending ? (
        <Card className="p-2">
          <Loading label="Memuat dasbor..." rows={6} />
        </Card>
      ) : dashboard.isError ? (
        <Card>
          <ErrorState
            error={dashboard.error}
            onRetry={() => void dashboard.refetch()}
            title="Dasbor gagal dimuat"
          />
        </Card>
      ) : (
        <DashboardContent dashboard={dashboard.data} />
      )}
    </>
  );
}

function DashboardContent({ dashboard: d }: { dashboard: Dashboard }) {
  const generatedAt = new Date(d.generated_at);
  const hasStats = Boolean(d.members || d.payments || d.events);
  const hasQueues = Boolean(d.payments || d.moderation || d.jobs || d.upcoming_events);
  if (!hasStats && !hasQueues)
    return (
      <Card>
        <EmptyState
          title="Belum ada ringkasan untuk izin Anda"
          description="Dasbor hanya menampilkan data modul yang diizinkan. Hubungi Super Admin bila Anda memerlukan akses modul tertentu."
        />
      </Card>
    );
  return (
    <>
      {hasStats ? (
        <section aria-label="Statistik" className="flex flex-wrap gap-4">
          {d.members ? (
            <StatCard
              label="Pengguna Aktif"
              value={d.members.active_count}
              hint={`dari ${d.members.total_alumni} total alumni`}
              icon={<Users />}
            />
          ) : null}
          {d.payments ? (
            <StatCard
              label="Total Transaksi"
              value={formatRupiah(d.payments.paid_total_amount)}
              hint={`${d.payments.paid_count} pembayaran lunas`}
              icon={<Wallet />}
            />
          ) : null}
          {d.events ? (
            <StatCard
              label="Tiket Terjual"
              value={d.events.tickets_sold_count}
              hint="semua event"
              icon={<Ticket />}
            />
          ) : null}
        </section>
      ) : null}

      {hasQueues ? (
        <section aria-labelledby="dasbor-tindakan" className="flex flex-col gap-3">
          <h2 id="dasbor-tindakan" className="font-heading text-h3 font-semibold text-primary">
            Perlu tindakan
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {d.payments ? <PaymentsQueue payments={d.payments} now={generatedAt} /> : null}
            {d.moderation ? <ModerationQueue moderation={d.moderation} now={generatedAt} /> : null}
            {d.jobs ? <JobsQueue jobs={d.jobs} now={generatedAt} /> : null}
            {d.upcoming_events ? <UpcomingEvents events={d.upcoming_events} /> : null}
          </div>
        </section>
      ) : null}

      {d.members || d.events ? (
        <div className="grid gap-5 xl:grid-cols-2">
          {d.members ? <MembersTable members={d.members.latest_members} /> : null}
          {d.events ? <TicketSalesTable sales={d.events.ticket_sales} /> : null}
        </div>
      ) : null}

      {d.payments ? <TransactionsCard snapshot={d.payments.recent_transactions} /> : null}
    </>
  );
}

// ------------------------------------------------------------------------------------------------------------
// Antrean kerja

interface QueueItem {
  label: string;
  value: ReactNode;
  /** Butuh tindakan (nilai > 0): teks tebal + ikon, bukan warna saja (ARCHITECTURE §2 butir 10). */
  attention?: boolean;
  detail?: ReactNode;
}

function QueueCard({
  id,
  title,
  icon,
  items,
  footer,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  items: QueueItem[];
  footer?: ReactNode;
}) {
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-3 pb-4">
      <CardHeader
        titleId={id}
        title={
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="text-primary [&_svg]:size-5">
              {icon}
            </span>
            {title}
          </span>
        }
      />
      <dl className="flex flex-col gap-2 px-5 text-sm">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex flex-col gap-0.5 border-b border-divider pb-2 last:border-b-0"
          >
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-text-muted">{item.label}</dt>
              <dd className={cn("flex items-center gap-1 font-semibold", item.attention && "text-danger")}>
                {item.attention ? <CircleAlert aria-hidden="true" className="size-4" /> : null}
                {item.value}
              </dd>
            </div>
            {item.detail ? <dd className="text-xs text-text-muted">{item.detail}</dd> : null}
          </div>
        ))}
      </dl>
      {footer ? <div className="px-5">{footer}</div> : null}
    </Card>
  );
}

/** "Pendaftaran 2, Perpanjangan 1, Tiket event 1" (jenis bernilai nol dihilangkan). */
export function typeBreakdown(counts: TypeCounts): string | null {
  const parts = (Object.keys(PAYMENT_TYPE_LABEL) as (keyof TypeCounts)[])
    .filter((t) => counts[t] > 0)
    .map((t) => `${PAYMENT_TYPE_LABEL[t]} ${counts[t]}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function PaymentsQueue({ payments: p, now }: { payments: DashboardPayments; now: Date }) {
  return (
    <QueueCard
      id="antrean-pembayaran"
      title="Pembayaran"
      icon={<CreditCard />}
      items={[
        {
          label: "Bukti menunggu verifikasi",
          value: p.awaiting_review_count,
          detail: [
            typeBreakdown(p.awaiting_review_by_type),
            p.oldest_submitted_at
              ? `terlama menunggu ${formatRelativeAge(p.oldest_submitted_at, now)}`
              : null,
          ]
            .filter(Boolean)
            .join("; "),
        },
        {
          label: "Lewat batas review",
          value: p.overdue_count,
          attention: p.overdue_count > 0,
          detail: typeBreakdown(p.overdue_by_type),
        },
        {
          label: "Penyesuaian/refund tertunda",
          value: p.adjustments_pending_count,
          attention: p.adjustments_overdue_count > 0,
          detail: p.adjustments_overdue_count > 0 ? `${p.adjustments_overdue_count} lewat tenggat` : null,
        },
        {
          label: "Instruksi menunggu transfer",
          value: p.awaiting_transfer_count,
          detail: "Informasi, belum ada bukti.",
        },
      ]}
      footer={
        <Link to="/payments" className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-4" })}>
          Buka antrean pembayaran
        </Link>
      }
    />
  );
}

function ModerationQueue({ moderation: m, now }: { moderation: DashboardModeration; now: Date }) {
  return (
    <QueueCard
      id="antrean-moderasi"
      title="Moderasi"
      icon={<Flag />}
      items={[
        {
          label: "Laporan terbuka",
          value: m.open_count,
          detail: m.oldest_open_created_at
            ? `terlama ${formatRelativeAge(m.oldest_open_created_at, now)}`
            : "Tidak ada laporan terbuka.",
        },
        {
          label: "Mendesak (target 24 jam)",
          value: m.urgent_count,
          attention: m.urgent_count > 0,
        },
        { label: "Lewat target penanganan", value: m.overdue_count, attention: m.overdue_count > 0 },
      ]}
      footer={
        <Link to="/moderation" className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-4" })}>
          Buka antrean moderasi
        </Link>
      }
    />
  );
}

function JobsQueue({ jobs: j, now }: { jobs: DashboardJobs; now: Date }) {
  return (
    <QueueCard
      id="antrean-job"
      title="Job gagal"
      icon={<ServerCrash />}
      items={[
        {
          label: "Pengiriman notifikasi gagal",
          value: j.failed_delivery_count,
          attention: j.failed_delivery_count > 0,
          detail: (
            <>
              Dapat dikirim ulang, sejak {formatDate(j.failed_delivery_since)}.{" "}
              <Link
                to="/notifications"
                search={{ since: j.failed_delivery_since }}
                className="font-semibold text-primary underline-offset-2 hover:underline"
              >
                Lihat pengiriman gagal
              </Link>
            </>
          ),
        },
        {
          label: "Event outbox berhenti",
          value: j.dead_outbox_count,
          attention: j.dead_outbox_count > 0,
          detail: (
            <Link
              to="/notifications"
              search={{ tab: "outbox" }}
              className="font-semibold text-primary underline-offset-2 hover:underline"
            >
              Lihat event outbox
            </Link>
          ),
        },
        {
          label: "Outbox gagal (dicoba ulang otomatis)",
          value: j.failed_outbox_count,
          detail: j.oldest_pending_outbox_at
            ? `Outbox tertua menunggu ${formatRelativeAge(j.oldest_pending_outbox_at, now)}.`
            : "Tidak ada outbox yang menunggu.",
        },
        {
          label: "Penghapusan akun gagal",
          value: j.failed_account_deletion_count,
          detail: "Dilanjutkan otomatis oleh worker; telusuri log bila tidak turun.",
        },
      ]}
    />
  );
}

function UpcomingEvents({ events }: { events: UpcomingEvent[] }) {
  const auth = useAuth();
  const canManage = auth.can("events.manage");
  return (
    <Card aria-labelledby="antrean-event" className="flex flex-col gap-3 pb-4">
      <CardHeader
        titleId="antrean-event"
        title={
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="text-primary [&_svg]:size-5">
              <CalendarDays />
            </span>
            Event mendatang
          </span>
        }
        description="30 hari ke depan."
      />
      {events.length === 0 ? (
        <p className="px-5 text-sm text-text-muted">Tidak ada event dalam 30 hari ke depan.</p>
      ) : (
        <ul className="flex flex-col gap-2 px-5 text-sm">
          {events.map((e) => (
            <li
              key={e.event_id}
              className="flex flex-col gap-0.5 border-b border-divider pb-2 last:border-b-0"
            >
              {canManage ? (
                <Link
                  to="/events/$eventId"
                  params={{ eventId: e.event_id }}
                  className="font-semibold text-primary underline-offset-2 hover:underline"
                >
                  {e.title}
                </Link>
              ) : (
                <span className="font-semibold">{e.title}</span>
              )}
              <span className="text-xs text-text-muted">
                {formatDateTime(e.starts_at, e.timezone)}
                {e.location_name ? ` | ${e.location_name}` : ""}
              </span>
              <span className="text-xs">
                Terjual {e.sold_count}/{e.seats_total}, ditahan {e.held_count}, check-in {e.checked_in_count}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!canManage && auth.can("events.checkin") ? (
        <div className="px-5">
          <Link
            to="/events/checkin"
            className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-4" })}
          >
            Buka check-in tiket
          </Link>
        </div>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------------
// Tabel

function MembersTable({ members }: { members: Member[] }) {
  const columns = useMemo<ColumnDef<Member>[]>(
    () => [
      { id: "no", header: "#", cell: ({ row }) => row.index + 1, meta: { headerClassName: "w-10" } },
      { id: "name", header: "Nama", meta: { rowHeader: true }, cell: ({ row }) => row.original.full_name },
      {
        id: "status",
        header: "Status KTA",
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            <MembershipStatusBadge status={row.original.effective_status} />
            {row.original.linked_admin ? <Badge tone="info">Admin</Badge> : null}
          </span>
        ),
      },
      {
        id: "number",
        header: "No. KTA",
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.member_number ?? "-"}</span>,
      },
    ],
    [],
  );
  return (
    <Card aria-labelledby="dasbor-pengguna" className="flex flex-col gap-3 pb-4">
      <CardHeader
        titleId="dasbor-pengguna"
        title="Pengguna"
        description="Alumni terdaftar terbaru."
        actions={
          <Link to="/members" className={buttonClass({ variant: "ghost", size: "sm" })}>
            Lihat semua
          </Link>
        }
      />
      <div className="px-3">
        <DataTable<Member>
          caption="Pengguna terbaru"
          columns={columns}
          data={members}
          getRowId={(m) => m.user_id}
          status="success"
          minWidth={420}
          emptyState={<EmptyState compact title="Belum ada alumni terdaftar" />}
        />
      </div>
    </Card>
  );
}

function TicketSalesTable({ sales }: { sales: TicketSales[] }) {
  const columns = useMemo<ColumnDef<TicketSales>[]>(
    () => [
      { id: "no", header: "#", cell: ({ row }) => row.index + 1, meta: { headerClassName: "w-10" } },
      {
        id: "title",
        header: "Nama Event",
        meta: { rowHeader: true },
        cell: ({ row }) => (
          <span className="flex flex-col">
            <Link
              to="/events/$eventId"
              params={{ eventId: row.original.event_id }}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {row.original.title}
            </Link>
            <span className="text-xs text-text-muted">
              {formatDate(row.original.starts_at, row.original.timezone)}
            </span>
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <EventStatusBadge status={row.original.status} />,
      },
      {
        id: "sold",
        header: "Terjual",
        meta: { align: "right" },
        cell: ({ row }) => `${row.original.sold_count}/${row.original.seats_total}`,
      },
      {
        id: "available",
        header: "Sisa",
        meta: { align: "right" },
        cell: ({ row }) => row.original.seats_available,
      },
      {
        id: "review",
        header: "Menunggu review",
        meta: { align: "right" },
        cell: ({ row }) => row.original.awaiting_review_count,
      },
    ],
    [],
  );
  return (
    <Card aria-labelledby="dasbor-tiket" className="flex flex-col gap-3 pb-4">
      <CardHeader
        titleId="dasbor-tiket"
        title="Penjualan Tiket"
        description="Event terbaru selain draf."
        actions={
          <Link to="/events" className={buttonClass({ variant: "ghost", size: "sm" })}>
            Lihat semua
          </Link>
        }
      />
      <div className="px-3">
        <DataTable<TicketSales>
          caption="Penjualan tiket per event"
          columns={columns}
          data={sales}
          getRowId={(s) => s.event_id}
          status="success"
          minWidth={560}
          emptyState={<EmptyState compact title="Belum ada event" />}
        />
      </div>
    </Card>
  );
}

interface TransactionRow {
  id: string;
  type: Transaction["type"];
  eventTitle: string | null;
  name: string | null;
  memberNumber: string | null;
  amount: string;
  paidAt: string | null;
}

function fromSnapshot(t: Transaction): TransactionRow {
  return {
    id: t.payment_id,
    type: t.type,
    eventTitle: t.event_title,
    name: t.member.full_name,
    memberNumber: t.member.member_number,
    amount: t.amount,
    paidAt: t.paid_at,
  };
}

function fromPayment(p: PaymentItem): TransactionRow {
  return {
    id: p.id,
    type: p.type,
    eventTitle: p.event_title,
    name: p.member?.full_name ?? null,
    memberNumber: p.member?.member_number ?? null,
    amount: p.amount,
    paidAt: p.decided_at,
  };
}

/**
 * Riwayat Transaksi (guideline hlm. 12). Tanpa kata kunci: cuplikan `recent_transactions` dasbor. Dengan kata kunci:
 * pencarian server GET /admin/payments?status=paid&q=&sort=decided_at_desc (kontrak admin-dashboard, PRD 3.15).
 */
function TransactionsCard({ snapshot }: { snapshot: Transaction[] }) {
  const [q, setQ] = useState("");
  const term = q.trim();
  const search = useApiQuery({
    queryKey: ["admin-payments", "paid-search", term],
    enabled: term.length > 0,
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/payments", {
        params: {
          query: { status: "paid", q: term, sort: "decided_at_desc", limit: TRANSACTION_SEARCH_LIMIT },
        },
        signal,
        headers,
      }),
  });
  const rows = term ? search.data?.items.map(fromPayment) : snapshot.map(fromSnapshot);
  const columns = useMemo<ColumnDef<TransactionRow>[]>(
    () => [
      {
        id: "name",
        header: "Nama",
        meta: { rowHeader: true },
        cell: ({ row }) => row.original.name ?? DELETED_ACCOUNT_LABEL,
      },
      {
        id: "number",
        header: "No. KTA",
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.memberNumber ?? "-"}</span>,
      },
      {
        id: "type",
        header: "Kategori",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span>{PAYMENT_TYPE_LABEL[row.original.type]}</span>
            {row.original.eventTitle ? (
              <span className="text-xs text-text-muted">{row.original.eventTitle}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "date",
        header: "Tanggal",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => formatDate(row.original.paidAt),
      },
      {
        id: "amount",
        header: "Total",
        meta: { align: "right", cellClassName: "whitespace-nowrap font-semibold" },
        cell: ({ row }) => formatRupiah(row.original.amount),
      },
    ],
    [],
  );
  return (
    <Card aria-labelledby="dasbor-transaksi" className="flex flex-col gap-3 pb-4">
      <CardHeader
        titleId="dasbor-transaksi"
        title="Riwayat Transaksi"
        description={
          term ? "Hasil pencarian pembayaran lunas, keputusan terbaru dahulu." : "Pembayaran lunas terbaru."
        }
        actions={
          <Link to="/payments" className={buttonClass({ variant: "ghost", size: "sm" })}>
            Lihat semua
          </Link>
        }
      />
      <div className="px-3">
        <DataTable<TransactionRow>
          caption="Riwayat transaksi"
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          status={term ? search.status : "success"}
          error={search.error}
          onRetry={() => void search.refetch()}
          isFetching={term.length > 0 && search.isFetching && search.isPlaceholderData}
          minWidth={640}
          toolbar={
            <SearchInput
              label="Cari transaksi"
              labelHidden
              value={q}
              onValueChange={setQ}
              placeholder="Cari nama atau nomor KTA..."
              className="flex-[1_1_280px]"
            />
          }
          emptyState={
            <EmptyState
              compact
              title={term ? "Tidak ada transaksi yang cocok" : "Belum ada transaksi lunas"}
              description={term ? "Periksa ejaan nama atau awalan nomor KTA." : undefined}
            />
          }
        />
      </div>
    </Card>
  );
}
