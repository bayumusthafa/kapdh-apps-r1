import { zodResolver } from "@hookform/resolvers/zod";
import type { components, operations } from "@kapdh/contracts";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { Ban, CircleCheck, Clock, Filter, Loader, RotateCcw, Skull, TriangleAlert } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable, useCursorPaging } from "../../components/ui/DataTable";
import { DateTimeField } from "../../components/ui/FormatFields";
import { Field, FormField } from "../../components/ui/FormField";
import { Input, Select, type SelectOption } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState, ForbiddenState } from "../../components/ui/States";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import { useToast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatShortDateTime } from "../../lib/format";
import { DELETED_ACCOUNT_LABEL } from "../../lib/labels";
import type { NotificationTab } from "./routes";

type Delivery = components["schemas"]["AdminNotificationDelivery"];
type DeliveryStatus = components["schemas"]["NotificationDeliveryStatus"];
type Channel = components["schemas"]["NotificationChannel"];
type Category = components["schemas"]["NotificationCategory"];
type DeliverySort = components["schemas"]["AdminDeliverySort"];
type DeliverySkipReason = components["schemas"]["AdminDeliveryRetrySkipReason"];
type DeliveryRetryResult = components["schemas"]["AdminDeliveryRetryResult"];
type OutboxEvent = components["schemas"]["AdminOutboxEvent"];
type OutboxStatus = components["schemas"]["AdminOutboxStatus"];
type OutboxSort = components["schemas"]["AdminOutboxSort"];
type OutboxSkipReason = components["schemas"]["AdminOutboxRetrySkipReason"];
type OutboxRetryResult = components["schemas"]["AdminOutboxRetryResult"];

export const NOTIFICATIONS_KEY = ["admin-notifications"] as const;
export const DELIVERY_PAGE_SIZE = 30;
/** Daftar dimuat ulang berkala; hanya refetch berkala yang berlabel latar (AC F02-5). */
export const NOTIFICATIONS_POLL_MS = 60_000;

const STATUS_STYLE: Record<DeliveryStatus, { label: string; tone: BadgeTone; icon: ReactNode }> = {
  pending: { label: "Menunggu", tone: "info", icon: <Clock /> },
  sent: { label: "Terkirim", tone: "success", icon: <CircleCheck /> },
  failed: { label: "Gagal", tone: "danger", icon: <TriangleAlert /> },
  cancelled: { label: "Dibatalkan", tone: "neutral", icon: <Ban /> },
};

const OUTBOX_STATUS_STYLE: Record<OutboxStatus, { label: string; tone: BadgeTone; icon: ReactNode }> = {
  pending: { label: "Menunggu", tone: "info", icon: <Clock /> },
  dispatched: { label: "Diteruskan", tone: "success", icon: <CircleCheck /> },
  failed: { label: "Gagal, dicoba ulang otomatis", tone: "warning", icon: <TriangleAlert /> },
  dead: { label: "Berhenti, perlu tindakan", tone: "danger", icon: <Skull /> },
};

export const CATEGORY_LABEL: Record<Category, string> = {
  payment: "Pembayaran",
  membership: "Keanggotaan",
  event: "Event",
  news: "Berita",
  chat: "Chat",
  security: "Keamanan",
  account: "Akun",
};

const CHANNEL_LABEL: Record<Channel, string> = { push: "Push", email: "Email" };

/** Topik outbox yang dikenal (ARCHITECTURE §4.7). */
export const TOPIC_LABEL: Record<string, string> = {
  "notification.created": "Notifikasi baru",
  "account.deletion.requested": "Penghapusan akun",
  "audit.export.requested": "Ekspor audit",
  "event.cancelled": "Pembatalan event",
  "admin.security_notice": "Pemberitahuan keamanan admin",
  "member.password_reset_initiated": "Reset sandi anggota",
};

