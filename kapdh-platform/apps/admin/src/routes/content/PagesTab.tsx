import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { CircleCheck, FilePen, Lock, Plus, ScrollText } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useController, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { type ApiError, toApiError } from "../../api/errors";
import { unwrap, useApiMutation, useApiQuery } from "../../api/query";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { KeyValueList } from "../../components/ui/DataDisplay";
import { DataTable, RowActions, useCursorPaging } from "../../components/ui/DataTable";
import { Dialog } from "../../components/ui/Dialog";
import { Field, FormError, FormField } from "../../components/ui/FormField";
import { Input, Select, Textarea } from "../../components/ui/Input";
import { RichTextEditor } from "../../components/ui/RichTextEditor";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState, ErrorState, Loading } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";
import { formatDate, formatDateTime } from "../../lib/format";
import { requiredText } from "../../lib/validation";
import { ConflictNotice } from "./ConflictNotice";
import {
  type AdminInfoPage,
  type AdminInfoPageSummary,
  CONTENT_PAGE_SIZE,
  type ConflictState,
  conflictState,
  contentKeys,
  errorText,
  invalidateContent,
  type S,
  SLUG_HINT,
  SLUG_PATTERN,
  versionHeaders,
} from "./contentApi";
import { HtmlPreview } from "./HtmlPreview";
import { LEGAL_DOCUMENT_LABEL } from "./labels";
import { useDeferredFocus } from "./useDeferredFocus";
import { useLeaveGuard } from "./useLeaveGuard";

const SORT_OPTIONS: { value: S["AdminInfoPageSort"]; label: string }[] = [
  { value: "system_first", label: "Halaman baku dahulu" },
  { value: "title_asc", label: "Judul A-Z" },
  { value: "updated_at_desc", label: "Terakhir diubah" },
  { value: "published_at_desc", label: "Terakhir terbit" },
];

export function pageKindText(p: Pick<AdminInfoPageSummary, "legal_document">): string {
  return p.legal_document ? `Legal: ${LEGAL_DOCUMENT_LABEL[p.legal_document]}` : "Informasi";
}

function DraftStatusBadge({
  page,
}: {
  page: Pick<AdminInfoPageSummary, "has_unpublished_changes" | "published_version">;
}) {
  if (!page.published_version)
    return (
      <Badge tone="info" icon={<FilePen />}>
        Draf belum pernah terbit
      </Badge>
    );
  return page.has_unpublished_changes ? (
    <Badge tone="warning" icon={<FilePen />}>
      Ada perubahan belum terbit
    </Badge>
  ) : (
    <Badge tone="success" icon={<CircleCheck />}>
      Sama dengan versi tayang
    </Badge>
  );
}

/**
 * Tab Halaman (F-08, PRD 6.2, 8.2): halaman informasi dan legal berversi. Tabel menampilkan versi tayang dan
 * apakah draf kerja berbeda; memilih halaman membuka editor dengan salinan tayang (yang dibaca publik dan disetujui
 * pengguna) terpisah dari draf kerja. Halaman baku tidak dapat dihapus.
 */
