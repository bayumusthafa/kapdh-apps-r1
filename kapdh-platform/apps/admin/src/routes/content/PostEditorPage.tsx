import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Eye, Save } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useController, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { type ApiError, toApiError } from "../../api/errors";
import { unwrap, useApiMutation, useApiQuery } from "../../api/query";
import { Button, buttonClass } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input, Select, Textarea } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { RichTextEditor } from "../../components/ui/RichTextEditor";
import { ErrorState, Loading, NotFoundState } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";
import { requiredText } from "../../lib/validation";
import { ConflictNotice } from "./ConflictNotice";
import { ContentImageField } from "./ContentImageField";
import {
  type AdminPost,
  conflictCurrent,
  type ContentImage,
  contentKeys,
  fetchCategoryOptions,
  invalidateContent,
  type S,
  SLUG_HINT,
  SLUG_PATTERN,
  slugFromTitle,
} from "./contentApi";
import { PostPreviewDialog } from "./PostPreview";
import { PostPublishPanel } from "./PostPublishPanel";
import { useDeferredFocus } from "./useDeferredFocus";
import { useLeaveGuard } from "./useLeaveGuard";

/**
 * Nilai formulir berita. `cover_file_id` dan `category_id` memakai nama field API agar `field_errors` dari server
 * (VALIDATION_ERROR) langsung terpasang pada isian yang tepat.
 */
export interface PostFormValues {
  title: string;
  slug: string;
  excerpt: string;
  category_id: string;
  cover_file_id: ContentImage | null;
  body_html: string;
}

const schema = z.object({
  title: requiredText("Judul", 1, 200),
  slug: z
    .string()
    .trim()
    .max(160, "Slug maksimal 160 karakter.")
    .refine((v) => v === "" || SLUG_PATTERN.test(v), SLUG_HINT),
  excerpt: z.string().max(300, "Ringkasan maksimal 300 karakter."),
  category_id: z.string(),
  cover_file_id: z.object({ file_id: z.string(), url: z.string() }).nullable(),
  body_html: z.string().min(1, "Isi berita wajib diisi.").max(200_000, "Isi berita terlalu panjang."),
});

export function toPostForm(post: AdminPost | null): PostFormValues {
  return {
    title: post?.title ?? "",
    slug: post?.slug ?? "",
    excerpt: post?.excerpt ?? "",
    category_id: post?.category?.id ?? "",
    cover_file_id: post?.cover ?? null,
    body_html: post?.body_html ?? "",
  };
}

/** Field yang berubah terhadap versi tersimpan; PATCH hanya mengirim field ini (kontrak adminUpdatePost). */
export function postChanges(values: PostFormValues, base: AdminPost): S["AdminPostUpdateRequest"] {
  const out: S["AdminPostUpdateRequest"] = {};
  const title = values.title.trim();
  if (title !== base.title) out.title = title;
  const slug = values.slug.trim();
  if (!base.slug_locked && slug !== "" && slug !== base.slug) out.slug = slug;
  const excerpt = values.excerpt.trim() === "" ? null : values.excerpt.trim();
  if (excerpt !== base.excerpt) out.excerpt = excerpt;
  if (values.body_html !== base.body_html) out.body_html = values.body_html;
  const cover = values.cover_file_id?.file_id ?? null;
  if (cover !== (base.cover?.file_id ?? null)) out.cover_file_id = cover;
  const category = values.category_id === "" ? null : values.category_id;
  if (category !== (base.category?.id ?? null)) out.category_id = category;
  return out;
}

function createBody(values: PostFormValues): S["AdminPostCreateRequest"] {
  const slug = values.slug.trim();
  const excerpt = values.excerpt.trim();
  return {
    title: values.title.trim(),
    ...(slug ? { slug } : {}),
    excerpt: excerpt === "" ? null : excerpt,
    body_html: values.body_html,
    cover_file_id: values.cover_file_id?.file_id ?? null,
    category_id: values.category_id === "" ? null : values.category_id,
  };
}

const BREADCRUMB_ROOT = { label: "Manajemen Konten", to: "/content" } as const;

/** Rute /content/posts/new dan /content/posts/$postId (guideline p13 "Tambah Konten Baru" / "Edit Konten"). */
export function PostEditorPage() {
  const params = useParams({ strict: false }) as { postId?: string };
  return params.postId ? (
    <ExistingPostEditor key={params.postId} postId={params.postId} />
  ) : (
    <PostEditor initial={null} />
  );
}

