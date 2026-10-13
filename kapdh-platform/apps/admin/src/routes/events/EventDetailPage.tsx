import type { components } from "@kapdh/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Ban, CalendarClock, CircleCheck, Hourglass, ImageOff, MapPin, Ticket, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge, EventStatusBadge } from "../../components/ui/Badge";
import { buttonClass } from "../../components/ui/Button";
import { Card, CardHeader, StatCard } from "../../components/ui/Card";
import { KeyValueList } from "../../components/ui/DataDisplay";
import { PageHeader } from "../../components/ui/PageHeader";
import { ErrorState, Loading, PageSkeleton } from "../../components/ui/States";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import { formatDateTime, formatRupiah } from "../../lib/format";
import { type AdminEventDetail, useEventDetail, useEventStats } from "./api";
import { CancelResultNotice, EventActions } from "./EventActions";
import { EventForm } from "./EventForm";
import { EventTicketsTab } from "./EventTicketsTab";
import { formatRange, formatSchedule } from "./labels";
import { type EventDetailTab, eventDetailRoute } from "./routes";

type CancelResult = components["schemas"]["AdminEventCancelResult"];

const TAB_PREFIX = "event-detail";

/**
 * Detail event (F-09, F-15): ringkasan informasi, kursi dan statistik; peserta/tiket; formulir ubah; serta aksi
 * terbit/tutup/buka kembali/batal/hapus sesuai `allowed_actions`. Tab disimpan di URL (?tab=) agar dapat ditautkan
 * dari tombol ubah pada tabel (guideline p14).
 */
export function EventDetailPage() {
  const { eventId } = eventDetailRoute.useParams();
  const { tab = "overview" } = eventDetailRoute.useSearch();
  const navigate = useNavigate();
  const detail = useEventDetail(eventId);
  const [cancelResult, setCancelResult] = useState<CancelResult | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);

  const setTab = (next: EventDetailTab) =>
    void navigate({ to: "/events/$eventId", params: { eventId }, search: next === "overview" ? {} : { tab: next } });

  // Pembatalan berhasil: dialog tertutup dan tombol pemicunya hilang; fokus ke ringkasan hasil (N-11).
  useEffect(() => {
    if (cancelResult) headingRef.current?.focus();
  }, [cancelResult]);

  if (detail.isPending) return <PageSkeleton />;
  if (detail.isError)
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Detail Event"
          breadcrumbs={[{ label: "Event dan Tiket", to: "/events" }, { label: "Detail Event" }]}
        />
        <Card>
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} title="Event gagal dimuat" />
        </Card>
      </div>
    );

  const e = detail.data;
  const canEdit = e.allowed_actions.includes("edit");
  const activeTab: EventDetailTab = tab === "edit" && !canEdit ? "overview" : tab;
  const tabs = [
    { value: "overview" as const, label: "Ringkasan" },
    { value: "tickets" as const, label: "Peserta & Tiket", count: e.held_quantity + e.paid_quantity },
    ...(canEdit ? [{ value: "edit" as const, label: "Ubah Event" }] : []),
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={e.title}
        breadcrumbs={[{ label: "Event dan Tiket", to: "/events" }, { label: e.title }]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <EventStatusBadge status={e.status} />
            <span>{formatSchedule(e.starts_at, e.ends_at, e.timezone)}</span>
          </span>
        }
        actions={<EventActions event={e} onEdit={() => setTab("edit")} onCancelled={setCancelResult} />}
      />

      {cancelResult ? (
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          <CancelResultNotice result={cancelResult} />
        </div>
      ) : null}
      {e.status === "cancelled" ? (
        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-bg p-4 text-sm text-danger">
          <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>
            <strong>Event dibatalkan</strong>
            {e.cancelled_at ? ` pada ${formatDateTime(e.cancelled_at)}` : ""}. Alasan: {e.cancel_reason ?? "-"}. QR
            seluruh tiket tidak berlaku; refund peserta berbayar diproses bendahara.
          </p>
        </div>
      ) : null}

      <Tabs label="Bagian detail event" items={tabs} value={activeTab} onValueChange={setTab} idPrefix={TAB_PREFIX} />

      {activeTab === "overview" ? (
        <TabPanel idPrefix={TAB_PREFIX} value="overview" className="flex flex-col gap-5 outline-none">
          <EventOverview event={e} />
        </TabPanel>
      ) : activeTab === "tickets" ? (
        <TabPanel idPrefix={TAB_PREFIX} value="tickets" className="outline-none">
          <EventTicketsTab event={e} />
        </TabPanel>
      ) : (
        <TabPanel idPrefix={TAB_PREFIX} value="edit" className="outline-none">
          <EventForm
            key={e.id}
            mode="edit"
            detail={e}
            onSaved={() => setTab("overview")}
            onCancel={() => setTab("overview")}
          />
        </TabPanel>
      )}
    </div>
  );
}