export function PagesTab({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (pageId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<S["AdminInfoPageSort"]>("system_first");
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<AdminInfoPageSummary | null>(null);
  const filters = { q, sort };
  const paging = useCursorPaging(filters, CONTENT_PAGE_SIZE);

  const list = useApiQuery({
    queryKey: contentKeys.pageList({ ...filters, cursor: paging.cursor }),
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/content/pages", {
        params: {
          query: {
            ...(q ? { q } : {}),
            sort,
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
            limit: CONTENT_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });

  const toast = useToast();
  const remove = useApiMutation<unknown, AdminInfoPageSummary>({
    intent: (p) => [p.id, p.version],
    toastErrors: false,
    request: (p) =>
      api.DELETE("/admin/content/pages/{pageId}", {
        params: { path: { pageId: p.id }, header: { "If-Match": p.version } },
      }),
    successMessage: (_, p) => `Halaman "${p.title}" dihapus.`,
    onSuccess: async (_, p) => {
      setToDelete(null);
      queryClient.removeQueries({ queryKey: contentKeys.page(p.id) });
      if (selectedId === p.id) onSelect(null);
      await invalidateContent(queryClient);
    },
    onError: (error) => {
      setToDelete(null);
      if (!error.reauthCancelled) toast.error(errorText(error));
      void invalidateContent(queryClient);
    },
  });

  const columns = useMemo<ColumnDef<AdminInfoPageSummary>[]>(
    () => [
      {
        id: "title",
        header: "Judul",
        meta: { rowHeader: true },
        cell: ({ row }) => (
          <button
            type="button"
            aria-current={row.original.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(row.original.id)}
            className="flex min-h-11 flex-col items-start justify-center text-left"
          >
            <span className="font-semibold text-primary underline-offset-2 hover:underline">
              {row.original.title}
            </span>
            <span className="text-xs font-normal text-text-muted">/{row.original.slug}</span>
          </button>
        ),
      },
      {
        id: "kind",
        header: "Jenis",
        cell: ({ row }) => (
          <span className="flex flex-col items-start gap-1">
            {pageKindText(row.original)}
            {row.original.system ? (
              <Badge tone="primary" icon={<Lock />}>
                Halaman baku
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "published_version",
        header: "Versi tayang",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) =>
          row.original.published_version
            ? `Versi ${row.original.published_version} (${formatDate(row.original.published_at)})`
            : "Belum terbit",
      },
      { id: "draft", header: "Draf kerja", cell: ({ row }) => <DraftStatusBadge page={row.original} /> },
      {
        id: "updated_at",
        header: "Diperbarui",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => (
          <span className="flex flex-col">
            {formatDate(row.original.updated_at)}
            {row.original.updated_by ? (
              <span className="text-xs text-text-muted">{row.original.updated_by.display_name}</span>
            ) : null}
          </span>
        ),
      },
    ],
    [selectedId, onSelect],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <SearchInput
            label="Cari halaman"
            value={q}
            onValueChange={setQ}
            placeholder="Cari judul atau slug..."
            className="flex-[1_1_240px]"
          />
          <Field label="Urutan" className="flex-[0_1_220px]">
            {(a11y) => (
              <Select {...a11y} size="sm" options={SORT_OPTIONS} value={sort} onValueChange={setSort} />
            )}
          </Field>
          <Button
            size="sm"
            leftIcon={<Plus aria-hidden="true" className="size-4" />}
            onClick={() => setCreating(true)}
          >
            Buat Halaman
          </Button>
        </div>
        <DataTable<AdminInfoPageSummary>
          caption="Daftar halaman"
          columns={columns}
          data={list.data?.items}
          getRowId={(p) => p.id}
          status={list.status}
          error={list.error}
          onRetry={() => void list.refetch()}
          isFetching={list.isFetching && list.isPlaceholderData}
          total={list.data?.total}
          activeRowId={selectedId}
          minWidth={820}
          pagination={{
            pageIndex: paging.pageIndex,
            pageSize: CONTENT_PAGE_SIZE,
            nextCursor: list.data?.next_cursor,
            onNext: paging.next,
            onPrev: paging.prev,
          }}
          rowActions={(p) => (
            <RowActions
              edit={{ label: `Ubah halaman ${p.title}`, onClick: () => onSelect(p.id) }}
              remove={{
                label: p.system
                  ? `Hapus halaman ${p.title} (halaman baku wajib tersedia dan tidak dapat dihapus)`
                  : `Hapus halaman ${p.title}`,
                disabled: p.system,
                onClick: () => setToDelete(p),
              }}
            />
          )}
          emptyState={
            <EmptyState
              compact
              title={q ? "Tidak ada halaman yang cocok" : "Belum ada halaman"}
              description={q ? "Ubah kata kunci pencarian." : "Halaman baku dibuat oleh seed referensi."}
            />
          }
        />
      </div>

      {selectedId ? (
        <PageDetail key={selectedId} pageId={selectedId} onClose={() => onSelect(null)} />
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-surface">
          <EmptyState
            compact
            icon={<ScrollText />}
            title="Pilih halaman"
            description="Pilih judul halaman untuk melihat versi tayang dan menyunting drafnya."
          />
        </div>
      )}

      {creating ? (
        <CreatePageDialog
          onClose={() => setCreating(false)}
          onCreated={(page) => {
            setCreating(false);
            onSelect(page.id);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={toDelete !== null}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete);
        }}
        pending={remove.isPending}
        title="Hapus halaman?"
        description={
          toDelete
            ? `Halaman "${toDelete.title}" (/${toDelete.slug}) akan dihapus. Banner yang menunjuknya ditandai tujuan tidak tersedia; versi yang pernah terbit tetap tercatat di audit.`
            : undefined
        }
        confirmLabel="Hapus halaman"
        acknowledgement="Saya memahami halaman ini tidak dapat dikembalikan."
      />
    </div>
  );
}

function PageDetail({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const detail = useApiQuery<AdminInfoPage>({
    queryKey: contentKeys.page(pageId),
    request: ({ signal, headers }) =>
      api.GET("/admin/content/pages/{pageId}", { params: { path: { pageId } }, signal, headers }),
  });
  if (detail.data) return <PageEditor initial={detail.data} onClose={onClose} />;
  return (
    <Card>
      {detail.isPending ? (
        <Loading label="Memuat halaman..." rows={5} />
      ) : (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      )}
    </Card>
  );
}

interface PageFormValues {
  title: string;
  slug: string;
  body_html: string;
}

const pageSchema = z.object({
  title: requiredText("Judul", 1, 200),
  slug: z
    .string()
    .trim()
    .min(1, "Slug wajib diisi.")
    .max(120, "Slug maksimal 120 karakter.")
    .regex(SLUG_PATTERN, SLUG_HINT),
  body_html: z.string().min(1, "Isi halaman wajib diisi.").max(200_000, "Isi halaman terlalu panjang."),
});

function toPageForm(p: AdminInfoPage | null): PageFormValues {
  return { title: p?.title ?? "", slug: p?.slug ?? "", body_html: p?.body_html ?? "" };
}

export function pageChanges(v: PageFormValues, base: AdminInfoPage): S["AdminInfoPageUpdateRequest"] {
  const out: S["AdminInfoPageUpdateRequest"] = {};
  if (v.title.trim() !== base.title) out.title = v.title.trim();
  if (!base.slug_locked && v.slug.trim() !== base.slug) out.slug = v.slug.trim();
  if (v.body_html !== base.body_html) out.body_html = v.body_html;
  return out;
}

/** Penjelasan versi legal pada konfirmasi terbit (F-01, PRD 6.2, kontrak adminPublishPage). */
export function publishExplanation(page: AdminInfoPage): string[] {
  const current = page.published?.version ?? null;
  const next = current ? Number(current) + 1 : 1;
  const lines = [
    current
      ? `Versi tayang naik dari versi ${current} menjadi versi ${next}. Publik langsung membaca teks draf saat ini.`
      : "Halaman terbit pertama kali sebagai versi 1 dan mulai dapat dibaca publik.",
  ];
  if (page.legal_document === "privacy" || page.legal_document === "terms")
    lines.push(
      `Ini dokumen legal (${LEGAL_DOCUMENT_LABEL[page.legal_document]}). Registrasi berikutnya menyetujui pasangan versi kebijakan privasi dan ketentuan yang baru; persetujuan pengguna lama tetap tercatat pada versi yang mereka setujui.`,
    );
  if (page.legal_document === "community")
    lines.push(
      "Ini dokumen legal (Ketentuan komunitas). Versi baru menjadi acuan yang dibaca anggota sebelum memakai fitur komunitas.",
    );
  lines.push(
    "Teks yang diterbitkan dicatat di audit sehingga versi yang pernah disetujui pengguna dapat direproduksi. Versi tidak dapat dibatalkan; perbaikan diterbitkan sebagai versi berikutnya.",
  );
  return lines;
}

/**
 * Editor halaman (PRD 6.2): salinan TAYANG (dibaca publik, versi legal) ditampilkan terpisah dari DRAF kerja.
 * Simpan draf tidak mengubah teks tayang maupun versi legal; "Terbitkan versi baru" menyalin draf menjadi versi tayang
 * berikutnya setelah konfirmasi yang menjelaskan akibat versi legal. Konflik versi ditawarkan muat ulang (AC F15-4).
 */
function PageEditor({ initial, onClose }: { initial: AdminInfoPage; onClose: () => void }) {
  const formId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [base, setBase] = useState(initial);
  const [conflict, setConflict] = useState<ConflictState<AdminInfoPage> | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const form = useForm<PageFormValues>({
    resolver: zodResolver(pageSchema),
    defaultValues: toPageForm(initial),
  });
  const values = form.watch();
  const changes = pageChanges(values, base);
  const dirty = Object.keys(changes).length > 0;
  const guard = useLeaveGuard(dirty, "Perubahan draf halaman");
  const focusTitle = useDeferredFocus(() => form.setFocus("title"));
  const body = useController({ control: form.control, name: "body_html" });

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (initial.id !== base.id || initial.version === base.version || dirty || conflict) return;
    setBase(initial);
    form.reset(toPageForm(initial));
    // Ikuti versi terbaru dari cache hanya bila admin belum mengubah apa pun.
  }, [initial]);

  function applyLatest(page: AdminInfoPage) {
    setBase(page);
    form.reset(toPageForm(page));
    queryClient.setQueryData(contentKeys.page(page.id), page);
    void invalidateContent(queryClient);
  }

  function handleConflict(error: ApiError) {
    setConflict(conflictState<AdminInfoPage>(error, base));
  }

  async function reloadLatest() {
    try {
      const latest =
        conflict?.latest ??
        (await queryClient.fetchQuery<AdminInfoPage>({
          queryKey: contentKeys.page(base.id),
          staleTime: 0,
          queryFn: ({ signal }) =>
            unwrap<AdminInfoPage>(
              api.GET("/admin/content/pages/{pageId}", { params: { path: { pageId: base.id } }, signal }),
            ),
        }));
      setConflict(null);
      applyLatest(latest);
      toast.info("Versi terbaru dimuat.");
      focusTitle();
    } catch (e) {
      toast.error(toApiError(e).message);
    }
  }

  const save = useApiMutation<AdminInfoPage, S["AdminInfoPageUpdateRequest"], PageFormValues>({
    intent: (b) => [base.id, base.version, b],
    setError: form.setError,
    request: (b) =>
      api.PATCH("/admin/content/pages/{pageId}", {
        params: { path: { pageId: base.id }, header: { "If-Match": base.version } },
        body: b,
      }),
    successMessage: "Draf halaman disimpan. Teks tayang belum berubah sampai diterbitkan.",
    onSuccess: (data) => applyLatest(data),
    onReloadLatest: (error) => handleConflict(error),
  });

  const publish = useApiMutation<AdminInfoPage, { note: string }>({
    intent: (v) => [base.id, base.version, v],
    toastErrors: false,
    request: (v, ctx) =>
      api.POST("/admin/content/pages/{pageId}/publish", {
        params: { path: { pageId: base.id }, header: versionHeaders(base.version, ctx) },
        body: { change_note: v.note.trim() === "" ? null : v.note.trim() },
      }),
    successMessage: (data) => `Versi ${data.published?.version ?? ""} "${data.title}" diterbitkan.`,
    onSuccess: (data) => {
      setPublishOpen(false);
      setChangeNote("");
      applyLatest(data);
    },
    onError: (error) => {
      setPublishOpen(false);
      if (error.ui.action === "reload_latest" && error.code === "VERSION_CONFLICT") {
        handleConflict(error);
        toast.error(error.message);
      } else if (!error.reauthCancelled) toast.error(errorText(error));
    },
  });

  const saving = save.isPending || publish.isPending;
  const canPublish = !dirty && !conflict && base.has_unpublished_changes;
  const titleId = `${formId}-judul`;
  const legal = base.legal_document;

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          ref={headingRef}
          id={titleId}
          tabIndex={-1}
          className="font-heading text-h2 font-semibold text-text"
        >
          {base.title}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {legal ? <Badge tone="info">Legal: {LEGAL_DOCUMENT_LABEL[legal]}</Badge> : null}
          {base.system ? (
            <Badge tone="primary" icon={<Lock />}>
              Halaman baku
            </Badge>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onClose}>
            Tutup editor
          </Button>
        </div>
      </div>

      {conflict ? (
        <ConflictNotice
          subject="Halaman ini"
          cause={conflict.cause}
          updatedAt={conflict.latest?.updated_at}
          updatedBy={conflict.latest?.updated_by?.display_name}
          latestStatus={
            conflict.latest ? (
              <Badge tone={conflict.latest.published_version ? "success" : "neutral"}>
                {conflict.latest.published_version
                  ? `Versi tayang ${conflict.latest.published_version}`
                  : "Belum pernah terbit"}
                {conflict.latest.has_unpublished_changes ? "; draf belum diterbitkan" : ""}
              </Badge>
            ) : null
          }
          onReload={() => void reloadLatest()}
        />
      ) : null}

      <div className="flex flex-wrap items-start gap-5">
        <Card className="min-w-0 flex-[1_1_360px]" aria-labelledby={`${formId}-tayang`}>
          <CardHeader
            titleId={`${formId}-tayang`}
            title="Versi tayang"
            description="Teks yang dibaca publik dan disetujui pengguna. Tidak berubah saat draf disimpan."
          />
          <div className="flex flex-col gap-4 p-5">
            {base.published ? (
              <>
                <KeyValueList
                  items={[
                    { label: "Versi", value: `Versi ${base.published.version}` },
                    { label: "Terbit", value: formatDateTime(base.published.published_at) },
                    { label: "Judul tayang", value: base.published.title, wide: true },
                  ]}
                />
                <div className="max-h-96 overflow-y-auto rounded-md border border-divider bg-neutral-50 p-4">
                  <HtmlPreview html={base.published.body_html} />
                </div>
              </>
            ) : (
              <p className="text-sm text-text-muted">
                Belum pernah terbit; halaman belum dapat dibaca publik
                {legal ? " dan registrasi belum dapat dibuka sampai dokumen legal ini terbit (PRD 8.2)" : ""}.
              </p>
            )}
          </div>
        </Card>

        <Card className="min-w-0 flex-[1_1_420px]" aria-labelledby={`${formId}-draf`}>
          <CardHeader
            titleId={`${formId}-draf`}
            title="Draf kerja"
            description={
              base.has_unpublished_changes
                ? "Draf berbeda dari versi tayang."
                : "Draf sama dengan versi tayang; ubah dan simpan untuk menyiapkan versi berikutnya."
            }
          />
          <form
            id={formId}
            noValidate
            className="flex flex-col gap-4 p-5"
            onSubmit={form.handleSubmit(() => {
              if (!conflict && dirty) save.mutate(changes);
            })}
          >
            <FormError message={form.formState.errors.root?.server?.message} />
            <FormField<PageFormValues, "title"> control={form.control} name="title" label="Judul" required>
              {(field, a11y) => <Input {...a11y} {...field} maxLength={200} autoComplete="off" />}
            </FormField>
            <FormField<PageFormValues, "slug">
              control={form.control}
              name="slug"
              label="Slug"
              required
              hint={
                base.slug_locked
                  ? `Terkunci karena ${base.system ? "halaman baku" : "halaman pernah terbit"}; tautan /legal/${base.slug} tetap berlaku.`
                  : SLUG_HINT
              }
            >
              {(field, a11y) => (
                <Input
                  {...a11y}
                  {...field}
                  readOnly={base.slug_locked}
                  aria-readonly={base.slug_locked || undefined}
                  maxLength={120}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </FormField>
            <RichTextEditor
              label="Isi halaman"
              required
              value={body.field.value}
              onChange={body.field.onChange}
              error={body.fieldState.error?.message}
              hint="Isi disanitasi server (PRD 3.8)."
              disabled={saving}
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-4">
              <Button
                type="submit"
                variant="outline"
                loading={save.isPending}
                loadingText="Menyimpan..."
                focusableWhenDisabled
                disabled={!dirty || Boolean(conflict)}
              >
                Simpan draf
              </Button>
              <Button
                focusableWhenDisabled
                disabled={!canPublish || saving}
                onClick={() => setPublishOpen(true)}
              >
                Terbitkan versi baru
              </Button>
            </div>
            <p className="text-xs text-text-muted">
              {conflict
                ? "Muat ulang versi terbaru sebelum menyimpan atau menerbitkan."
                : dirty
                  ? "Simpan draf terlebih dahulu; yang diterbitkan adalah draf tersimpan."
                  : base.has_unpublished_changes
                    ? "Draf tersimpan siap diterbitkan sebagai versi baru."
                    : "Tidak ada perubahan untuk diterbitkan."}
            </p>
          </form>
        </Card>
      </div>

      <ConfirmDialog
        open={publishOpen}
        onCancel={() => setPublishOpen(false)}
        onConfirm={() => publish.mutate({ note: changeNote })}
        pending={publish.isPending}
        tone={legal ? "danger" : "primary"}
        title={`Terbitkan versi baru "${base.title}"?`}
        confirmLabel={`Terbitkan versi ${base.published ? Number(base.published.version) + 1 : 1}`}
        acknowledgement="Saya memahami versi legal naik dan teks ini menjadi acuan persetujuan pengguna."
      >
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-text-muted">
          {publishExplanation(base).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <Field label="Catatan perubahan" hint="Opsional; dicatat di audit dan tidak ditampilkan publik.">
          {(a11y) => (
            <Textarea
              {...a11y}
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              maxLength={500}
              showCount
              rows={3}
              disabled={publish.isPending}
            />
          )}
        </Field>
      </ConfirmDialog>
      {guard.dialog}
    </section>
  );
}

interface CreatePageValues {
  title: string;
  slug: string;
  body_html: string;
}

/** Halaman informasi baru selalu draf (belum ada salinan tayang); halaman legal baku dibuat seed referensi. */
function CreatePageDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (page: AdminInfoPage) => void;
}) {
  const formId = useId();
  const queryClient = useQueryClient();
  const form = useForm<CreatePageValues>({
    resolver: zodResolver(pageSchema),
    defaultValues: { title: "", slug: "", body_html: "" },
  });
  const body = useController({ control: form.control, name: "body_html" });

  useEffect(() => {
    form.setFocus("title");
  }, [form]);

  const create = useApiMutation<AdminInfoPage, CreatePageValues, CreatePageValues>({
    setError: form.setError,
    request: (v, ctx) =>
      api.POST("/admin/content/pages", {
        params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: { title: v.title.trim(), slug: v.slug.trim(), body_html: v.body_html },
      }),
    successMessage: (data) =>
      `Halaman "${data.title}" dibuat sebagai draf. Terbitkan agar dapat dibaca publik.`,
    onSuccess: async (data) => {
      queryClient.setQueryData(contentKeys.page(data.id), data);
      await invalidateContent(queryClient);
      onCreated(data);
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      dismissable={!create.isPending}
      title="Buat halaman informasi"
      description="Halaman baru disimpan sebagai draf dan belum terlihat publik sampai diterbitkan."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            Batal
          </Button>
          <Button type="submit" form={formId} loading={create.isPending} loadingText="Menyimpan...">
            Simpan draf
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit((v) => create.mutate(v))}
      >
        <FormError message={form.formState.errors.root?.server?.message} />
        <FormField<CreatePageValues, "title"> control={form.control} name="title" label="Judul" required>
          {(field, a11y) => <Input {...a11y} {...field} maxLength={200} autoComplete="off" />}
        </FormField>
        <FormField<CreatePageValues, "slug">
          control={form.control}
          name="slug"
          label="Slug"
          required
          hint={`${SLUG_HINT} Tautan menjadi /legal/<slug> dan terkunci setelah terbit.`}
        >
          {(field, a11y) => (
            <Input {...a11y} {...field} maxLength={120} autoComplete="off" spellCheck={false} />
          )}
        </FormField>
        <RichTextEditor
          label="Isi halaman"
          required
          value={body.field.value}
          onChange={body.field.onChange}
          error={body.fieldState.error?.message}
          disabled={create.isPending}
        />
      </form>
    </Dialog>
  );
}
