import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Ban, CircleCheck, Clock, Download, FileDown, Filter, RotateCcw, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { unwrap, useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { KeyValueList } from "../../components/ui/DataDisplay";
import { DataTable, useCursorPaging } from "../../components/ui/DataTable";
import { Dialog } from "../../components/ui/Dialog";
import { formatBytes } from "../../components/ui/Files";
import { DateTimeField } from "../../components/ui/FormatFields";
import { Field, FormField } from "../../components/ui/FormField";
import { Input, Select } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState, ErrorState, ForbiddenState, Loading } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";
import { formatDateTime, formatShortDateTime } from "../../lib/format";

type Entry = components["schemas"]["AuditEntry"];
type EntryDetail = components["schemas"]["AuditEntryDetail"];
type AuditFilter = components["schemas"]["AuditFilter"];
type Role = components["schemas"]["AuditEffectiveRole"];
type Export = components["schemas"]["AuditExport"];
type ExportStatus = components["schemas"]["AuditExportStatus"];
type Sort = components["schemas"]["AuditEntrySort"];

export const AUDIT_KEY = ["admin-audit"] as const;
export const AUDIT_PAGE_SIZE = 25;
/** Polling daftar ekspor selama ada job diproses; hanya refetch berkala berlabel latar (AC F02-5). */
export const EXPORT_POLL_MS = 5_000;

export const ROLE_LABEL: Record<Role, string> = {
  alumni: "Alumni",
  admin: "Admin",
  super_admin: "Super Admin",
  system: "Sistem",
  anonymous: "Anonim",
};

const EXPORT_STATUS: Record<ExportStatus, { label: string; tone: BadgeTone; icon: ReactNode }> = {
  processing: { label: "Diproses", tone: "info", icon: <Clock /> },
  ready: { label: "Siap", tone: "success", icon: <CircleCheck /> },
  failed: { label: "Gagal", tone: "danger", icon: <TriangleAlert /> },
  expired: { label: "Kedaluwarsa", tone: "neutral", icon: <Ban /> },
};

export const FAILURE_LABEL: Record<components["schemas"]["AuditExportFailureReason"], string> = {
  row_limit_exceeded: "Hasil melebihi batas baris ekspor; persempit filter lalu minta ekspor baru.",
  processing_failed: "Job gagal diproses; minta ekspor baru.",
  timed_out: "Waktu proses habis; minta ekspor baru.",
};

const ROLE_OPTIONS = [
  { value: "", label: "Semua peran" },
  ...(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] })),
];

const filterSchema = z
  .object({
    actor_q: z
      .string()
      .trim()
      .max(100, "Maksimal 100 karakter.")
      .refine((v) => v === "" || v.length >= 2, "Ketik minimal 2 karakter nama pelaku."),
    effective_role: z.string(),
    action: z.string().trim().max(100, "Maksimal 100 karakter."),
    entity_type: z.string().trim().max(64, "Maksimal 64 karakter."),
    entity_id: z.string().trim().max(100, "Maksimal 100 karakter."),
    request_id: z.string().trim().max(100, "Maksimal 100 karakter."),
    from: z.string().nullable(),
    to: z.string().nullable(),
  })
  .refine((v) => !v.from || !v.to || Date.parse(v.to) > Date.parse(v.from), {
    path: ["to"],
    message: "Batas akhir harus setelah batas awal.",
  });
type FilterValues = z.infer<typeof filterSchema>;
const EMPTY: FilterValues = {
  actor_q: "",
  effective_role: "",
  action: "",
  entity_type: "",
  entity_id: "",
  request_id: "",
  from: null,
  to: null,
};

/** Nilai formulir → AuditFilter kontrak (isian kosong dihilangkan); dipakai pencarian DAN ekspor (AC F17-4). */
export function toAuditFilter(v: FilterValues): AuditFilter {
  const f: AuditFilter = {};
  if (v.actor_q.trim()) f.actor_q = v.actor_q.trim();
  if (v.effective_role) f.effective_role = v.effective_role as Role;
  if (v.action.trim()) f.action = v.action.trim();
  if (v.entity_type.trim()) f.entity_type = v.entity_type.trim();
  if (v.entity_id.trim()) f.entity_id = v.entity_id.trim();
  if (v.request_id.trim()) f.request_id = v.request_id.trim();
  if (v.from) f.from = v.from;
  if (v.to) f.to = v.to;
  return f;
}