function EventOverview({ event: e }: { event: AdminEventDetail }) {
  const stats = useEventStats(e.id);
  const s = stats.data;
  const free = !/[1-9]/.test(e.price);
  return (
    <>
      <div className="flex flex-wrap gap-4" aria-label="Ringkasan kursi" role="group">
        <StatCard label="Total tiket" value={e.seats_total.toLocaleString("id-ID")} icon={<Ticket />} />
        <StatCard
          label="Sisa tiket"
          value={e.status === "cancelled" ? "-" : e.seats_available.toLocaleString("id-ID")}
          hint={e.status === "cancelled" ? "Event dibatalkan" : `Kuota minimal ${e.min_seats_total} (AC F15-2)`}
          icon={<Users />}
          tone={e.seats_available === 0 && e.status !== "cancelled" ? "danger" : "primary"}
        />
        <StatCard label="Ditahan" value={e.held_quantity} hint="Menunggu bayar atau verifikasi" icon={<Hourglass />} tone="warning" />
        <StatCard label="Terbayar" value={e.paid_quantity} icon={<CircleCheck />} tone="info" />
        <StatCard
          label="Hadir"
          value={e.checked_in_count}
          hint={e.paid_quantity > 0 ? `dari ${e.paid_quantity} tiket lunas` : undefined}
          icon={<CalendarClock />}
        />
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Card className="flex min-w-0 flex-[3_1_420px] flex-col gap-4 pb-5">
          <CardHeader title="Informasi Event" />
          <div className="flex flex-col gap-4 px-5">
            {e.cover_url ? (
              <img
                src={e.cover_url}
                alt={`Cover ${e.title}`}
                referrerPolicy="no-referrer"
                className="aspect-video w-full max-w-lg rounded-md bg-neutral-100 object-cover"
              />
            ) : (
              <span className="flex aspect-[3/1] w-full max-w-lg items-center justify-center gap-2 rounded-md bg-neutral-100 text-sm text-text-muted">
                <ImageOff aria-hidden="true" className="size-5" />
                Belum ada gambar cover
              </span>
            )}
            <KeyValueList
              items={[
                { label: "Kategori", value: e.category?.label ?? "Tanpa kategori" },
                { label: "Harga", value: free ? "Gratis" : formatRupiah(e.price) },
                { label: "Jadwal", value: formatSchedule(e.starts_at, e.ends_at, e.timezone), wide: true },
                {
                  label: "Periode pendaftaran",
                  value: formatRange(e.registration_opens_at, e.registration_closes_at, e.timezone),
                  wide: true,
                },
                {
                  label: "Jendela check-in",
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      {formatRange(e.effective_checkin_opens_at, e.effective_checkin_closes_at, e.timezone)}
                      <Badge tone={e.checkin_opens_at ? "info" : "neutral"}>
                        {e.checkin_opens_at ? "Khusus" : "Bawaan D5"}
                      </Badge>
                    </span>
                  ),
                  wide: true,
                },
                {
                  label: "Lokasi",
                  value: (
                    <span className="flex flex-col gap-0.5">
                      <span className="flex items-center gap-1">
                        <MapPin aria-hidden="true" className="size-4 text-primary" />
                        {e.location_name ?? "-"}
                      </span>
                      {e.location_address ? <span className="text-text-muted">{e.location_address}</span> : null}
                      {e.location_url ? (
                        <a
                          href={e.location_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-primary hover:underline"
                        >
                          Buka peta<span className="sr-only"> (tab baru)</span>
                        </a>
                      ) : null}
                    </span>
                  ),
                  wide: true,
                },
                { label: "Deskripsi", value: e.description ?? "-", wide: true },
                {
                  label: "Dibuat",
                  value: `${formatDateTime(e.created_at)}${e.created_by ? ` oleh ${e.created_by.display_name}` : ""}`,
                },
                { label: "Versi", value: `${e.version} (diubah ${formatDateTime(e.updated_at)})` },
              ]}
            />
          </div>
        </Card>

        <Card className="flex min-w-0 flex-[2_1_300px] flex-col gap-4 pb-5" aria-labelledby="statistik-event">
          <CardHeader
            titleId="statistik-event"
            title="Statistik"
            description={s ? `Diperbarui ${formatDateTime(s.generated_at)}` : undefined}
          />
          <div className="px-5">
            {stats.isPending ? (
              <Loading label="Memuat statistik event..." rows={4} />
            ) : stats.isError ? (
              <ErrorState error={stats.error} onRetry={() => void stats.refetch()} compact title="Statistik gagal dimuat" />
            ) : (
              <KeyValueList
                items={[
                  { label: "Menunggu pembayaran", value: s!.awaiting_payment_count },
                  { label: "Menunggu verifikasi", value: s!.awaiting_review_count },
                  { label: "Lunas", value: s!.paid_count },
                  { label: "Hadir (check-in)", value: s!.checked_in_count },
                  { label: "Kedaluwarsa", value: s!.expired_count },
                  { label: "Dibatalkan", value: s!.cancelled_count },
                  { label: "Pendapatan kotor", value: formatRupiah(s!.gross_revenue) },
                  { label: "Refund menunggu", value: formatRupiah(s!.refunds_pending_amount) },
                  { label: "Refund selesai", value: formatRupiah(s!.refunds_completed_amount) },
                  { label: "Pendapatan bersih", value: formatRupiah(s!.net_revenue) },
                ]}
              />
            )}
          </div>
          {e.status === "open" || e.status === "closed" ? (
            <div className="px-5">
              <Link to="/events/checkin" className={buttonClass({ variant: "outline", size: "sm" })}>
                Buka pemindai check-in
              </Link>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