function ExistingPostEditor({ postId }: { postId: string }) {
  const detail = useApiQuery<AdminPost>({
    queryKey: contentKeys.post(postId),
    request: ({ signal, headers }) =>
      api.GET("/admin/content/posts/{postId}", { params: { path: { postId } }, signal, headers }),
  });
  if (detail.data) return <PostEditor initial={detail.data} />;
  return (
    <>
      <PageHeader title="Edit Konten" breadcrumbs={[BREADCRUMB_ROOT, { label: "Edit Konten" }]} />
      <Card>
        {detail.isPending ? (
          <Loading label="Memuat berita..." rows={6} />
        ) : detail.error?.code === "NOT_FOUND" ? (
          <NotFoundState
            description="Berita mungkin sudah dihapus pengurus lain."
            action={
              <Link to="/content" className={buttonClass({ variant: "outline", size: "sm" })}>
                Kembali ke daftar berita
              </Link>
            }
          />
        ) : (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        )}
      </Card>
    </>
  );
}

/**
 * Formulir berita (F-08, F-15): judul, slug, ringkasan, kategori, cover dan isi teks kaya (TipTap). Berita baru
 * disimpan sebagai draf (Idempotency-Key mencegah draf ganda); perubahan mengirim hanya field yang berubah dengan
 * If-Match versi yang dilihat. Konflik versi tidak pernah menimpa diam-diam: pemberitahuan dengan tombol muat
 * ulang ditampilkan dan simpan/terbit ditahan sampai admin memuat versi terbaru (AC F15-4).
 */