/** Ringkasan filter berbahasa Indonesia untuk daftar ekspor. */
export function describeFilter(f: AuditFilter): string {
  const parts: string[] = [];
  if (f.actor_q) parts.push(`pelaku "${f.actor_q}"`);
  if (f.effective_role) parts.push(`peran ${ROLE_LABEL[f.effective_role]}`);
  if (f.action) parts.push(`tindakan ${f.action}`);
  if (f.entity_type) parts.push(`entitas ${f.entity_type}`);
  if (f.entity_id) parts.push(`id ${f.entity_id}`);
  if (f.request_id) parts.push(`request ${f.request_id}`);
  if (f.from) parts.push(`dari ${formatDateTime(f.from)}`);
  if (f.to) parts.push(`sebelum ${formatDateTime(f.to)}`);
  return parts.length > 0 ? parts.join("; ") : "Tanpa filter (semua entri)";
}

function actorName(e: Entry): string {
  if (e.actor.display_name) return e.actor.display_name;
  if (e.effective_role === "system") return "Sistem";
  if (e.effective_role === "anonymous") return "Anonim";
  return "Identitas dianonimkan (D2)";
}

/**
 * Audit (F-17, AC F17-2..F17-4; izin audit.read, ekspor audit.read + audit.export). Penelusuran memakai filter
 * pelaku, peran, tindakan, entitas, request_id dan rentang waktu (WIB, dikirim UTC) dengan paging server; ekspor CSV
 * memakai filter yang SAMA persis dengan hasil yang tampil, diproses worker dan berkasnya kedaluwarsa otomatis.
 * Unduhan selalu meminta URL bertanda tangan baru sehingga izin diperiksa ulang setiap kali (AC F17-2).
 */
export function AuditPage() {
  const auth = useAuth();
  const canRead = auth.can("audit.read");
  const canExport = canRead && auth.can("audit.export");
  return (
    <>
      <PageHeader
        title="Audit"
        description="Jejak perubahan penting untuk akuntabilitas dan penanganan sengketa. Audit hanya dapat dibaca."
      />
      {canRead ? (
        <AuditContent canExport={canExport} />
      ) : (
        <Card>
          <ForbiddenState description="Penelusuran dan ekspor audit memerlukan izin Lihat audit (audit.read). Hubungi Super Admin bila Anda memerlukannya." />
        </Card>
      )}
    </>
  );
}

