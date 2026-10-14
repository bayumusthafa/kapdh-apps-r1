import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { formatInTimeZone } from "date-fns-tz";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Keyboard,
  ListOrdered,
  ScanLine,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
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
import { formatDateTime, zoneLabel } from "../../lib/format";
import { DELETED_ACCOUNT_LABEL } from "../../lib/labels";
import { eventKeys } from "./api";
import { CHECKIN_REJECTION, formatRange, formatSchedule, type ResultTone } from "./labels";
import { QrScanner } from "./QrScanner";
import { checkinRoute } from "./routes";

type CheckinEvent = components["schemas"]["AdminCheckinEvent"];
type CheckinResult = components["schemas"]["AdminCheckinResult"];
type RejectionDetail = components["schemas"]["AdminCheckinRejectionDetail"];
type CheckinTicket = components["schemas"]["AdminCheckinTicket"];

/** Daftar event pemindaian diperbarui berkala (jendela dan hitungan hadir); hanya refetch berkala berlabel latar. */
export const CHECKIN_EVENTS_POLL_MS = 60_000;
const QR_MAX = 256;
/** Jumlah hasil pemindaian yang disimpan di layar (kartu besar + daftar "Pemindaian sebelumnya"). */
export const SCAN_HISTORY_MAX = 6;

export type ScanOutcome =
  | { kind: "success"; result: CheckinResult }
  | { kind: "rejected"; detail: RejectionDetail; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "unknown"; message: string }
  | { kind: "error"; message: string };

/** Satu pemindaian yang dikirim atau menunggu dikirim; event dicatat saat dipindai. */
interface ScanRequest {
  eventId: string;
  qr: string;
}

/** Hasil satu pemindaian; `seq` dan `at` membuat setiap hasil berbeda walau isinya sama (N-11). */
export interface ScanEntry {
  seq: number;
  at: number;
  outcome: ScanOutcome;
}

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
        "Status check-in belum diketahui karena koneksi terputus. Kode disimpan: tekan Check-in atau pindai ulang kode yang sama untuk mengirim ulang; sistem tidak mencatat check-in dua kali.",
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

/** Judul, nada dan nama pemegang suatu hasil, dipakai kartu besar dan daftar pemindaian sebelumnya. */
function summarize(outcome: ScanOutcome): { tone: ResultTone; title: string; holder: string | null } {
  switch (outcome.kind) {
    case "success":
      return {
        tone: "success",
        title: "Check-in berhasil",
        holder: outcome.result.ticket.holder.full_name ?? DELETED_ACCOUNT_LABEL,
      };
    case "rejected": {
      const copy = CHECKIN_REJECTION[outcome.detail.rejection_reason];
      return {
        tone: copy.tone,
        title: copy.title,
        holder: outcome.detail.ticket.holder.full_name ?? DELETED_ACCOUNT_LABEL,
      };
    }
    case "not_found":
      return { tone: "danger", title: "QR tidak dikenal", holder: null };
    case "unknown":
      return { tone: "warning", title: "Status belum diketahui", holder: null };
    case "error":
      return { tone: "danger", title: "Check-in gagal", holder: null };
  }
}

/** "09.41.07 WIB" dalam zona event (PRD 2.1). */
function scanTime(at: number, timeZone: string): string {
  return `${formatInTimeZone(new Date(at), timeZone, "HH.mm.ss")} ${zoneLabel(timeZone)}`;
}

/**
 * Pemindai check-in tiket (AC F09-5, F09-6, D5; izin events.checkin): petugas memilih event yang jendelanya dibuka
 * dalam 24 jam, lalu memindai QR dengan kamera (@zxing/browser) atau mengetik kode (juga untuk pemindai genggam
 * yang berperilaku sebagai keyboard). Hasil tampil di kartu besar yang dibacakan pembaca layar: berhasil, "Sudah
 * check-in" dengan waktu dan petugas sebelumnya, atau ditolak dengan alasan yang dapat ditindaklanjuti. Setiap
 * pemindaian memakai Idempotency-Key; bila hasil belum diketahui (jaringan putus), kode yang sama dikirim ulang
 * dengan key yang sama sehingga tidak tercatat dua kali (PRD 4.3).
 *
 * Satu permintaan berjalan pada satu waktu. Isian dikosongkan saat kode dikirim sehingga pemindai genggam tidak
 * menyambung kode berikutnya ke kode lama. Kode yang dikirim saat pemindaian sebelumnya masih berjalan masuk
 * antrean dan dikirim berurutan setelah hasil sebelumnya diketahui; tidak ada kode yang hilang diam-diam. Hasil
 * yang tergantikan tetap terlihat di daftar "Pemindaian sebelumnya".
 */
