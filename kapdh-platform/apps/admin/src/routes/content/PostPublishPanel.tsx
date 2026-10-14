import { Archive, CalendarClock, CalendarX2, RotateCcw, Send, Trash } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { useApiMutation } from "../../api/query";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { RadioGroup } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { KeyValueList } from "../../components/ui/DataDisplay";
import { DateTimeField } from "../../components/ui/FormatFields";
import { FormField } from "../../components/ui/FormField";
import { formatDateTime } from "../../lib/format";
import { type AdminPost, versionHeaders } from "./contentApi";
import { PostStateBadge } from "./labels";

type Action = "publish" | "unschedule" | "archive" | "restore";
export interface TransitionVars {
  action: Action;
  /** Hanya untuk publish: null = terbit sekarang (waktu server), ISO masa depan = jadwal (AC F08-1). */
  published_at?: string | null;
}

interface ScheduleValues {
  published_at: string | null;
}

/** Pesan sukses per transisi (dibacakan lewat toast). */
export function transitionMessage(vars: TransitionVars, result: AdminPost, before: AdminPost): string {
  switch (vars.action) {
    case "publish":
      if (result.state === "scheduled")
        return `Berita dijadwalkan terbit ${formatDateTime(result.published_at)}.`;
      return before.slug_locked
        ? "Berita tampil kembali dengan tanggal publikasi aslinya."
        : "Berita diterbitkan dan tampil di aplikasi.";
    case "unschedule":
      return "Jadwal dibatalkan; berita kembali menjadi draf.";
    case "archive":
      return "Berita diarsipkan dan tidak tampil di aplikasi.";
    case "restore":
      return "Berita dipulihkan sebagai draf. Terbitkan lagi bila ingin menampilkannya.";
  }
}

interface ConfirmSpec {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone: "primary" | "danger";
}

function confirmSpec(vars: TransitionVars, post: AdminPost): ConfirmSpec {
  const notify =
    "Notifikasi berita dikirim tepat sekali ke anggota aktif (terverifikasi atau segera berakhir) saat berita tampil.";
  switch (vars.action) {
    case "publish":
      if (vars.published_at)
        return {
          title: post.state === "scheduled" ? "Ubah jadwal terbit?" : "Jadwalkan berita?",
          description: `Berita tampil otomatis pada ${formatDateTime(vars.published_at)}. ${notify} Sebelum waktunya, jadwal masih dapat dibatalkan atau berita diarsipkan.`,
          confirmLabel: post.state === "scheduled" ? "Simpan jadwal baru" : "Jadwalkan terbit",
          tone: "primary",
        };
      if (post.state === "draft" && post.slug_locked)
        return {
          title: "Terbitkan ulang berita?",
          description: `Berita tampil kembali dengan tanggal publikasi aslinya (${formatDateTime(post.published_at)}). Berita yang sudah pernah diumumkan tidak diumumkan lagi.`,
          confirmLabel: "Terbitkan ulang",
          tone: "primary",
        };
      return {
        title: "Terbitkan berita sekarang?",
        description: `Berita langsung tampil di Beranda dan daftar Berita aplikasi. ${notify}`,
        confirmLabel: "Terbitkan sekarang",
        tone: "primary",
      };
    case "unschedule":
      return {
        title: "Batalkan jadwal terbit?",
        description: "Berita kembali menjadi draf dan tidak akan terbit otomatis.",
        confirmLabel: "Batalkan jadwal",
        tone: "primary",
      };
    case "archive":
      return {
        title: "Arsipkan berita?",
        description:
          post.state === "scheduled"
            ? "Jadwal terbit dibatalkan dan berita tidak akan pernah terbit otomatis oleh jadwal lama (AC F15-5)."
            : "Berita hilang dari Beranda dan daftar Berita aplikasi. Banner yang menunjuk berita ini ditandai tujuan tidak tersedia.",
        confirmLabel: "Arsipkan berita",
        tone: "danger",
      };
    case "restore":
      return {
        title: "Pulihkan ke draf?",
        description: "Berita menjadi draf dan tetap tidak tampil sampai diterbitkan lagi.",
        confirmLabel: "Pulihkan ke draf",
        tone: "primary",
      };
  }
}

/**
 * Panel status dan penerbitan berita (F-08, AC F08-1, F15-4, F15-5): terbit sekarang, jadwalkan (jam dinding WIB),
 * ubah/batalkan jadwal, arsipkan, pulihkan dan hapus. Setiap transisi mengirim If-Match versi yang dilihat dan
 * Idempotency-Key per niat; transisi yang tidak lagi sah karena keadaan berubah di server dijawab 409 dan editor
 * menawarkan muat ulang. Aksi ditahan selama formulir belum disimpan agar admin tidak menerbitkan versi lama.
 */