/** Arti kelas galat worker dan pembatalan sisi server (F-13, AC F13-4, F13-5). */
export const ERROR_CLASS_LABEL: Record<string, string> = {
  UNREGISTERED: "Token perangkat tidak terdaftar lagi; token dinonaktifkan (AC F13-4).",
  INVALID_ARGUMENT: "Provider menolak permintaan push (data tidak valid).",
  SENDER_ID_MISMATCH: "Token perangkat milik proyek pengirim lain.",
  QUOTA_EXCEEDED: "Kuota provider terlampaui (429); dicoba ulang otomatis dengan jeda.",
  UNAVAILABLE: "Provider tidak tersedia (5xx); dicoba ulang otomatis dengan jeda.",
  INTERNAL: "Galat internal provider; dicoba ulang otomatis dengan jeda.",
  bounce_hard: "Email ditolak permanen oleh server penerima.",
  bounce_soft: "Email ditolak sementara (kotak penuh atau server sibuk).",
  rejected: "Email ditolak layanan pengirim.",
  timeout: "Batas waktu pengiriman habis.",
  token_revoked: "Token perangkat sudah dicabut (logout, pencabutan sesi atau token diganti).",
  token_reassigned: "Token perangkat kini dipakai akun lain; notifikasi akun lama tidak dikirim (AC F13-5).",
  preference_disabled: "Penerima mematikan kategori atau kanal ini.",
};

export const DELIVERY_SKIP_LABEL: Record<DeliverySkipReason, string> = {
  not_found: "tidak ditemukan",
  not_failed: "sudah tidak berstatus gagal (diproses admin lain atau worker)",
  token_revoked: "token perangkat sudah dicabut",
  token_reassigned: "token perangkat kini milik akun lain",
  recipient_unavailable: "akun penerima sudah dihapus atau dinonaktifkan",
  preference_disabled: "penerima mematikan kategori atau kanal ini",
};

export const OUTBOX_SKIP_LABEL: Record<OutboxSkipReason, string> = {
  not_found: "tidak ditemukan",
  in_progress: "sedang diproses dispatcher; coba lagi setelah selesai",
  not_retryable: "statusnya bukan gagal atau berhenti",
};

/** Ringkasan alasan dilewati, mis. "token perangkat sudah dicabut (2); tidak ditemukan (1)". */
export function summarizeSkips<R extends string>(reasons: R[], labels: Record<R, string>): string {
  const counts = new Map<R, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].map(([r, n]) => `${labels[r]} (${n})`).join("; ");
}

interface Notice {
  tone: "success" | "warning";
  message: string;
}

function NoticeBox({ notice }: { notice: Notice | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        notice
          ? cn(
              "rounded-md p-3 text-sm font-medium",
              notice.tone === "success" ? "bg-success-bg text-success" : "bg-warning-bg text-warning",
            )
          : undefined
      }
    >
      {notice?.message ?? ""}
    </div>
  );
}

/**
 * Pemantauan notifikasi (F-13, F-15; izin notifications.manage): hasil pengiriman email/push per kanal dan
 * perangkat serta event outbox yang gagal, dengan kirim ulang yang terkendali (PRD 4.5, 5.1). Isi notifikasi, token
 * perangkat, email dan payload outbox tidak pernah ditampilkan (ARCHITECTURE §2). Status Terkirim berarti diterima
 * provider, bukan jaminan dibaca perangkat.
 */
