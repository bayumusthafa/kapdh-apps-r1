import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, CircleX, Keyboard, ScanLine, TriangleAlert, WifiOff } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { refetchInBackground, useApiMutation, useApiQuery } from "../../api/query";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { RadioGroup } from "../../components/ui/Choice";
import { Avatar } from "../../components/ui/DataDisplay";
import { Field } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState, ErrorState, Loading } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { eventKeys } from "./api";
import { ANONYMOUS_HOLDER, CHECKIN_REJECTION, formatRange, formatSchedule, type ResultTone } from "./labels";
import { QrScanner } from "./QrScanner";
import { checkinRoute } from "./routes";

type CheckinEvent = components["schemas"]["AdminCheckinEvent"];
type CheckinResult = components["schemas"]["AdminCheckinResult"];
type RejectionDetail = components["schemas"]["AdminCheckinRejectionDetail"];
type CheckinTicket = components["schemas"]["AdminCheckinTicket"];

/** Daftar event pemindaian diperbarui berkala (jendela dan hitungan hadir); hanya refetch berkala berlabel latar. */
export const CHECKIN_EVENTS_POLL_MS = 60_000;
const QR_MAX = 256;

export type ScanOutcome =
  | { kind: "success"; result: CheckinResult }
  | { kind: "rejected"; detail: RejectionDetail; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "unknown"; message: string }
  | { kind: "error"; message: string };

function isRejectionDetail(value: unknown): value is RejectionDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    "rejection_reason" in value &&
    "ticket" in value &&
    typeof (value as { rejection_reason: unknown }).rejection_reason === "string"
  );
}

/** Peta galat API -> hasil pemindaian (AC F09-6, PRD 4.5). */
export function outcomeFromError(err: ApiError): ScanOutcome {
  if (err.status === 409 && isRejectionDetail(err.current))
    return { kind: "rejected", detail: err.current, message: err.message };
  if (err.code === "NOT_FOUND")
    return {
      kind: "not_found",
      message: `${err.message} Pastikan peserta menunjukkan QR tiket dari aplikasi KAPDH, bukan QR KTA.`,
    };
  if (err.code === "NETWORK" || err.status >= 500 || err.code === "UNKNOWN")
    return {
      kind: "unknown",
      message:
        "Status check-in belum diketahui karena koneksi terputus. Pindai atau kirim ulang kode yang sama; sistem tidak mencatat check-in dua kali.",
    };
  if (err.code === "IDEMPOTENCY_CONFLICT")
    return {
      kind: "unknown",
      message: "Permintaan bertabrakan dengan pemindaian sebelumnya. Pindai ulang kode tiket.",
    };
  if (err.code === "FORBIDDEN")
    return { kind: "error", message: "Akun Anda tidak lagi memiliki izin check-in (events.checkin)." };
  const first = Object.values(err.fieldErrors)[0];
  return { kind: "error", message: first?.join(" ") || err.message };
}

/**
 * Pemindai check-in tiket (AC F09-5, F09-6, D5; izin events.checkin): petugas memilih event yang jendelanya dibuka
 * dalam 24 jam, lalu memindai QR dengan kamera (@zxing/browser) atau mengetik kode (juga untuk pemindai genggam
 * yang berperilaku sebagai keyboard). Hasil tampil di kartu besar yang dibacakan pembaca layar: berhasil, "Sudah
 * check-in" dengan waktu dan petugas sebelumnya, atau ditolak dengan alasan yang dapat ditindaklanjuti. Setiap
 * pemindaian memakai Idempotency-Key; bila hasil belum diketahui (jaringan putus), kode yang sama dikirim ulang
 * dengan key yang sama sehingga tidak tercatat dua kali (PRD 4.3).
 */