function PostEditor({ initial }: { initial: AdminPost | null }) {
  const isNew = initial === null;
  const formId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [base, setBase] = useState<AdminPost | null>(initial);
  const [conflict, setConflict] = useState<{ latest: AdminPost | null } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const form = useForm<PostFormValues>({ resolver: zodResolver(schema), defaultValues: toPostForm(initial) });
  const values = form.watch();
  const changes = base ? postChanges(values, base) : null;
  const dirty = base ? Object.keys(changes ?? {}).length > 0 : form.formState.isDirty;
  const guard = useLeaveGuard(dirty, "Perubahan berita");
  const focusTitle = useDeferredFocus(() => form.setFocus("title"));

  const categories = useApiQuery({
    queryKey: contentKeys.categoryOptions("post"),
    staleTime: 60_000,
    request: (ctx) => fetchCategoryOptions("post", ctx),
  });
  const categoryOptions = useMemo(() => {
    const current = base?.category?.id ?? null;
    // Kategori nonaktif hanya boleh dipertahankan, tidak dipilih baru (kontrak AdminPostUpdateRequest).
    const items = (categories.data?.items ?? []).filter((c) => c.active || c.id === current);
    return [
      { value: "", label: "Tanpa kategori" },
      ...items.map((c) => ({ value: c.id, label: c.active ? c.label : `${c.label} (nonaktif)` })),
    ];
  }, [categories.data, base?.category?.id]);

  /** Data terbaru dari server menjadi dasar formulir (setelah simpan, transisi, atau muat ulang konflik). */
  function applyLatest(post: AdminPost) {
    setBase(post);
    form.reset(toPostForm(post));
    queryClient.setQueryData(contentKeys.post(post.id), post);
    void invalidateContent(queryClient);
  }

  // Data di cache diperbarui (mis. fokus jendela) dan admin belum mengubah apa pun: ikuti versi terbaru. Bila ada
  // isian yang belum disimpan, versi baru TIDAK menimpanya; simpan berikutnya akan memunculkan konflik (AC F15-4).
  useEffect(() => {
    if (!initial || !base || initial.id !== base.id || initial.version === base.version) return;
    if (dirty || conflict) return;
    setBase(initial);
    form.reset(toPostForm(initial));
    // Hanya bereaksi pada objek baru dari cache; `dirty`/`conflict` dibaca dari render terakhir.
  }, [initial]);

  function handleConflict(error: ApiError) {
    if (!base) return;
    setConflict({ latest: conflictCurrent<AdminPost>(error, base.id) });
  }

  async function reloadLatest() {
    if (!base) return;
    try {
      const latest =
        conflict?.latest ??
        (await queryClient.fetchQuery<AdminPost>({
          queryKey: contentKeys.post(base.id),
          staleTime: 0,
          queryFn: ({ signal }) =>
            unwrap<AdminPost>(
              api.GET("/admin/content/posts/{postId}", { params: { path: { postId: base.id } }, signal }),
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

  const create = useApiMutation<AdminPost, PostFormValues, PostFormValues>({
    setError: form.setError,
    request: (v, ctx) =>
      api.POST("/admin/content/posts", {
        params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: createBody(v),
      }),
    successMessage: "Draf berita disimpan. Terbitkan atau jadwalkan dari panel Status & Penerbitan.",
    onSuccess: async (data) => {
      queryClient.setQueryData(contentKeys.post(data.id), data);
      void invalidateContent(queryClient);
      guard.allowNextNavigation();
      await navigate({ to: "/content/posts/$postId", params: { postId: data.id }, replace: true });
    },
  });

  const update = useApiMutation<AdminPost, S["AdminPostUpdateRequest"], PostFormValues>({
    intent: (body) => [base?.id, base?.version, body],
    setError: form.setError,
    request: (body) =>
      api.PATCH("/admin/content/posts/{postId}", {
        params: { path: { postId: base!.id }, header: { "If-Match": base!.version } },
        body,
      }),
    successMessage: (data) =>
      data.state === "published"
        ? "Perubahan disimpan dan langsung terlihat anggota."
        : "Perubahan disimpan.",
    onSuccess: (data) => applyLatest(data),
    onReloadLatest: (error) => handleConflict(error),
  });

  function submit(v: PostFormValues) {
    if (conflict) return;
    if (!base) {
      create.mutate(v);
      return;
    }
    if (!base.slug_locked && v.slug.trim() === "") {
      form.setError("slug", { message: "Slug wajib diisi." }, { shouldFocus: true });
      return;
    }
    const body = postChanges(v, base);
    if (Object.keys(body).length > 0) update.mutate(body);
  }

  const saving = create.isPending || update.isPending;
  const title = isNew ? "Tambah Konten Baru" : "Edit Konten";
  const cover = useController({ control: form.control, name: "cover_file_id" });
  const body = useController({ control: form.control, name: "body_html" });
  const categoryLabel =
    categoryOptions.find((o) => o.value === values.category_id && o.value !== "")?.label ?? null;
  const saveLabel = !base || base.state === "draft" ? "Simpan draf" : "Simpan perubahan";
  const blockedReason = conflict
    ? "Muat ulang versi terbaru sebelum menerbitkan atau mengubah status."
    : dirty
      ? "Simpan perubahan terlebih dahulu sebelum menerbitkan atau mengubah status."
      : null;

  return (
    <>
      <PageHeader
        title={title}
        breadcrumbs={[BREADCRUMB_ROOT, { label: title }]}
        description={
          isNew
            ? "Berita disimpan sebagai draf lebih dahulu; terbitkan sekarang atau jadwalkan setelah draf tersimpan."
            : `Tautan anggota: /news/${base?.slug ?? ""}`
        }
        actions={
          <>
            <Link to="/content" className={buttonClass({ variant: "ghost", size: "sm" })}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              Daftar berita
            </Link>
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Eye aria-hidden="true" className="size-4" />}
              onClick={() => setPreviewOpen(true)}
            >
              Pratinjau
            </Button>
          </>
        }
      />

      {conflict && base ? (
        <ConflictNotice
          subject="Berita ini"
          updatedAt={conflict.latest?.updated_at}
          updatedBy={conflict.latest?.author?.display_name}
          onReload={() => void reloadLatest()}
        />
      ) : null}

      <div className="flex flex-wrap items-start gap-5">
        <Card className="min-w-0 flex-[3_1_520px]" aria-labelledby={`${formId}-isi`}>
          <CardHeader titleId={`${formId}-isi`} title="Isi berita" />
          <form
            id={formId}
            noValidate
            onSubmit={form.handleSubmit(submit)}
            className="flex flex-col gap-4 p-5"
            aria-label={title}
          >
            <FormError message={form.formState.errors.root?.server?.message} />
            <FormField<PostFormValues, "title">
              control={form.control}
              name="title"
              label="Judul konten"
              required
            >
              {(field, a11y) => <Input {...a11y} {...field} maxLength={200} autoComplete="off" />}
            </FormField>
            <FormField<PostFormValues, "slug">
              control={form.control}
              name="slug"
              label="Slug tautan"
              required={Boolean(base && !base.slug_locked)}
              hint={
                base?.slug_locked
                  ? `Terkunci karena berita pernah tampil ke anggota; tautan /news/${base.slug} di notifikasi dan banner tetap berlaku.`
                  : isNew
                    ? `Kosongkan agar dibuat otomatis dari judul${values.title.trim() ? ` (${slugFromTitle(values.title)})` : ""}. ${SLUG_HINT}`
                    : `${SLUG_HINT} Dapat diubah selama berita belum pernah tampil.`
              }
            >
              {(field, a11y) => (
                <Input
                  {...a11y}
                  {...field}
                  readOnly={Boolean(base?.slug_locked)}
                  aria-readonly={base?.slug_locked ? true : undefined}
                  maxLength={160}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={isNew ? slugFromTitle(values.title) || "contoh-judul-berita" : undefined}
                />
              )}
            </FormField>
            <FormField<PostFormValues, "excerpt">
              control={form.control}
              name="excerpt"
              label="Ringkasan"
              hint="Opsional; tampil di daftar berita aplikasi."
            >
              {(field, a11y) => <Textarea {...a11y} {...field} maxLength={300} showCount rows={3} />}
            </FormField>
            <RichTextEditor
              label="Isi berita"
              required
              value={body.field.value}
              onChange={body.field.onChange}
              error={body.fieldState.error?.message}
              hint="Tautan hanya https:// atau mailto:. Isi disanitasi server sebelum disimpan (PRD 3.8)."
              disabled={saving}
            />
          </form>
        </Card>

        <div className="flex min-w-0 flex-[2_1_320px] flex-col gap-5">
          <Card aria-labelledby={`${formId}-meta`}>
            <CardHeader titleId={`${formId}-meta`} title="Kategori & Gambar" />
            <div className="flex flex-col gap-4 p-5">
              <FormField<PostFormValues, "category_id">
                control={form.control}
                name="category_id"
                label="Kategori"
              >
                {(field, a11y) => (
                  <Select
                    {...a11y}
                    ref={field.ref}
                    name={field.name}
                    onBlur={field.onBlur}
                    options={categoryOptions}
                    value={field.value}
                    onValueChange={field.onChange}
                  />
                )}
              </FormField>
              <ContentImageField
                purpose="post_cover"
                label="Gambar cover"
                value={cover.field.value}
                onChange={cover.field.onChange}
                onBlur={cover.field.onBlur}
                buttonRef={cover.field.ref}
                error={cover.fieldState.error?.message}
                previewAlt={`Cover ${values.title || "berita"}`}
                disabled={saving}
              />
            </div>
          </Card>

          <Card className="flex flex-col gap-3 p-5">
            <Button
              type="submit"
              form={formId}
              fullWidth
              loading={saving}
              loadingText="Menyimpan..."
              focusableWhenDisabled
              disabled={Boolean(conflict) || (!isNew && !dirty)}
              leftIcon={<Save aria-hidden="true" className="size-4" />}
            >
              {saveLabel}
            </Button>
            <p className="text-xs text-text-muted">
              {conflict
                ? "Simpan ditahan: muat ulang versi terbaru lebih dahulu."
                : !isNew && !dirty
                  ? "Belum ada perubahan untuk disimpan."
                  : base?.state === "published"
                    ? "Berita sedang tampil: perubahan langsung terlihat anggota setelah disimpan."
                    : "Draf belum terlihat anggota sampai diterbitkan."}
            </p>
          </Card>

          {base ? (
            <PostPublishPanel
              key={base.version}
              post={base}
              blockedReason={blockedReason}
              onUpdated={applyLatest}
              onConflict={handleConflict}
              onDeleted={() => {
                queryClient.removeQueries({ queryKey: contentKeys.post(base.id) });
                void invalidateContent(queryClient);
                guard.allowNextNavigation();
                void navigate({ to: "/content" });
              }}
            />
          ) : (
            <Card className="p-5 text-sm text-text-muted">
              Simpan draf terlebih dahulu untuk menerbitkan sekarang atau menjadwalkan terbit.
            </Card>
          )}
        </div>
      </div>

      <PostPreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        data={{
          title: values.title.trim(),
          excerpt: values.excerpt.trim(),
          categoryLabel: categoryLabel?.replace(/ \(nonaktif\)$/, "") ?? null,
          cover: values.cover_file_id,
          bodyHtml: values.body_html,
          publishedAt: base?.state === "published" ? base.published_at : null,
          likeCount: base?.like_count ?? 0,
        }}
      />
      {guard.dialog}
    </>
  );
}