export function PostPublishPanel({
  post,
  blockedReason,
  onUpdated,
  onConflict,
  onDeleted,
}: {
  post: AdminPost;
  /** Alasan aksi ditahan (perubahan belum disimpan / konflik versi); null bila aksi boleh. */
  blockedReason: string | null;
  onUpdated: (post: AdminPost) => void;
  onConflict: (error: ApiError) => void;
  onDeleted: () => void;
}) {
  const titleId = useId();
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [pending, setPending] = useState<TransitionVars | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const scheduleForm = useForm<ScheduleValues>({
    defaultValues: { published_at: post.state === "scheduled" ? post.published_at : null },
  });

  const transition = useApiMutation<AdminPost, TransitionVars, ScheduleValues>({
    intent: (v) => [post.id, post.version, v],
    setError: scheduleForm.setError,
    request: (v, ctx) => {
      const params = { path: { postId: post.id }, header: versionHeaders(post.version, ctx) };
      switch (v.action) {
        case "publish":
          return api.POST("/admin/content/posts/{postId}/publish", {
            params,
            body: { published_at: v.published_at ?? null },
          });
        case "unschedule":
          return api.POST("/admin/content/posts/{postId}/unschedule", { params });
        case "archive":
          return api.POST("/admin/content/posts/{postId}/archive", { params });
        case "restore":
          return api.POST("/admin/content/posts/{postId}/restore", { params });
      }
    },
    successMessage: (data, v) => transitionMessage(v, data, post),
    onSuccess: (data) => {
      setPending(null);
      setMode("now");
      scheduleForm.reset({ published_at: data.state === "scheduled" ? data.published_at : null });
      onUpdated(data);
    },
    onReloadLatest: (error) => {
      setPending(null);
      onConflict(error);
    },
    onError: () => setPending(null),
  });

  const remove = useApiMutation<unknown, void>({
    intent: () => [post.id, post.version],
    request: () =>
      api.DELETE("/admin/content/posts/{postId}", {
        params: { path: { postId: post.id }, header: { "If-Match": post.version } },
      }),
    successMessage: `Berita "${post.title}" dihapus.`,
    onSuccess: () => {
      setConfirmDelete(false);
      onDeleted();
    },
    onReloadLatest: (error) => {
      setConfirmDelete(false);
      onConflict(error);
    },
    onError: () => setConfirmDelete(false),
  });

  /** Jadwal wajib di masa depan; server tetap menolak waktu lampau (400) dan menjadi sumber kebenaran. */
  function requestSchedule() {
    const at = scheduleForm.getValues("published_at");
    if (!at) {
      scheduleForm.setError(
        "published_at",
        { message: "Pilih tanggal dan jam terbit." },
        { shouldFocus: true },
      );
      return;
    }
    if (Date.parse(at) <= Date.now()) {
      scheduleForm.setError(
        "published_at",
        { message: "Waktu terbit harus di masa depan. Pilih Terbitkan sekarang untuk menerbitkan langsung." },
        { shouldFocus: true },
      );
      return;
    }
    scheduleForm.clearErrors("published_at");
    setPending({ action: "publish", published_at: at });
  }

  const blocked = Boolean(blockedReason) || transition.isPending || remove.isPending;
  const spec = pending ? confirmSpec(pending, post) : null;
  const state = post.state;
  const canArchive = state !== "archived";
  const canDelete = state === "draft" || state === "archived";

  const scheduleField = (label: string) => (
    <FormField<ScheduleValues, "published_at">
      control={scheduleForm.control}
      name="published_at"
      label={label}
      hint="Jam dinding Asia/Jakarta (WIB). Berita tampil otomatis tepat sekali pada waktu ini."
    >
      {(field, a11y) => (
        <DateTimeField
          {...a11y}
          ref={field.ref}
          name={field.name}
          value={field.value}
          onValueChange={(v) => {
            field.onChange(v);
            scheduleForm.clearErrors("published_at");
          }}
          onBlur={field.onBlur}
          min={new Date().toISOString()}
          disabled={blocked}
        />
      )}
    </FormField>
  );

  return (
    <Card aria-labelledby={titleId}>
      <CardHeader titleId={titleId} title="Status & Penerbitan" />
      <div className="flex flex-col gap-4 p-5">
        <KeyValueList
          items={[
            { label: "Status", value: <PostStateBadge state={state} /> },
            {
              label: state === "scheduled" ? "Jadwal terbit" : "Tgl Publikasi",
              value: post.published_at ? formatDateTime(post.published_at) : "Belum pernah terbit",
            },
            {
              label: "Notifikasi berita",
              wide: true,
              value: post.announced_at
                ? `Sudah dikirim ${formatDateTime(post.announced_at)}; tidak dikirim ulang.`
                : state === "archived"
                  ? "Tidak dikirim (berita diarsipkan sebelum tampil)."
                  : "Dikirim sekali saat berita tampil.",
            },
          ]}
        />

        {blockedReason ? (
          <p className="rounded-md bg-info-bg px-3 py-2 text-sm text-info">{blockedReason}</p>
        ) : null}

        {state === "draft" && !post.slug_locked ? (
          <div className="flex flex-col gap-3">
            <RadioGroup<"now" | "schedule">
              legend="Waktu terbit"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "now", label: "Terbitkan sekarang" },
                { value: "schedule", label: "Jadwalkan", description: "Pilih tanggal dan jam (WIB)." },
              ]}
            />
            {mode === "schedule" ? scheduleField("Tanggal & jam terbit") : null}
            <Button
              disabled={blocked}
              leftIcon={
                mode === "now" ? (
                  <Send aria-hidden="true" className="size-4" />
                ) : (
                  <CalendarClock aria-hidden="true" className="size-4" />
                )
              }
              onClick={() =>
                mode === "now" ? setPending({ action: "publish", published_at: null }) : requestSchedule()
              }
            >
              {mode === "now" ? "Terbitkan sekarang" : "Jadwalkan terbit"}
            </Button>
          </div>
        ) : null}

        {state === "draft" && post.slug_locked ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">
              Berita ini pernah tampil ke anggota. Berita hanya dapat diterbitkan ulang sekarang dan kembali
              tampil dengan tanggal publikasi aslinya; penjadwalan ulang tidak tersedia.
            </p>
            <Button
              disabled={blocked}
              leftIcon={<Send aria-hidden="true" className="size-4" />}
              onClick={() => setPending({ action: "publish", published_at: null })}
            >
              Terbitkan ulang sekarang
            </Button>
          </div>
        ) : null}

        {state === "scheduled" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">
              Berita belum tampil dan akan terbit otomatis pada {formatDateTime(post.published_at)}.
            </p>
            {scheduleField("Ubah jadwal terbit")}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={blocked}
                leftIcon={<CalendarClock aria-hidden="true" className="size-4" />}
                onClick={requestSchedule}
              >
                Simpan jadwal baru
              </Button>
              <Button
                size="sm"
                disabled={blocked}
                leftIcon={<Send aria-hidden="true" className="size-4" />}
                onClick={() => setPending({ action: "publish", published_at: null })}
              >
                Terbitkan sekarang
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={blocked}
                leftIcon={<CalendarX2 aria-hidden="true" className="size-4" />}
                onClick={() => setPending({ action: "unschedule" })}
              >
                Batalkan jadwal
              </Button>
            </div>
          </div>
        ) : null}

        {state === "published" ? (
          <p className="text-sm text-text-muted">
            Berita tampil di aplikasi. Perubahan isi yang disimpan langsung terlihat anggota.
          </p>
        ) : null}

        {state === "archived" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">
              Berita diarsipkan: tidak tampil di aplikasi dan tidak akan diterbitkan lagi oleh jadwal lama.
            </p>
            <Button
              variant="outline"
              disabled={blocked}
              leftIcon={<RotateCcw aria-hidden="true" className="size-4" />}
              onClick={() => setPending({ action: "restore" })}
            >
              Pulihkan ke draf
            </Button>
          </div>
        ) : null}

        {canArchive || canDelete ? (
          <div className="flex flex-wrap gap-2 border-t border-divider pt-4">
            {canArchive ? (
              <Button
                variant="danger"
                size="sm"
                disabled={blocked}
                leftIcon={<Archive aria-hidden="true" className="size-4" />}
                onClick={() => setPending({ action: "archive" })}
              >
                Arsipkan
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                variant="danger"
                size="sm"
                disabled={blocked}
                leftIcon={<Trash aria-hidden="true" className="size-4" />}
                onClick={() => setConfirmDelete(true)}
              >
                Hapus berita
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={spec !== null}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) transition.mutate(pending);
        }}
        pending={transition.isPending}
        title={spec?.title ?? ""}
        description={spec?.description}
        confirmLabel={spec?.confirmLabel ?? ""}
        tone={spec?.tone ?? "primary"}
      />
      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        title="Hapus berita?"
        description={`"${post.title}" akan dihapus permanen beserta like-nya. Banner yang menunjuk berita ini ditandai tujuan tidak tersedia.`}
        confirmLabel="Hapus berita"
        acknowledgement="Saya memahami berita ini tidak dapat dikembalikan."
      />
    </Card>
  );
}