export function NotificationsPage() {
  const auth = useAuth();
  const search = useSearch({ from: "/app/notifications" });
  const navigate = useNavigate({ from: "/notifications" });
  const tab: NotificationTab = search.tab ?? "deliveries";
  return (
    <>
      <PageHeader
        title="Notifikasi"
        description="Status pengiriman email dan push per kanal serta event outbox yang perlu tindakan. Kirim ulang hanya untuk kegagalan yang masih dapat ditindak."
      />
      {auth.can("notifications.manage") ? (
        <>
          <Tabs<NotificationTab>
            label="Jenis pemantauan"
            idPrefix="notifikasi"
            items={[
              { value: "deliveries", label: "Pengiriman" },
              { value: "outbox", label: "Outbox" },
            ]}
            value={tab}
            onValueChange={(next) => void navigate({ search: { tab: next }, replace: true })}
          />
          <TabPanel idPrefix="notifikasi" value={tab} className="flex flex-col gap-5">
            {tab === "deliveries" ? (
              <DeliveriesPanel key={search.since ?? ""} since={search.since} />
            ) : (
              <OutboxPanel />
            )}
          </TabPanel>
        </>
      ) : (
        <Card>
          <ForbiddenState description="Pemantauan notifikasi memerlukan izin Memantau dan mengulang pengiriman notifikasi (notifications.manage). Hubungi Super Admin bila Anda memerlukannya." />
        </Card>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------------------
// Pengiriman

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const deliveryFilterSchema = z
  .object({
    status: z.string(),
    channel: z.string(),
    category: z.string(),
    retryable: z.string(),
    error_class: z.string().trim().max(64, "Maksimal 64 karakter."),
    user_id: z
      .string()
      .trim()
      .refine((v) => v === "" || UUID.test(v), "Id penerima harus berupa UUID akun."),
    from: z.string().nullable(),
    to: z.string().nullable(),
  })
  .refine((v) => !v.from || !v.to || Date.parse(v.to) > Date.parse(v.from), {
    path: ["to"],
    message: "Batas akhir harus setelah batas awal.",
  });
type DeliveryFilterValues = z.infer<typeof deliveryFilterSchema>;

const EMPTY_DELIVERY_FILTER: DeliveryFilterValues = {
  status: "",
  channel: "",
  category: "",
  retryable: "",
  error_class: "",
  user_id: "",
  from: null,
  to: null,
};

type DeliveryQuery = operations["adminListNotificationDeliveries"]["parameters"]["query"];

/** Nilai filter formulir -> parameter query kontrak (isian kosong dihilangkan). */
export function toDeliveryQuery(v: DeliveryFilterValues): NonNullable<DeliveryQuery> {
  const q: NonNullable<DeliveryQuery> = {};
  if (v.status) q.status = v.status as DeliveryStatus;
  if (v.channel) q.channel = v.channel as Channel;
  if (v.category) q.category = v.category as Category;
  if (v.retryable) q.retryable = v.retryable === "true";
  if (v.error_class.trim()) q.error_class = v.error_class.trim();
  if (v.user_id.trim()) q.user_id = v.user_id.trim();
  if (v.from) q.from = v.from;
  if (v.to) q.to = v.to;
  return q;
}

const STATUS_OPTIONS: readonly SelectOption[] = [
  { value: "", label: "Semua status" },
  ...(Object.keys(STATUS_STYLE) as DeliveryStatus[]).map((s) => ({ value: s, label: STATUS_STYLE[s].label })),
];
const CHANNEL_OPTIONS: readonly SelectOption[] = [
  { value: "", label: "Semua kanal" },
  { value: "push", label: "Push" },
  { value: "email", label: "Email" },
];
const CATEGORY_OPTIONS: readonly SelectOption[] = [
  { value: "", label: "Semua kategori" },
  ...(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
];
const RETRYABLE_OPTIONS: readonly SelectOption[] = [
  { value: "", label: "Semua" },
  { value: "true", label: "Dapat dikirim ulang" },
  { value: "false", label: "Tidak dapat dikirim ulang" },
];
const DELIVERY_SORT_OPTIONS = [
  { value: "created_at_desc", label: "Terbaru dibuat" },
  { value: "created_at_asc", label: "Terlama dibuat" },
  { value: "updated_at_desc", label: "Terakhir diperbarui" },
] as const satisfies readonly { value: DeliverySort; label: string }[];

function recipientText(d: Delivery): string {
  if (!d.recipient) return DELETED_ACCOUNT_LABEL;
  return d.recipient.full_name ?? "Akun non-alumni";
}

function channelText(d: Delivery): string {
  if (d.channel === "push") return d.platform ? `Push (${d.platform === "ios" ? "iOS" : "Android"})` : "Push";
  return CHANNEL_LABEL[d.channel];
}

function DeliveriesPanel({ since }: { since?: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  // Tautan dasbor (?since=) membuka kegagalan yang dapat ditindak sejak awal jendela hitungan.
  const initial: DeliveryFilterValues = since
    ? { ...EMPTY_DELIVERY_FILTER, status: "failed", retryable: "true", from: since }
    : EMPTY_DELIVERY_FILTER;
  const [applied, setApplied] = useState(() => toDeliveryQuery(initial));
  const [sort, setSort] = useState<DeliverySort>("created_at_desc");
  const [selected, setSelected] = useState<RowSelectionState>({});
  const [confirming, setConfirming] = useState<Delivery[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const paging = useCursorPaging({ applied, sort }, DELIVERY_PAGE_SIZE);
  const form = useForm<DeliveryFilterValues>({
    resolver: zodResolver(deliveryFilterSchema),
    defaultValues: initial,
  });

  const list = useApiQuery({
    queryKey: [...NOTIFICATIONS_KEY, "deliveries", { applied, sort, cursor: paging.cursor }],
    placeholderData: keepPreviousData,
    pollMs: NOTIFICATIONS_POLL_MS,
    request: ({ signal, headers }) =>
      api.GET("/admin/notifications/deliveries", {
        params: {
          query: {
            ...applied,
            sort,
            limit: DELIVERY_PAGE_SIZE,
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
          },
        },
        signal,
        headers,
      }),
  });

  const retry = useApiMutation<DeliveryRetryResult, string[]>({
    request: (ids, ctx) =>
      api.POST("/admin/notifications/deliveries/retry", {
        params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: { delivery_ids: ids },
      }),
    onSuccess: (result) => {
      setConfirming(null);
      setSelected({});
      const requeued = result.requeued.length;
      const skipped = result.skipped.length;
      const parts = [`${requeued} pengiriman dijadwalkan ulang.`];
      if (skipped > 0)
        parts.push(
          `${skipped} dilewati: ${summarizeSkips(
            result.skipped.map((s) => s.reason),
            DELIVERY_SKIP_LABEL,
          )}.`,
        );
      setNotice({ tone: skipped > 0 ? "warning" : "success", message: parts.join(" ") });
      if (requeued > 0) toast.success(`${requeued} pengiriman dijadwalkan ulang.`);
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["admin-dashboard"] });
    },
    onError: () => setConfirming(null),
  });

  const columns = useMemo<ColumnDef<Delivery>[]>(
    () => [
      {
        id: "recipient",
        header: "Penerima",
        meta: { rowHeader: true },
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-medium">{recipientText(row.original)}</span>
            {row.original.recipient?.member_number ? (
              <span className="text-xs text-text-muted">{row.original.recipient.member_number}</span>
            ) : null}
          </span>
        ),
      },
      { id: "category", header: "Kategori", cell: ({ row }) => CATEGORY_LABEL[row.original.category] },
      { id: "channel", header: "Kanal", cell: ({ row }) => channelText(row.original) },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          const s = STATUS_STYLE[row.original.status];
          return (
            <span className="flex flex-col items-start gap-1">
              <Badge tone={s.tone} icon={s.icon}>
                {s.label}
              </Badge>
              {row.original.sent_at ? (
                <span className="text-xs text-text-muted">{formatShortDateTime(row.original.sent_at)}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "attempt",
        header: "Percobaan",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span>{row.original.attempt}x</span>
            {row.original.next_retry_at ? (
              <span className="text-xs text-text-muted">
                Berikutnya {formatShortDateTime(row.original.next_retry_at)}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "error",
        header: "Keterangan",
        meta: { cellClassName: "max-w-72" },
        cell: ({ row }) => {
          const d = row.original;
          if (!d.error_class && !d.provider_status) return "-";
          return (
            <span className="flex flex-col gap-0.5">
              {d.error_class ? (
                <span className="font-mono text-xs font-semibold">{d.error_class}</span>
              ) : null}
              {d.error_class && ERROR_CLASS_LABEL[d.error_class] ? (
                <span className="text-xs text-text-muted">{ERROR_CLASS_LABEL[d.error_class]}</span>
              ) : null}
              {d.provider_status ? (
                <span className="text-xs text-text-muted">Status provider: {d.provider_status}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "created_at",
        header: "Dibuat (WIB)",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => formatShortDateTime(row.original.created_at),
      },
    ],
    [],
  );

  const apply = form.handleSubmit((v) => {
    setNotice(null);
    setApplied(toDeliveryQuery(v));
  });
  const resetFilter = () => {
    form.reset(EMPTY_DELIVERY_FILTER);
    setNotice(null);
    setApplied({});
  };

  return (
    <>
      <Card aria-labelledby="pengiriman-filter" className="flex flex-col gap-3 pb-5">
        <CardHeader
          titleId="pengiriman-filter"
          title="Filter pengiriman"
          description="Waktu dalam WIB; batas awal inklusif dan batas akhir eksklusif terhadap waktu notifikasi dibuat."
        />
        <form noValidate onSubmit={(e) => void apply(e)} className="flex flex-col gap-4 px-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <FormField<DeliveryFilterValues, "status"> control={form.control} name="status" label="Status">
              {(field, a11y) => (
                <Select
                  {...a11y}
                  size="sm"
                  options={STATUS_OPTIONS}
                  value={field.value}
                  onValueChange={field.onChange}
                />
              )}
            </FormField>
            <FormField<DeliveryFilterValues, "channel"> control={form.control} name="channel" label="Kanal">
              {(field, a11y) => (
                <Select
                  {...a11y}
                  size="sm"
                  options={CHANNEL_OPTIONS}
                  value={field.value}
                  onValueChange={field.onChange}
                />
              )}
            </FormField>
            <FormField<DeliveryFilterValues, "category">
              control={form.control}
              name="category"
              label="Kategori"
            >
              {(field, a11y) => (
                <Select
                  {...a11y}
                  size="sm"
                  options={CATEGORY_OPTIONS}
                  value={field.value}
                  onValueChange={field.onChange}
                />
              )}
            </FormField>
            <FormField<DeliveryFilterValues, "retryable">
              control={form.control}
              name="retryable"
              label="Dapat dikirim ulang"
            >
              {(field, a11y) => (
                <Select
                  {...a11y}
                  size="sm"
                  options={RETRYABLE_OPTIONS}
                  value={field.value}
                  onValueChange={field.onChange}
                />
              )}
            </FormField>
            <FormField<DeliveryFilterValues, "error_class">
              control={form.control}
              name="error_class"
              label="Kelas galat"
              hint="Persis, mis. UNREGISTERED atau bounce_hard."
            >
              {(field, a11y) => <Input {...field} {...a11y} size="sm" maxLength={64} />}
            </FormField>
            <FormField<DeliveryFilterValues, "user_id">
              control={form.control}
              name="user_id"
              label="Id akun penerima"
              hint="Untuk menelusuri keluhan tidak menerima notifikasi."
            >
              {(field, a11y) => <Input {...field} {...a11y} size="sm" maxLength={36} />}
            </FormField>
            <FormField<DeliveryFilterValues, "from"> control={form.control} name="from" label="Dari (WIB)">
              {(field, a11y) => (
                <DateTimeField {...a11y} value={field.value} onValueChange={field.onChange} />
              )}
            </FormField>
            <FormField<DeliveryFilterValues, "to"> control={form.control} name="to" label="Sebelum (WIB)">
              {(field, a11y) => (
                <DateTimeField {...a11y} value={field.value} onValueChange={field.onChange} />
              )}
            </FormField>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" leftIcon={<Filter aria-hidden="true" className="size-4" />}>
              Terapkan filter
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={resetFilter}>
              Hapus filter
            </Button>
          </div>
        </form>
      </Card>
      <NoticeBox notice={notice} />
      <section aria-label="Daftar pengiriman">
        <DataTable<Delivery>
          caption="Hasil pengiriman notifikasi"
          columns={columns}
          data={list.data?.items}
          getRowId={(d) => d.id}
          status={list.status}
          error={list.error}
          onRetry={() => void list.refetch()}
          isFetching={list.isFetching && list.isPlaceholderData}
          total={list.data?.total}
          minWidth={960}
          rowClassName={(d) => (d.status === "failed" ? "bg-danger-bg/30" : undefined)}
          pagination={{
            pageIndex: paging.pageIndex,
            pageSize: DELIVERY_PAGE_SIZE,
            nextCursor: list.data?.next_cursor,
            onNext: paging.next,
            onPrev: paging.prev,
          }}
          selection={{
            selected,
            onChange: setSelected,
            resetKey: { applied, sort },
            rowLabel: (d) => `pengiriman ${CATEGORY_LABEL[d.category]} ke ${recipientText(d)}`,
            actions: (rows) => (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<RotateCcw aria-hidden="true" className="size-4" />}
                onClick={() => setConfirming(rows)}
              >
                Kirim ulang terpilih
              </Button>
            ),
          }}
          rowActions={(d) =>
            d.retryable ? (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<RotateCcw aria-hidden="true" className="size-4" />}
                aria-label={`Kirim ulang pengiriman ${CATEGORY_LABEL[d.category]} ke ${recipientText(d)}`}
                loading={retry.isPending && retry.variables?.length === 1 && retry.variables[0] === d.id}
                onClick={() => retry.mutate([d.id])}
              >
                Kirim ulang
              </Button>
            ) : d.status === "failed" ? (
              <span className="text-xs text-text-muted">Tidak dapat dikirim ulang</span>
            ) : null
          }
          toolbar={
            <Field label="Urutkan" className="flex-[0_1_200px]">
              {(a11y) => (
                <Select
                  {...a11y}
                  size="sm"
                  options={DELIVERY_SORT_OPTIONS}
                  value={sort}
                  onValueChange={setSort}
                />
              )}
            </Field>
          }
          emptyState={
            <EmptyState
              compact
              title="Tidak ada pengiriman yang cocok"
              description="Ubah filter untuk melihat pengiriman lain."
            />
          }
        />
      </section>
      <p className="text-xs text-text-muted">
        Terkirim berarti diterima provider (mis. FCM accepted), bukan jaminan sudah dibaca perangkat. Kirim
        ulang tidak menggandakan kotak masuk anggota (AC F13-1); token yang tidak terdaftar atau berpindah
        akun tidak dikirimi lagi (AC F13-4, F13-5).
      </p>
      <ConfirmDialog
        open={confirming !== null}
        tone="primary"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) retry.mutate(confirming.map((d) => d.id));
        }}
        pending={retry.isPending}
        title={`Kirim ulang ${confirming?.length ?? 0} pengiriman?`}
        description="Hanya pengiriman yang masih gagal dan targetnya masih sah yang dijadwalkan ulang; sisanya dilewati beserta alasannya. Tindakan ini tercatat di audit."
        confirmLabel="Ya, kirim ulang"
      />
    </>
  );
}

// ------------------------------------------------------------------------------------------------------------
// Outbox

const OUTBOX_STATUS_OPTIONS: readonly SelectOption<OutboxStatus | "">[] = [
  { value: "", label: "Perlu tindakan (gagal dan berhenti)" },
  { value: "dead", label: OUTBOX_STATUS_STYLE.dead.label },
  { value: "failed", label: OUTBOX_STATUS_STYLE.failed.label },
  { value: "pending", label: OUTBOX_STATUS_STYLE.pending.label },
  { value: "dispatched", label: OUTBOX_STATUS_STYLE.dispatched.label },
];
const TOPIC_OPTIONS: readonly SelectOption[] = [
  { value: "", label: "Semua topik" },
  ...Object.entries(TOPIC_LABEL).map(([value, label]) => ({ value, label })),
];
const OUTBOX_SORT_OPTIONS = [
  { value: "created_at_desc", label: "Terbaru dibuat" },
  { value: "created_at_asc", label: "Terlama dibuat" },
  { value: "next_attempt_at_asc", label: "Percobaan berikutnya" },
] as const satisfies readonly { value: OutboxSort; label: string }[];

function topicText(topic: string): string {
  return TOPIC_LABEL[topic] ?? topic;
}

function OutboxPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<OutboxStatus | "">("");
  const [topic, setTopic] = useState("");
  const [sort, setSort] = useState<OutboxSort>("created_at_desc");
  const [selected, setSelected] = useState<RowSelectionState>({});
  const [confirming, setConfirming] = useState<OutboxEvent[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const filters = { status, topic, sort };
  const paging = useCursorPaging(filters, DELIVERY_PAGE_SIZE);

  const list = useApiQuery({
    queryKey: [...NOTIFICATIONS_KEY, "outbox", { ...filters, cursor: paging.cursor }],
    placeholderData: keepPreviousData,
    pollMs: NOTIFICATIONS_POLL_MS,
    request: ({ signal, headers }) =>
      api.GET("/admin/notifications/outbox", {
        params: {
          query: {
            sort,
            limit: DELIVERY_PAGE_SIZE,
            ...(status ? { status } : {}),
            ...(topic ? { topic } : {}),
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
          },
        },
        signal,
        headers,
      }),
  });

  const retry = useApiMutation<OutboxRetryResult, string[]>({
    request: (ids, ctx) =>
      api.POST("/admin/notifications/outbox/retry", {
        params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: { event_ids: ids },
      }),
    onSuccess: (result) => {
      setConfirming(null);
      setSelected({});
      const requeued = result.requeued.length;
      const skipped = result.skipped.length;
      const parts = [`${requeued} event dikembalikan ke antrean.`];
      if (skipped > 0)
        parts.push(
          `${skipped} dilewati: ${summarizeSkips(
            result.skipped.map((s) => s.reason),
            OUTBOX_SKIP_LABEL,
          )}.`,
        );
      setNotice({ tone: skipped > 0 ? "warning" : "success", message: parts.join(" ") });
      if (requeued > 0) toast.success(`${requeued} event dikembalikan ke antrean.`);
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["admin-dashboard"] });
    },
    onError: () => setConfirming(null),
  });

  const columns = useMemo<ColumnDef<OutboxEvent>[]>(
    () => [
      {
        id: "topic",
        header: "Topik",
        meta: { rowHeader: true },
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-medium">{topicText(row.original.topic)}</span>
            <span className="font-mono text-xs text-text-muted">{row.original.topic}</span>
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          const s = OUTBOX_STATUS_STYLE[row.original.status];
          return (
            <span className="flex flex-col items-start gap-1">
              <Badge tone={s.tone} icon={s.icon}>
                {s.label}
              </Badge>
              {row.original.in_progress ? (
                <Badge tone="info" icon={<Loader />}>
                  Sedang diproses dispatcher
                </Badge>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "attempts",
        header: "Percobaan",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span>{row.original.attempts}x</span>
            {row.original.status === "failed" || row.original.status === "pending" ? (
              <span className="text-xs text-text-muted">
                Berikutnya {formatShortDateTime(row.original.next_attempt_at)}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "last_error",
        header: "Galat terakhir",
        meta: { cellClassName: "max-w-72" },
        cell: ({ row }) => row.original.last_error ?? "-",
      },
      {
        id: "request_id",
        header: "Request ID",
        cell: ({ row }) =>
          row.original.request_id ? (
            <span className="break-all font-mono text-xs">{row.original.request_id}</span>
          ) : (
            "-"
          ),
      },
      {
        id: "created_at",
        header: "Dibuat (WIB)",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => formatShortDateTime(row.original.created_at),
      },
    ],
    [],
  );

  return (
    <>
      <NoticeBox notice={notice} />
      <section aria-label="Daftar event outbox">
        <DataTable<OutboxEvent>
          caption="Event outbox"
          columns={columns}
          data={list.data?.items}
          getRowId={(e) => e.id}
          status={list.status}
          error={list.error}
          onRetry={() => void list.refetch()}
          isFetching={list.isFetching && list.isPlaceholderData}
          total={list.data?.total}
          minWidth={900}
          rowClassName={(e) => (e.status === "dead" ? "bg-danger-bg/30" : undefined)}
          pagination={{
            pageIndex: paging.pageIndex,
            pageSize: DELIVERY_PAGE_SIZE,
            nextCursor: list.data?.next_cursor,
            onNext: paging.next,
            onPrev: paging.prev,
          }}
          selection={{
            selected,
            onChange: setSelected,
            resetKey: filters,
            rowLabel: (e) => `event ${topicText(e.topic)} ${formatShortDateTime(e.created_at)}`,
            actions: (rows) => (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<RotateCcw aria-hidden="true" className="size-4" />}
                onClick={() => setConfirming(rows)}
              >
                Kembalikan terpilih ke antrean
              </Button>
            ),
          }}
          rowActions={(e) =>
            e.retryable ? (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<RotateCcw aria-hidden="true" className="size-4" />}
                aria-label={`Kembalikan event ${topicText(e.topic)} ${formatShortDateTime(e.created_at)} ke antrean`}
                loading={retry.isPending && retry.variables?.length === 1 && retry.variables[0] === e.id}
                onClick={() => retry.mutate([e.id])}
              >
                Kembalikan ke antrean
              </Button>
            ) : null
          }
          toolbar={
            <>
              <Field label="Status" className="flex-[0_1_260px]">
                {(a11y) => (
                  <Select<OutboxStatus | "">
                    {...a11y}
                    size="sm"
                    options={OUTBOX_STATUS_OPTIONS}
                    value={status}
                    onValueChange={setStatus}
                  />
                )}
              </Field>
              <Field label="Topik" className="flex-[0_1_240px]">
                {(a11y) => (
                  <Select
                    {...a11y}
                    size="sm"
                    options={TOPIC_OPTIONS}
                    value={topic}
                    onValueChange={setTopic}
                  />
                )}
              </Field>
              <Field label="Urutkan" className="flex-[0_1_200px]">
                {(a11y) => (
                  <Select
                    {...a11y}
                    size="sm"
                    options={OUTBOX_SORT_OPTIONS}
                    value={sort}
                    onValueChange={setSort}
                  />
                )}
              </Field>
            </>
          }
          emptyState={
            <EmptyState
              compact
              title={status ? "Tidak ada event yang cocok" : "Tidak ada event outbox yang perlu tindakan"}
              description="Event yang gagal dicoba ulang otomatis dengan jeda; yang berhenti perlu dikembalikan ke antrean."
            />
          }
        />
      </section>
      <p className="text-xs text-text-muted">
        Payload dan dedup key tidak ditampilkan. Pemrosesan ulang memakai dedup key yang sama sehingga tidak
        menggandakan uang, periode, nomor, kursi atau notifikasi (PRD 5.1). Gunakan Request ID untuk
        menelusuri log.
      </p>
      <ConfirmDialog
        open={confirming !== null}
        tone="primary"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) retry.mutate(confirming.map((e) => e.id));
        }}
        pending={retry.isPending}
        title={`Kembalikan ${confirming?.length ?? 0} event ke antrean?`}
        description="Hanya event gagal atau berhenti yang tidak sedang diproses dispatcher yang dikembalikan; sisanya dilewati beserta alasannya. Tindakan ini tercatat di audit."
        confirmLabel="Ya, kembalikan"
      />
    </>
  );
}