export function CheckinPage() {
  const search = checkinRoute.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [history, setHistory] = useState<ScanEntry[]>([]);
  const seqRef = useRef(0);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Permintaan yang sedang berjalan (ref untuk keputusan sinkron, state untuk tampilan). */
  const inFlightRef = useRef<ScanRequest | null>(null);
  const [inFlight, setInFlight] = useState<ScanRequest | null>(null);
  /** Antrean kode yang dipindai saat permintaan lain berjalan, berurutan (FIFO). */
  const queueRef = useRef<ScanRequest[]>([]);
  const [queue, setQueueState] = useState<ScanRequest[]>([]);
  /** Antrean ditahan setelah hasil belum diketahui (koneksi bermasalah) sampai petugas mengirim ulang. */
  const [queuePaused, setQueuePaused] = useState(false);

  const setQueue = (next: ScanRequest[]) => {
    queueRef.current = next;
    setQueueState(next);
  };

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
    setHistory([]);
    setNotice(null);
    setCounts(null);
    void navigate({ to: "/events/checkin", search: { event: id }, replace: true });
  };

  // Event terpilih siap: fokus ke isian kode agar petugas (atau pemindai genggam) dapat langsung bekerja (N-11).
  useEffect(() => {
    if (selected) inputRef.current?.focus();
  }, [selected?.id]);

  function record(outcome: ScanOutcome) {
    seqRef.current += 1;
    const entry: ScanEntry = { seq: seqRef.current, at: Date.now(), outcome };
    setHistory((h) => [entry, ...h].slice(0, SCAN_HISTORY_MAX));
  }

  function settle() {
    inFlightRef.current = null;
    setInFlight(null);
  }

  const checkin = useApiMutation<CheckinResult, ScanRequest>({
    // Niat = event + isi QR: ulang setelah hasil belum diketahui memakai key yang sama (PRD 4.3).
    intent: (v) => v,
    toastErrors: false,
    request: (v, ctx) =>
      api.POST("/admin/checkin", {
        params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: { event_id: v.eventId, qr_code: v.qr },
      }),
    onSuccess: (result, v) => {
      record({ kind: "success", result });
      setCounts({
        eventId: v.eventId,
        checkedIn: result.event_checked_in_count,
        paid: result.event_paid_count,
      });
      setQueuePaused(false);
      settle();
      void refetchInBackground(queryClient, eventKeys.checkinEvents);
      void queryClient.invalidateQueries({ queryKey: eventKeys.detail(v.eventId) });
    },
    onError: (err, v) => {
      const next = outcomeFromError(err);
      record(next);
      if (next.kind === "unknown") {
        // Hasil belum diketahui (koneksi bermasalah): kode kembali ke depan antrean yang ditahan dan dikirim ulang
        // dengan key yang sama saat petugas menekan Check-in atau memindai ulang (PRD 4.3). Kode tidak dipasang
        // di isian agar pemindai genggam tidak menyambung kode berikutnya ke kode ini.
        setQueue([v, ...queueRef.current.filter((r) => !(r.eventId === v.eventId && r.qr === v.qr))]);
        setQueuePaused(true);
      } else setQueuePaused(false);
      settle();
    },
  });

  function send(req: ScanRequest) {
    inFlightRef.current = req;
    setInFlight(req);
    checkin.mutate(req);
  }

  // Antrean dikirim berurutan setelah hasil sebelumnya diketahui.
  useEffect(() => {
    if (inFlight || queuePaused || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    send(next!);
  }, [inFlight, queuePaused, queue]);

  /** Lanjutkan antrean yang ditahan: kode di depan dikirim ulang dengan key yang sama (PRD 4.3). */
  function resumeQueue() {
    setNotice(null);
    setQueuePaused(false);
  }

  /** Kirim kode; `fromField` = kode dari isian (diketik atau pemindai genggam), dikosongkan saat diterima. */
  function submit(raw: string, fromField: boolean) {
    if (!selected) return;
    const qr = raw.trim();
    const held = queuePaused && queueRef.current.length > 0;
    if (!qr) {
      if (fromField && held) {
        // Isian kosong saat ada kode tertahan: Check-in mengirim ulang kode tersebut.
        setCodeError(null);
        resumeQueue();
        return;
      }
      setCodeError("Ketik atau pindai kode tiket.");
      inputRef.current?.focus();
      return;
    }
    if (qr.length > QR_MAX) {
      setCodeError(`Kode tiket maksimal ${QR_MAX} karakter.`);
      return;
    }
    setCodeError(null);
    if (fromField) setCode("");
    const req: ScanRequest = { eventId: selected.id, qr };
    const same = (r: ScanRequest | null) => r !== null && r.eventId === req.eventId && r.qr === req.qr;
    if (same(inFlightRef.current)) {
      setNotice("Kode yang sama sedang diproses; tidak dikirim dua kali.");
      return;
    }
    if (queueRef.current.some(same)) {
      // Sudah di antrean: tidak digandakan. Memindai ulang kode yang tertahan berarti mengirimnya ulang.
      if (held) resumeQueue();
      else setNotice("Kode yang sama sudah di antrean; tidak dikirim dua kali.");
      return;
    }
    setNotice(null);
    // Permintaan lain berjalan atau antrean belum habis: kode masuk antrean agar urutan (dan key kode tertahan)
    // terjaga. Pemindaian baru saat antrean tertahan juga melanjutkan antrean.
    if (inFlightRef.current || queueRef.current.length > 0) {
      setQueue([...queueRef.current, req]);
      if (held) setQueuePaused(false);
      return;
    }
    send(req);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit(code, true);
  }

  const shownCounts =
    selected && counts?.eventId === selected.id
      ? { checkedIn: counts.checkedIn, paid: counts.paid }
      : selected
        ? { checkedIn: selected.checked_in_count, paid: selected.paid_count }
        : null;
  const latest = history[0] ?? null;
  // Kamera menunggu selama ada permintaan berjalan atau antrean aktif; antrean yang ditahan tidak memblokir kamera.
  const busy = inFlight !== null || (queue.length > 0 && !queuePaused);

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
          description="Event dibuka atau ditutup yang jendela check-in-nya dibuka paling lambat 24 jam dari sekarang."
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
                  Event yang dipilih belum atau tidak lagi tersedia untuk check-in: pemindai hanya memuat
                  event yang jendela check-in-nya dibuka paling lambat 24 jam lagi dan belum berakhir. Pilih
                  event di bawah.
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
                {/* Tombol tidak memakai keadaan loading: Enter dari pemindai genggam harus tetap terkirim (antrean). */}
                <Button type="submit" variant="gradient">
                  Check-in
                </Button>
                <QueueStatus
                  inFlight={inFlight !== null}
                  queued={queue.length}
                  paused={queuePaused}
                  notice={notice}
                  onResume={resumeQueue}
                />
              </form>
            </Card>
            {/* Hasil tepat di bawah isian kode, dan di samping kamera pada layar lebar. */}
            {shownCounts ? (
              <p className="text-sm font-semibold text-primary" aria-live="polite">
                Hadir {shownCounts.checkedIn} dari {shownCounts.paid} tiket lunas
              </p>
            ) : null}
            <ScanResultCard entry={latest} event={selected} />
            {history.length > 1 ? <ScanHistory entries={history.slice(1)} event={selected} /> : null}
          </div>
          <Card className="flex min-w-0 flex-[1_1_360px] flex-col gap-3 pb-5">
            <CardHeader title="Pindai dengan kamera" />
            <div className="px-5">
              <QrScanner paused={busy} onDecode={(text) => submit(text, false)} />
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

/** Status antrean pemindaian yang dibacakan pembaca layar (N-11, PRD 4.5). */
function QueueStatus({
  inFlight,
  queued,
  paused,
  notice,
  onResume,
}: {
  inFlight: boolean;
  queued: number;
  paused: boolean;
  notice: string | null;
  onResume: () => void;
}) {
  let text: string | null = null;
  if (paused && queued > 0)
    text = `${queued} kode belum terkirim karena koneksi bermasalah. Tekan Check-in dengan isian kosong atau pindai ulang kodenya untuk mengirim ulang.`;
  else if (queued > 0) text = `${queued} kode antre; dikirim otomatis setelah pemindaian sebelumnya selesai.`;
  else if (inFlight) text = "Memeriksa kode tiket...";
  return (
    <div className="flex flex-col gap-2">
      <p role="status" aria-live="polite" className="flex items-start gap-1.5 text-sm text-text-muted">
        {text ? <ListOrdered aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : null}
        {[notice, text].filter(Boolean).join(" ")}
      </p>
      {paused && queued > 0 && !inFlight ? (
        <div>
          <Button variant="outline" size="sm" onClick={onResume}>
            Kirim ulang sekarang
          </Button>
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
  const name = ticket.holder.full_name ?? DELETED_ACCOUNT_LABEL;
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
 * dibacakan. Nomor dan jam pemindaian ada di dalam teks region, sehingga dua hasil yang sama berturut-turut tetap
 * mengubah teks dan diumumkan ulang (region live hanya bereaksi pada perubahan teks), dan petugas melihat bahwa
 * pemindaian kedua sudah diproses.
 */
export function ScanResultCard({ entry, event }: { entry: ScanEntry | null; event: CheckinEvent }) {
  const sectionRef = useRef<HTMLElement>(null);
  const seq = entry?.seq ?? 0;
  // Layar sempit (ponsel petugas): kartu hasil dapat berada di luar layar; gulir seperlunya agar setiap hasil
  // baru terlihat tanpa memindahkan fokus dari isian kode (N-11).
  useEffect(() => {
    const el = sectionRef.current;
    if (seq === 0 || typeof el?.scrollIntoView !== "function") return;
    el.scrollIntoView({ block: "nearest" });
  }, [seq]);
  const outcome = entry?.outcome ?? null;
  const summary = outcome ? summarize(outcome) : null;
  const tone: ResultTone | "neutral" = summary?.tone ?? "neutral";
  const title = summary?.title ?? "Siap memindai";
  let body: ReactNode = (
    <p className="text-sm text-text-muted">Hasil pemindaian untuk {event.title} tampil di sini.</p>
  );
  if (outcome?.kind === "success") {
    const r = outcome.result;
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
  } else if (outcome?.kind === "unknown") {
    body = (
      <p className="flex items-start gap-1.5 text-sm">
        <WifiOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {outcome.message}
      </p>
    );
  } else if (outcome) {
    body = <p className="text-sm">{outcome.message}</p>;
  }
  const style = TONE[tone];
  return (
    <section
      ref={sectionRef}
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
      {entry ? (
        <p className="mt-auto text-xs text-text-muted">
          Pemindaian ke-{entry.seq}, pukul {scanTime(entry.at, event.timezone)}
        </p>
      ) : null}
    </section>
  );
}

/** Hasil yang sudah tergantikan pemindaian berikutnya tetap terlihat (antrean pemindai genggam, PRD 4.5). */
function ScanHistory({ entries, event }: { entries: ScanEntry[]; event: CheckinEvent }) {
  return (
    <section aria-labelledby="pemindaian-sebelumnya" className="flex flex-col gap-2">
      <h3 id="pemindaian-sebelumnya" className="text-sm font-semibold text-primary">
        Pemindaian sebelumnya
      </h3>
      <ol className="flex flex-col divide-y divide-divider rounded-lg border border-divider bg-surface">
        {entries.map((entry) => {
          const s = summarize(entry.outcome);
          return (
            <li key={entry.seq} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className={cn("[&_svg]:size-4", TONE[s.tone].iconCls)} aria-hidden="true">
                {TONE[s.tone].icon}
              </span>
              <span className="font-semibold">{s.title}</span>
              {s.holder ? <span>{s.holder}</span> : null}
              <span className="ml-auto text-xs text-text-muted">
                ke-{entry.seq}, {scanTime(entry.at, event.timezone)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