function AuditContent({ canExport }: { canExport: boolean }) {
  const [applied, setApplied] = useState<AuditFilter>({});
  const [sort, setSort] = useState<Sort>("created_at_desc");
  const [openId, setOpenId] = useState<string | null>(null);
  const paging = useCursorPaging({ applied, sort }, AUDIT_PAGE_SIZE);
  const form = useForm<FilterValues>({ resolver: zodResolver(filterSchema), defaultValues: EMPTY });

  const list = useApiQuery({
    queryKey: [...AUDIT_KEY, "entries", { applied, sort, cursor: paging.cursor }],
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/audit/entries", {
        params: {
          query: {
            ...applied,
            sort,
            limit: AUDIT_PAGE_SIZE,
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
          },
        },
        signal,
        headers,
      }),
  });

  const columns = useMemo<ColumnDef<Entry>[]>(
    () => [
      {
        id: "created_at",
        header: "Waktu (WIB)",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => formatShortDateTime(row.original.created_at),
      },
      {
        id: "actor",
        header: "Pelaku",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-medium">{actorName(row.original)}</span>
            <span className="text-xs text-text-muted">{ROLE_LABEL[row.original.effective_role]}</span>
          </span>
        ),
      },
      {
        id: "action",
        header: "Tindakan",
        meta: { rowHeader: true },
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => setOpenId(row.original.id)}
            className="min-h-11 text-left font-mono text-xs font-semibold text-primary underline-offset-2 hover:underline"
            aria-label={`Lihat detail ${row.original.action} ${formatShortDateTime(row.original.created_at)}`}
          >
            {row.original.action}
          </button>
        ),
      },
      {
        id: "entity",
        header: "Entitas",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span>{row.original.entity_type}</span>
            {row.original.entity_id ? (
              <span className="break-all font-mono text-xs text-text-muted">{row.original.entity_id}</span>
            ) : null}
          </span>
        ),
      },
      { id: "reason", header: "Alasan", cell: ({ row }) => row.original.reason ?? "-" },
      {
        id: "request_id",
        header: "Request ID",
        cell: ({ row }) => <span className="break-all font-mono text-xs">{row.original.request_id}</span>,
      },
    ],
    [],
  );

  const apply = form.handleSubmit((v) => setApplied(toAuditFilter(v)));

  return (
    <div className="flex flex-col gap-5">
      <Card aria-labelledby="audit-filter" className="flex flex-col gap-3 pb-5">
        <CardHeader
          titleId="audit-filter"
          title="Filter audit"
          description="Waktu diisi dalam WIB; batas awal inklusif dan batas akhir eksklusif. Filter yang diterapkan juga dipakai ekspor."
        />
        <form noValidate onSubmit={(e) => void apply(e)} className="flex flex-col gap-4 px-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <FormField<FilterValues, "actor_q"> control={form.control} name="actor_q" label="Nama pelaku">
              {(field, a11y) => <Input {...field} {...a11y} size="sm" placeholder="Nama admin atau alumni" />}
            </FormField>
            <FormField<FilterValues, "effective_role">
              control={form.control}
              name="effective_role"
              label="Peran pelaku"
            >
              {(field, a11y) => (
                <Select
                  {...a11y}
                  size="sm"
                  options={ROLE_OPTIONS}
                  value={field.value}
                  onValueChange={field.onChange}
                />
              )}
            </FormField>
            <FormField<FilterValues, "action"> control={form.control} name="action" label="Tindakan">
              {(field, a11y) => <Input {...field} {...a11y} size="sm" placeholder="mis. payment.approved" />}
            </FormField>
            <FormField<FilterValues, "entity_type">
              control={form.control}
              name="entity_type"
              label="Jenis entitas"
            >
              {(field, a11y) => <Input {...field} {...a11y} size="sm" placeholder="mis. payment, admin" />}
            </FormField>
            <FormField<FilterValues, "entity_id"> control={form.control} name="entity_id" label="Id entitas">
              {(field, a11y) => <Input {...field} {...a11y} size="sm" />}
            </FormField>
            <FormField<FilterValues, "request_id">
              control={form.control}
              name="request_id"
              label="Request ID"
            >
              {(field, a11y) => <Input {...field} {...a11y} size="sm" />}
            </FormField>
            <FormField<FilterValues, "from"> control={form.control} name="from" label="Dari (WIB)">
              {(field, a11y) => (
                <DateTimeField {...a11y} value={field.value} onValueChange={field.onChange} />
              )}
            </FormField>
            <FormField<FilterValues, "to"> control={form.control} name="to" label="Sebelum (WIB)">
              {(field, a11y) => (
                <DateTimeField {...a11y} value={field.value} onValueChange={field.onChange} />
              )}
            </FormField>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Button type="submit" size="sm" leftIcon={<Filter aria-hidden="true" className="size-4" />}>
              Terapkan filter
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<RotateCcw aria-hidden="true" className="size-4" />}
              onClick={() => {
                form.reset(EMPTY);
                setApplied({});
              }}
            >
              Reset filter
            </Button>
            <Field label="Urutan" className="ml-auto w-48">
              {(a11y) => (
                <Select<Sort>
                  {...a11y}
                  size="sm"
                  options={[
                    { value: "created_at_desc", label: "Terbaru dulu" },
                    { value: "created_at_asc", label: "Terlama dulu" },
                  ]}
                  value={sort}
                  onValueChange={setSort}
                />
              )}
            </Field>
          </div>
        </form>
      </Card>

      <section aria-label="Hasil audit">
        <DataTable<Entry>
          caption="Entri audit"
          columns={columns}
          data={list.data?.items}
          getRowId={(e) => e.id}
          status={list.status}
          error={list.error}
          onRetry={() => void list.refetch()}
          isFetching={list.isFetching && list.isPlaceholderData}
          total={list.data?.total}
          minWidth={860}
          pagination={{
            pageIndex: paging.pageIndex,
            pageSize: AUDIT_PAGE_SIZE,
            nextCursor: list.data?.next_cursor,
            onNext: paging.next,
            onPrev: paging.prev,
          }}
          emptyState={
            <EmptyState
              compact
              title="Tidak ada entri audit"
              description="Tidak ada entri yang cocok dengan filter ini."
            />
          }
        />
      </section>

      {canExport ? <ExportPanel filter={applied} /> : null}
      {openId ? <EntryDialog entryId={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="text-sm font-semibold">{label}</h3>
      {value === null || value === undefined ? (
        <p className="text-sm text-text-muted">Tidak ada data.</p>
      ) : (
        <pre
          aria-label={label}
          className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-divider bg-neutral-50 p-3 font-mono text-xs"
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Detail satu entri dengan before/after yang sudah disaring saat ditulis (kontrak adminGetAuditEntry). */
function EntryDialog({ entryId, onClose }: { entryId: string; onClose: () => void }) {
  const entry = useApiQuery<EntryDetail>({
    queryKey: [...AUDIT_KEY, "entry", entryId],
    request: ({ signal, headers }) =>
      api.GET("/admin/audit/entries/{entryId}", { params: { path: { entryId } }, signal, headers }),
  });
  return (
    <Dialog open onClose={onClose} size="lg" title="Detail entri audit">
      {entry.isPending ? (
        <Loading label="Memuat detail audit..." rows={4} />
      ) : entry.isError ? (
        <ErrorState error={entry.error} onRetry={() => void entry.refetch()} compact />
      ) : (
        <>
          <KeyValueList
            items={[
              { label: "Waktu", value: formatDateTime(entry.data.created_at) },
              { label: "Tindakan", value: <span className="font-mono">{entry.data.action}</span> },
              {
                label: "Pelaku",
                value: `${actorName(entry.data)} (${ROLE_LABEL[entry.data.effective_role]})`,
              },
              { label: "Entitas", value: `${entry.data.entity_type} ${entry.data.entity_id ?? ""}`.trim() },
              { label: "Request ID", value: <span className="font-mono">{entry.data.request_id}</span> },
              { label: "Alasan", value: entry.data.reason ?? "-" },
            ]}
          />
          <p className="text-xs text-text-muted">
            Secret (sandi, OTP, token, secret TOTP, isi chat, bukti bayar, NIK) tidak pernah dicatat. Data
            kontak terlihat di sini untuk penelusuran berizin, tetapi disamarkan pada berkas ekspor (AC
            F17-3).
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <JsonBlock label="Sebelum" value={entry.data.before} />
            <JsonBlock label="Sesudah" value={entry.data.after} />
          </div>
        </>
      )}
    </Dialog>
  );
}

/** Ekspor CSV asinkron dengan filter yang sama (AC F17-2..F17-4). */
function ExportPanel({ filter }: { filter: AuditFilter }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [downloading, setDownloading] = useState<string | null>(null);
  // Polling hanya selama ada job diproses; refetch berkala membawa header latar (AC F02-5).
  const [processing, setProcessing] = useState(false);
  const exportsQuery = useApiQuery({
    queryKey: [...AUDIT_KEY, "exports"],
    pollMs: processing ? EXPORT_POLL_MS : false,
    request: ({ signal, headers }) =>
      api.GET("/admin/audit/exports", { params: { query: { limit: 20 } }, signal, headers }),
  });
  const anyProcessing = exportsQuery.data?.items.some((x) => x.status === "processing") ?? false;
  useEffect(() => setProcessing(anyProcessing), [anyProcessing]);

  const create = useApiMutation<Export, AuditFilter>({
    request: (f, ctx) =>
      api.POST("/admin/audit/exports", {
        params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: f,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...AUDIT_KEY, "exports"] });
    },
    successMessage: "Ekspor diminta. Berkas diproses di latar; status diperbarui otomatis.",
  });

  async function download(x: Export) {
    setDownloading(x.id);
    try {
      // URL baru setiap kali: izin dan kepemilikan diperiksa ulang server (AC F17-2); URL <= 10 menit.
      const access = await unwrap(
        api.GET("/admin/audit/exports/{exportId}/access", { params: { path: { exportId: x.id } } }),
      );
      const opened = window.open(access.url, "_blank", "noopener,noreferrer");
      if (opened === null) toast.info(`Unduhan ${access.file_name} dimulai di tab baru.`);
    } catch (e) {
      const err = e as { message?: string; code?: string };
      toast.error(err.message ?? "Unduhan gagal.");
      void queryClient.invalidateQueries({ queryKey: [...AUDIT_KEY, "exports"] });
    } finally {
      setDownloading(null);
    }
  }

  return (
    <Card aria-labelledby="audit-ekspor" className="flex flex-col gap-4 pb-5">
      <CardHeader
        titleId="audit-ekspor"
        title="Ekspor CSV"
        description="Memakai filter yang sedang diterapkan. Kolom privat dan secret disamarkan, formula dinetralkan, dan berkas dihapus otomatis setelah kedaluwarsa (AC F17-3, F17-4)."
        actions={
          <Button
            size="sm"
            leftIcon={<FileDown aria-hidden="true" className="size-4" />}
            loading={create.isPending}
            loadingText="Meminta..."
            onClick={() => create.mutate(filter)}
          >
            Ekspor CSV dengan filter ini
          </Button>
        }
      />
      <p className="px-5 text-sm">
        Filter ekspor: <span className="font-medium">{describeFilter(filter)}</span>
      </p>
      <div className="px-5">
        {exportsQuery.isPending ? (
          <Loading label="Memuat daftar ekspor..." rows={2} />
        ) : exportsQuery.isError ? (
          <ErrorState error={exportsQuery.error} onRetry={() => void exportsQuery.refetch()} compact />
        ) : exportsQuery.data.items.length === 0 ? (
          <EmptyState compact title="Belum ada ekspor" description="Ekspor yang Anda minta tampil di sini." />
        ) : (
          <ul aria-label="Daftar ekspor" className="flex flex-col divide-y divide-divider">
            {exportsQuery.data.items.map((x) => {
              const s = EXPORT_STATUS[x.status];
              return (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={s.tone} icon={s.icon}>
                        {s.label}
                      </Badge>
                      <span className="font-medium">{x.file_name ?? "Berkas belum tersedia"}</span>
                    </span>
                    <span className="text-xs text-text-muted">
                      Diminta {formatDateTime(x.requested_at)} oleh{" "}
                      {x.requested_by.display_name ?? "akun dihapus"} | {describeFilter(x.filters)}
                    </span>
                    {x.status === "ready" ? (
                      <span className="text-xs text-text-muted">
                        {x.row_count ?? 0} baris | {x.bytes !== null ? formatBytes(x.bytes) : "-"} | dihapus
                        otomatis {formatDateTime(x.expires_at)}
                      </span>
                    ) : null}
                    {x.status === "failed" && x.failure_reason ? (
                      <span className="text-xs text-danger">{FAILURE_LABEL[x.failure_reason]}</span>
                    ) : null}
                    {x.status === "expired" ? (
                      <span className="text-xs text-text-muted">
                        Berkas sudah dihapus otomatis; minta ekspor baru.
                      </span>
                    ) : null}
                  </div>
                  {x.status === "ready" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Unduh ${x.file_name ?? "ekspor"}`}
                      leftIcon={<Download aria-hidden="true" className="size-4" />}
                      loading={downloading === x.id}
                      onClick={() => void download(x)}
                    >
                      Unduh
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