export function CheckinPage() {
  const search = checkinRoute.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [scanSeq, setScanSeq] = useState(0);
  const [codeError, setCodeError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const list = useApiQuery({
    queryKey: eventKeys.checkinEvents,
    pollMs: CHECKIN_EVENTS_POLL_MS,
    request: ({ signal, headers }) => api.GET("/admin/checkin/events", { signal, headers }),
  });
  const events = useMemo(() => list.data?.items ?? [], [list.data]);
  const selectedId = search.event ?? (events.length === 1 ? events[0]!.id : null);
  const selected = events.find((e) => e.id === selectedId) ?? null;
  const [counts, setCounts] = useState<{ eventId: string; checkedIn: number; paid: number } | null>(null);

  const selectEvent = (id: string) => {
    setOutcome(null);
    setCounts(null);
    void navigate({ to: "/events/checkin", search: { event: id }, replace: true });
  };

  // Event terpilih siap: fokus ke isian kode agar petugas (atau pemindai genggam) dapat langsung bekerja (N-11).
  useEffect(() => {
    if (selected) inputRef.current?.focus();
  }, [selected?.id]);

  const checkin = useApiMutation<CheckinResult, { eventId: string; qr: string }>({
    // Niat = event + isi QR: ulang setelah hasil belum diketahui memakai key yang sama (PRD 4.3).
    intent: (v) => v,
    toastErrors: false,
    request: (v, ctx) =>
      api.POST("/admin/checkin", {
        params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: { event_id: v.eventId, qr_code: v.qr },
      }),
    onSuccess: (result, v) => {
      setOutcome({ kind: "success", result });
      setCounts({
        eventId: v.eventId,
        checkedIn: result.event_checked_in_count,
        paid: result.event_paid_count,
      });
      setScanSeq((n) => n + 1);
      setCode("");
      void refetchInBackground(queryClient, eventKeys.checkinEvents);
      void queryClient.invalidateQueries({ queryKey: eventKeys.detail(v.eventId) });
    },
    onError: (err, v) => {
      const next = outcomeFromError(err);
      setOutcome(next);
      setScanSeq((n) => n + 1);
      // Hasil diketahui: kosongkan untuk pemindaian berikutnya. Belum diketahui: kode (juga hasil kamera) dipasang
      // di isian agar petugas cukup menekan Check-in untuk mengirim ulang dengan key yang sama (PRD 4.3).
      setCode(next.kind === "unknown" ? v.qr : "");
    },
  });

  function submit(raw: string) {
    if (!selected) return;
    const qr = raw.trim();
    if (!qr) {
      setCodeError("Ketik atau pindai kode tiket.");
      inputRef.current?.focus();
      return;
    }
    if (qr.length > QR_MAX) {
      setCodeError(`Kode tiket maksimal ${QR_MAX} karakter.`);
      return;
    }
    setCodeError(null);
    if (checkin.isPending) return;
    checkin.mutate({ eventId: selected.id, qr });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit(code);
  }

  const shownCounts =
    selected && counts?.eventId === selected.id
      ? { checkedIn: counts.checkedIn, paid: counts.paid }
      : selected
        ? { checkedIn: selected.checked_in_count, paid: selected.paid_count }
        : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Check-in Tiket"
        description="Pilih event, lalu pindai QR tiket peserta dengan kamera atau ketik kodenya."
        breadcrumbs={[{ label: "Event dan Tiket", to: "/events" }, { label: "Check-in Tiket" }]}
      />

      <Card className="flex flex-col gap-3 pb-5">
        <CardHeader
          title="Event"
          description="Event dibuka atau ditutup yang jendela check-in-nya dibuka paling lambat 24 jam dari sekarang (D5)."
        />
        <div className="px-5">
          {list.isPending ? (
            <Loading label="Memuat event check-in..." rows={2} />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} compact />
          ) : events.length === 0 ? (
            <EmptyState
              compact
              title="Tidak ada event untuk dipindai"
              description="Belum ada event yang jendela check-in-nya dibuka dalam 24 jam ke depan."
            />
          ) : (
            <>
              {search.event && !selected ? (
                <p role="alert" className="mb-3 rounded-md bg-warning-bg p-3 text-sm text-warning">
                  Event yang dipilih belum atau tidak lagi tersedia untuk check-in: pemindai hanya memuat event
                  yang jendela check-in-nya dibuka paling lambat 24 jam lagi dan belum berakhir (D5). Pilih event
                  di bawah.
                </p>
              ) : null}
              <RadioGroup<string>
                legend="Pilih event yang dipindai"
                value={selected?.id ?? null}
                onValueChange={selectEvent}
                variant="card"
                options={events.map((e) => ({
                  value: e.id,
                  label: e.title,
                  description: <CheckinEventInfo event={e} />,
                }))}
              />
            </>
          )}
        </div>
      </Card>

      {selected ? (
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
            <Card className="flex flex-col gap-3 pb-5">
              <CardHeader
                title="Ketik kode tiket"
                description="Juga untuk pemindai genggam: arahkan pemindai lalu tekan Enter."
              />
              <form
                noValidate
                onSubmit={onSubmit}
                className="flex flex-col gap-3 px-5"
                aria-label="Check-in manual"
              >
                <Field label="Kode tiket" error={codeError} required>
                  {(a11y) => (
                    <Input
                      {...a11y}
                      ref={inputRef}
                      value={code}
                      maxLength={QR_MAX}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      leading={<Keyboard />}
                      onChange={(e) => {
                        setCode(e.target.value);
                        if (codeError) setCodeError(null);
                      }}
                    />
                  )}
                </Field>
                <Button
                  type="submit"
                  variant="gradient"
                  loading={checkin.isPending}
                  loadingText="Memeriksa..."
                >
                  Check-in
                </Button>
              </form>
            </Card>
            {/* Hasil tepat di bawah isian kode, dan di samping kamera pada layar lebar. */}
            {shownCounts ? (
              <p className="text-sm font-semibold text-primary" aria-live="polite">
                Hadir {shownCounts.checkedIn} dari {shownCounts.paid} tiket lunas
              </p>
            ) : null}
            <ScanResultCard outcome={outcome} seq={scanSeq} event={selected} />
          </div>
          <Card className="flex min-w-0 flex-[1_1_360px] flex-col gap-3 pb-5">
            <CardHeader title="Pindai dengan kamera" />
            <div className="px-5">
              <QrScanner paused={checkin.isPending} onDecode={submit} />
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function CheckinEventInfo({ event: e }: { event: CheckinEvent }) {
  return (
    <span className="flex flex-col gap-1">
      <span>
        {formatSchedule(e.starts_at, e.ends_at, e.timezone)}
        {e.location_name ? ` | ${e.location_name}` : ""}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone={e.checkin_open ? "success" : "warning"}>
          {e.checkin_open ? "Check-in dibuka" : "Check-in belum dibuka"}
        </Badge>
        <span>
          Jendela {formatRange(e.checkin_opens_at, e.checkin_closes_at, e.timezone)} | hadir{" "}
          {e.checked_in_count} dari {e.paid_count}
        </span>
      </span>
    </span>
  );
}

const TONE: Record<ResultTone | "neutral", { box: string; icon: ReactNode; iconCls: string }> = {
  success: { box: "border-success bg-success-bg", icon: <CircleCheck />, iconCls: "text-success" },
  warning: { box: "border-warning bg-warning-bg", icon: <TriangleAlert />, iconCls: "text-warning" },
  danger: { box: "border-danger bg-danger-bg", icon: <CircleX />, iconCls: "text-danger" },
  neutral: { box: "border-divider bg-surface", icon: <ScanLine />, iconCls: "text-primary" },
};

function HolderBlock({ ticket }: { ticket: CheckinTicket }) {
  const name = ticket.holder.full_name ?? ANONYMOUS_HOLDER;
  return (
    <div className="flex items-center gap-3">
      <Avatar name={name} src={ticket.holder.avatar_url} size="lg" />
      <div className="flex min-w-0 flex-col">
        <span className="font-heading text-h3 font-semibold text-text">{name}</span>
        <span className="text-sm text-text-muted">
          {[ticket.holder.member_number, ticket.holder.cohort_code].filter(Boolean).join(" | ") || "-"}
        </span>
      </div>
    </div>
  );
}

/**
 * Kartu hasil pemindaian besar (AC F09-5, F09-6): selalu terpasang sebagai region live agar setiap hasil baru
 * dibacakan; `seq` memastikan hasil yang sama berturut-turut tetap diumumkan ulang.
 */
export function ScanResultCard({
  outcome,
  seq,
  event,
}: {
  outcome: ScanOutcome | null;
  seq: number;
  event: CheckinEvent;
}) {
  let tone: ResultTone | "neutral" = "neutral";
  let title = "Siap memindai";
  let body: ReactNode = (
    <p className="text-sm text-text-muted">Hasil pemindaian untuk {event.title} tampil di sini.</p>
  );
  if (outcome?.kind === "success") {
    const r = outcome.result;
    tone = "success";
    title = "Check-in berhasil";
    body = (
      <>
        <HolderBlock ticket={r.ticket} />
        <p className="text-sm">
          Tercatat {formatDateTime(r.checked_in_at)} oleh {r.checked_in_by.display_name}.
        </p>
      </>
    );
  } else if (outcome?.kind === "rejected") {
    const d = outcome.detail;
    const copy = CHECKIN_REJECTION[d.rejection_reason];
    tone = copy.tone;
    title = copy.title;
    const t = d.ticket;
    body = (
      <>
        <HolderBlock ticket={t} />
        {d.rejection_reason === "already_checked_in" && t.checked_in_at ? (
          <p className="text-base font-semibold">
            Sebelumnya check-in {formatDateTime(t.checked_in_at)} oleh{" "}
            {t.checked_in_by?.display_name ?? "petugas"}.
          </p>
        ) : null}
        {d.rejection_reason === "other_event" ? (
          <p className="text-sm font-semibold">
            Tiket untuk: {t.event.title} ({formatDateTime(t.event.starts_at, t.event.timezone)})
          </p>
        ) : null}
        {d.rejection_reason === "too_early" || d.rejection_reason === "too_late" ? (
          <p className="text-sm font-semibold">
            Jendela check-in: {formatRange(d.checkin_opens_at, d.checkin_closes_at, t.event.timezone)}
          </p>
        ) : null}
        <p className="text-sm">{outcome.message}</p>
        <p className="flex items-start gap-1.5 text-sm font-medium">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {copy.action}
        </p>
      </>
    );
  } else if (outcome?.kind === "not_found") {
    tone = "danger";
    title = "QR tidak dikenal";
    body = <p className="text-sm">{outcome.message}</p>;
  } else if (outcome?.kind === "unknown") {
    tone = "warning";
    title = "Status belum diketahui";
    body = (
      <p className="flex items-start gap-1.5 text-sm">
        <WifiOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {outcome.message}
      </p>
    );
  } else if (outcome?.kind === "error") {
    tone = "danger";
    title = "Check-in gagal";
    body = <p className="text-sm">{outcome.message}</p>;
  }
  const style = TONE[tone];
  return (
    <section
      aria-label="Hasil pemindaian"
      aria-live="assertive"
      aria-atomic="true"
      data-result={outcome?.kind === "rejected" ? outcome.detail.rejection_reason : (outcome?.kind ?? "idle")}
      data-seq={seq}
      className={cn("flex min-h-64 flex-col gap-4 rounded-xl border-2 p-6 shadow-card", style.box)}
    >
      <h2 className={cn("flex items-center gap-3 font-heading text-h1 font-semibold", style.iconCls)}>
        <span aria-hidden="true" className="[&_svg]:size-10">
          {style.icon}
        </span>
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-text">{body}</div>
    </section>
  );
}
