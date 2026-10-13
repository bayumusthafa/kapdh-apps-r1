import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Clock, ImageOff, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge, MembershipStatusBadge, ReportStatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox, RadioGroup, type RadioOption } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { KeyValueList, Timeline } from "../../components/ui/DataDisplay";
import { FormError, FormField } from "../../components/ui/FormField";
import { Select, Textarea } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { PermissionGate } from "../../components/ui/PermissionGate";
import { ErrorState, ForbiddenState, Loading } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { DELETED_ACCOUNT_LABEL } from "../../lib/labels";
import {
  ACTION_LABEL,
  CATEGORY_LABEL,
  HISTORY_LABEL,
  PriorityBadge,
  REPORTS_KEY,
  reportDetailKey,
  TARGET_LABEL,
} from "./labels";

type Detail = components["schemas"]["AdminModerationReportDetail"];
type Action = components["schemas"]["ModerationAction"];
type EvidenceImage = components["schemas"]["AdminModerationEvidenceImage"];

interface Notice {
  tone: "success" | "warning";
  message: string;
  seq: number;
}

/** Akibat tindakan yang ditampilkan sebelum konfirmasi (PRD 4.5, AC F12-3..F12-5). */
export const ACTION_CONSEQUENCE: Record<Action, string> = {
  dismiss: "Tidak ada perubahan pada anggota. Pelapor diberi tahu laporan selesai ditinjau.",
  warn: "Anggota menerima peringatan berisi pesan di bawah. Tanggal keanggotaan tidak berubah (AC F12-3).",
  suspend:
    "Sesi umum anggota dicabut, akses komunitas ditolak, profil hilang dari direktori, verifikasi KTA menjadi Tidak aktif dan tiket tidak berlaku (AC F12-4). Tanggal periode tidak dibuang.",
  unsuspend:
    "Suspend dicabut; status dihitung ulang dari masa aktif, sehingga anggota yang masa aktifnya habis menjadi expired, bukan otomatis terverifikasi (AC F12-5).",
};

/**
 * Detail laporan moderasi (F-12, AC F12-2..F12-5, PRD 3.12; izin moderation.read, keputusan moderation.resolve).
 * Menampilkan bukti terminimalkan yang direkam saat laporan dibuat (pesan dan konteks, profil, grup, atau suspend yang
 * dibanding), pihak terlapor dengan status terkini dan riwayat moderasinya. Klaim dan keputusan memakai If-Match;
 * keputusan pengurus lain yang lebih dulu memuat ulang data (409). Suspend/unsuspend wajib konfirmasi eksplisit.
 */
export function ReportDetailPage() {
  const { reportId } = useParams({ from: "/app/moderation/$reportId" });
  return (
    <PermissionGate
      allOf={["moderation.read"]}
      fallback={
        <>
          <PageHeader
            title="Detail Laporan"
            breadcrumbs={[{ label: "Moderasi", to: "/moderation" }, { label: "Detail Laporan" }]}
          />
          <Card>
            <ForbiddenState description="Bukti laporan memerlukan izin Membaca laporan moderasi (moderation.read). Hubungi Super Admin bila Anda memerlukannya." />
          </Card>
        </>
      }
    >
      <ReportDetail reportId={reportId} />
    </PermissionGate>
  );
}

function ReportDetail({ reportId }: { reportId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const detail = useApiQuery({
    queryKey: reportDetailKey(reportId),
    request: ({ signal, headers }) =>
      api.GET("/admin/reports/{reportId}", { params: { path: { reportId } }, signal, headers }),
  });
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const notify = (tone: Notice["tone"], message: string) =>
    setNotice((n) => ({ tone, message, seq: (n?.seq ?? 0) + 1 }));
  const seq = notice?.seq ?? 0;
  useEffect(() => {
    if (seq === 0) return;
    const active = document.activeElement;
    if (!active || active === document.body) noticeRef.current?.focus();
  }, [seq]);

  /** 409: data terbaru dari `current` (atau muat ulang) tanpa menimpa keputusan pengurus lain. */
  const applyLatest = (error: ApiError) => {
    const current = error.current as Detail | undefined;
    if (current && typeof current === "object" && "version" in current)
      queryClient.setQueryData(reportDetailKey(reportId), current);
    else void detail.refetch();
    void queryClient.invalidateQueries({ queryKey: [...REPORTS_KEY, "list"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-dashboard"] });
    notify("warning", "Laporan ini sudah diubah atau diputus pengurus lain. Data terbaru dimuat ulang.");
  };

  const breadcrumbs = [{ label: "Moderasi", to: "/moderation" as const }, { label: "Detail Laporan" }];
  if (detail.isPending)
    return (
      <>
        <PageHeader title="Detail Laporan" breadcrumbs={breadcrumbs} />
        <Card className="p-2">
          <Loading label="Memuat laporan..." rows={6} />
        </Card>
      </>
    );
  if (detail.isError)
    return (
      <>
        <PageHeader title="Detail Laporan" breadcrumbs={breadcrumbs} />
        <Card>
          <ErrorState
            error={detail.error}
            onRetry={() => void detail.refetch()}
            title="Laporan gagal dimuat"
          />
        </Card>
      </>
    );
  const r = detail.data;
  const canResolve = auth.can("moderation.resolve");
  const decidable = r.status === "open" || r.status === "in_review";
  return (
    <>
      <PageHeader
        title={`Laporan ${CATEGORY_LABEL[r.category]}`}
        description="Bukti terbatas yang direkam saat laporan dibuat. Setiap pembukaan bukti tercatat di audit."
        breadcrumbs={breadcrumbs}
      />
      <div
        ref={noticeRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={
          notice
            ? cn(
                "rounded-md p-3 text-sm font-medium outline-none",
                notice.tone === "success" ? "bg-success-bg text-success" : "bg-warning-bg text-warning",
              )
            : "outline-none"
        }
      >
        {notice?.message ?? ""}
      </div>
      {r.conflict_of_interest ? (
        <p role="note" className="flex items-start gap-2 rounded-md bg-warning-bg p-3 text-sm text-warning">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Laporan ini dibuat akun alumni yang tertaut ke akun admin Anda. Anda dapat membacanya, tetapi klaim
          dan keputusan harus dilakukan pengurus lain (PRD 2.3).
        </p>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-5">
          <SummaryCard report={r} />
          <EvidenceCard report={r} onRefresh={() => void detail.refetch()} />
        </div>
        <div className="flex flex-col gap-5">
          <TargetCard report={r} />
          {r.resolution ? <ResolutionCard report={r} /> : null}
          {canResolve && decidable && !r.conflict_of_interest ? (
            <>
              <ClaimCard report={r} notify={notify} onConflict={applyLatest} />
              <ResolveCard key={r.version} report={r} notify={notify} onConflict={applyLatest} />
            </>
          ) : null}
          {!canResolve && decidable ? (
            <p role="note" className="text-sm text-text-muted">
              Akun Anda hanya dapat membaca laporan. Klaim dan keputusan memerlukan izin Menyelesaikan laporan
              moderasi (moderation.resolve).
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}

function partyText(p: { full_name: string; member_number: string | null } | null): string {
  if (!p) return DELETED_ACCOUNT_LABEL;
  return p.member_number ? `${p.full_name} (${p.member_number})` : p.full_name;
}

function SummaryCard({ report: r }: { report: Detail }) {
  return (
    <Card aria-labelledby="laporan-ringkasan" className="flex flex-col gap-4 pb-5">
      <CardHeader
        titleId="laporan-ringkasan"
        title="Ringkasan"
        actions={
          <span className="flex flex-wrap gap-1.5">
            <ReportStatusBadge status={r.status} />
            <PriorityBadge priority={r.priority} />
            {r.overdue ? (
              <Badge tone="warning" icon={<Clock />}>
                Lewat target
              </Badge>
            ) : null}
          </span>
        }
      />
      <div className="px-5">
        <KeyValueList
          items={[
            { label: "Kategori", value: CATEGORY_LABEL[r.category] },
            {
              label: "Objek",
              value: TARGET_LABEL[r.target_type] + (r.room_name ? ` di grup ${r.room_name}` : ""),
            },
            { label: "Dibuat", value: formatDateTime(r.created_at) },
            { label: "Target penanganan", value: formatDateTime(r.due_at) },
            { label: r.category === "appeal" ? "Pemohon banding" : "Pelapor", value: partyText(r.reporter) },
            {
              label: "Peninjau",
              value: r.claimed_by
                ? `${r.claimed_by.display_name} sejak ${formatDateTime(r.claimed_at)}`
                : "Belum diklaim",
            },
            {
              label: r.category === "appeal" ? "Alasan banding" : "Penjelasan pelapor",
              value: r.description ?? "-",
              wide: true,
            },
            {
              label: "Laporan aktif lain terhadap pihak yang sama",
              value: String(r.open_reports_against_target),
            },
          ]}
        />
      </div>
    </Card>
  );
}

/** Gambar bukti bertanda tangan maksimal 10 menit; berkas yang dihapus sesuai retensi D2 ditampilkan sebagai teks. */
function EvidenceImageView({
  image,
  alt,
  onRefresh,
}: {
  image: EvidenceImage | null;
  alt: string;
  onRefresh: () => void;
}) {
  const now = useNow(15_000);
  if (!image) return null;
  if (!image.url)
    return (
      <p className="flex items-center gap-2 text-xs text-text-muted">
        <ImageOff aria-hidden="true" className="size-4" />
        Berkas sudah dihapus sesuai kebijakan retensi (D2).
      </p>
    );
  if (image.url_expires_at && Date.parse(image.url_expires_at) <= now.getTime())
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        Tautan bukti kedaluwarsa (berlaku 10 menit).
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
          onClick={onRefresh}
        >
          Muat ulang bukti
        </Button>
      </div>
    );
  return (
    <img
      src={image.url}
      alt={alt}
      referrerPolicy="no-referrer"
      className="max-h-64 max-w-full rounded-md border border-divider object-contain"
    />
  );
}

function EvidenceCard({ report: r, onRefresh }: { report: Detail; onRefresh: () => void }) {
  const e = r.evidence;
  return (
    <Card aria-labelledby="laporan-bukti" className="flex flex-col gap-4 pb-5">
      <CardHeader
        titleId="laporan-bukti"
        title="Bukti"
        description={`Direkam ${formatDateTime(e.captured_at)}. Pengurus tidak dapat menjelajah chat lain di luar bukti ini (PRD 3.12).`}
      />
      <div className="flex flex-col gap-4 px-5">
        {e.messages.length > 0 ? (
          <ol aria-label="Pesan bukti" className="flex flex-col gap-2">
            {e.messages.map((m) => (
              <li
                key={m.message_id}
                className={cn(
                  "flex flex-col gap-1 rounded-md border p-3 text-sm",
                  m.reported ? "border-danger bg-danger-bg" : "border-divider",
                )}
              >
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold">{m.sender_name ?? DELETED_ACCOUNT_LABEL}</span>
                  <span className="text-text-muted">{formatDateTime(m.created_at)}</span>
                  {m.reported ? (
                    <Badge tone="danger">Pesan yang dilaporkan</Badge>
                  ) : (
                    <Badge tone="neutral">Konteks</Badge>
                  )}
                </span>
                {m.kind === "system" ? <em className="text-text-muted">Pesan sistem</em> : null}
                {m.body ? <p className="whitespace-pre-wrap break-words">{m.body}</p> : null}
                <EvidenceImageView
                  image={m.image}
                  alt={`Gambar dari ${m.sender_name ?? "pengirim"} pada ${formatDateTime(m.created_at)}`}
                  onRefresh={onRefresh}
                />
                {m.deleted_since_report ? (
                  <p className="text-xs text-text-muted">
                    Pesan asli sudah dihapus setelah laporan dibuat; snapshot bukti tetap utuh.
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        {e.room ? (
          <section
            aria-label="Snapshot grup"
            className="flex flex-col gap-2 rounded-md border border-divider p-3 text-sm"
          >
            <h3 className="font-semibold">Grup saat dilaporkan</h3>
            <p>
              {e.room.name ?? "Tanpa nama"} | {e.room.member_count} anggota
            </p>
            <EvidenceImageView
              image={e.room.avatar}
              alt={`Avatar grup ${e.room.name ?? ""}`}
              onRefresh={onRefresh}
            />
          </section>
        ) : null}
        {e.profile ? (
          <section
            aria-label="Snapshot profil"
            className="flex flex-col gap-2 rounded-md border border-divider p-3 text-sm"
          >
            <h3 className="font-semibold">Profil saat dilaporkan</h3>
            <p>{e.profile.full_name ?? DELETED_ACCOUNT_LABEL}</p>
            {e.profile.bio ? <p className="text-text-muted">{e.profile.bio}</p> : null}
            <EvidenceImageView
              image={e.profile.avatar}
              alt={`Foto profil ${e.profile.full_name ?? ""}`}
              onRefresh={onRefresh}
            />
          </section>
        ) : null}
        {e.contested_suspension ? (
          <section
            aria-label="Suspend yang dibanding"
            className="flex flex-col gap-2 rounded-md border border-divider p-3 text-sm"
          >
            <h3 className="flex flex-wrap items-center gap-2 font-semibold">
              Suspend yang dibanding
              {e.contested_suspension.in_force ? (
                <Badge tone="warning">Masih berlaku</Badge>
              ) : (
                <Badge tone="neutral">Sudah dicabut (banding usang)</Badge>
              )}
            </h3>
            <KeyValueList
              items={[
                { label: "Disuspend", value: formatDateTime(e.contested_suspension.suspended_at) },
                {
                  label: "Oleh",
                  value: e.contested_suspension.suspended_by?.display_name ?? "Akun admin dihapus",
                },
                {
                  label: "Alasan internal",
                  value: e.contested_suspension.suspension_reason ?? "-",
                  wide: true,
                },
                {
                  label: "Pesan untuk anggota",
                  value: e.contested_suspension.suspension_message ?? "-",
                  wide: true,
                },
              ]}
            />
          </section>
        ) : null}
        {e.messages.length === 0 && !e.room && !e.profile && !e.contested_suspension ? (
          <p className="text-sm text-text-muted">Tidak ada bukti tambahan yang direkam.</p>
        ) : null}
      </div>
    </Card>
  );
}

function TargetCard({ report: r }: { report: Detail }) {
  const t = r.target_member;
  return (
    <Card aria-labelledby="laporan-terlapor" className="flex flex-col gap-4 pb-5">
      <CardHeader titleId="laporan-terlapor" title={r.category === "appeal" ? "Pemohon" : "Pihak terlapor"} />
      <div className="flex flex-col gap-4 px-5">
        {t ? (
          <KeyValueList
            items={[
              { label: "Nama", value: partyText(t) },
              { label: "Angkatan", value: t.cohort ?? "-" },
              { label: "Status keanggotaan", value: <MembershipStatusBadge status={t.effective_status} /> },
              { label: "Masa aktif sampai", value: t.expires_at ? formatDateTime(t.expires_at) : "-" },
              ...(t.suspended_at
                ? [
                    { label: "Disuspend sejak", value: formatDateTime(t.suspended_at) },
                    { label: "Pesan suspend", value: t.suspension_message ?? "-", wide: true },
                  ]
                : []),
            ]}
          />
        ) : (
          <p className="text-sm text-text-muted">
            {r.target_type === "room"
              ? "Laporan grup tanpa subjek; pilih anggota yang dikenai tindakan saat memutus."
              : "Akun pihak terlapor sudah dihapus (data dianonimkan, D2)."}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Riwayat moderasi</h3>
          {r.target_history.length === 0 ? (
            <p className="text-sm text-text-muted">Belum ada peringatan atau suspend.</p>
          ) : (
            <Timeline
              label="Riwayat moderasi pihak terlapor"
              items={r.target_history.map((h, i) => ({
                id: `${h.created_at}-${i}`,
                title: HISTORY_LABEL[h.kind],
                time: formatDateTime(h.created_at),
                description: [h.actor_name ? `Oleh ${h.actor_name}` : null, h.reason]
                  .filter(Boolean)
                  .join(" | "),
                tone: h.kind === "suspend" ? "danger" : h.kind === "warn" ? "warning" : "success",
              }))}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

function ResolutionCard({ report: r }: { report: Detail }) {
  const res = r.resolution!;
  return (
    <Card aria-labelledby="laporan-keputusan" className="flex flex-col gap-4 pb-5">
      <CardHeader titleId="laporan-keputusan" title="Keputusan" />
      <div className="px-5">
        <KeyValueList
          items={[
            { label: "Tindakan", value: ACTION_LABEL[res.action] },
            { label: "Diputus", value: formatDateTime(res.resolved_at) },
            { label: "Oleh", value: res.resolved_by?.display_name ?? "Akun admin dihapus" },
            { label: "Pesan terlapor dihapus", value: res.message_removed ? "Ya (placeholder)" : "Tidak" },
            { label: "Catatan internal", value: res.note, wide: true },
            { label: "Pesan untuk anggota", value: res.member_message ?? "-", wide: true },
          ]}
        />
      </div>
    </Card>
  );
}

function ClaimCard({
  report: r,
  notify,
  onConflict,
}: {
  report: Detail;
  notify: (tone: Notice["tone"], message: string) => void;
  onConflict: (error: ApiError) => void;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const mine = r.claimed_by?.admin_id === auth.profile?.admin_id;
  const claim = useApiMutation<Detail, { version: string }>({
    request: (v, ctx) =>
      api.POST("/admin/reports/{reportId}/claim", {
        params: {
          path: { reportId: r.id },
          header: { "If-Match": v.version, "Idempotency-Key": ctx.idempotencyKey },
        },
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(reportDetailKey(r.id), data);
      void queryClient.invalidateQueries({ queryKey: [...REPORTS_KEY, "list"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-dashboard"] });
      notify("success", "Laporan diklaim; Anda tercatat sebagai peninjau.");
    },
    onReloadLatest: onConflict,
  });
  if (r.status === "in_review" && mine)
    return <p className="rounded-md bg-info-bg p-3 text-sm text-info">Anda sedang meninjau laporan ini.</p>;
  return (
    <Card aria-labelledby="laporan-klaim" className="flex flex-col gap-3 pb-5">
      <CardHeader
        titleId="laporan-klaim"
        title="Peninjauan"
        description={
          r.status === "in_review"
            ? `Sedang ditinjau ${r.claimed_by?.display_name ?? "pengurus lain"}. Ambil alih hanya bila sudah berkoordinasi.`
            : "Klaim agar pengurus lain tahu laporan ini sedang Anda tangani. Klaim tidak wajib sebelum memutus."
        }
      />
      <div className="px-5">
        <Button
          variant="outline"
          loading={claim.isPending}
          loadingText="Mengklaim..."
          onClick={() => claim.mutate({ version: r.version })}
        >
          {r.status === "in_review" ? "Ambil alih peninjauan" : "Klaim untuk ditinjau"}
        </Button>
      </div>
    </Card>
  );
}

const resolveSchema = z.object({
  action: z.string().min(1, "Pilih tindakan."),
  note: z.string().trim().min(3, "Catatan minimal 3 karakter.").max(1000, "Catatan maksimal 1000 karakter."),
  member_message: z.string().trim().max(500, "Pesan maksimal 500 karakter."),
  subject_user_id: z.string(),
  remove_message: z.boolean(),
});
type ResolveValues = z.infer<typeof resolveSchema>;

/** Tindakan yang ditawarkan sesuai jenis laporan dan status anggota (kontrak adminResolveReport). */
export function actionOptions(
  r: Pick<Detail, "category" | "target_member" | "evidence">,
): RadioOption<Action>[] {
  if (r.category === "appeal") {
    if (r.evidence.contested_suspension?.in_force === false)
      return [
        {
          value: "unsuspend",
          label: "Tutup sebagai dikabulkan",
          description: "Suspend yang dibanding sudah dicabut; keanggotaan tidak berubah.",
        },
      ];
    return [
      { value: "dismiss", label: "Tolak banding", description: "Suspend tetap berlaku." },
      {
        value: "unsuspend",
        label: "Kabulkan banding (cabut suspend)",
        description: "Status dihitung ulang dari masa aktif.",
      },
    ];
  }
  const suspended = Boolean(r.target_member?.suspended_at);
  const options: RadioOption<Action>[] = [
    { value: "dismiss", label: ACTION_LABEL.dismiss, description: "Bukan pelanggaran; tidak ada tindakan." },
    {
      value: "warn",
      label: ACTION_LABEL.warn,
      description: "Peringatan tanpa mengubah tanggal keanggotaan.",
    },
  ];
  if (suspended)
    options.push({
      value: "unsuspend",
      label: ACTION_LABEL.unsuspend,
      description: "Akhiri suspend yang berlaku.",
    });
  else
    options.push({
      value: "suspend",
      label: ACTION_LABEL.suspend,
      description: "Batasi akses komunitas anggota.",
    });
  return options;
}

function ResolveCard({
  report: r,
  notify,
  onConflict,
}: {
  report: Detail;
  notify: (tone: Notice["tone"], message: string) => void;
  onConflict: (error: ApiError) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const options = actionOptions(r);
  const form = useForm<ResolveValues>({
    resolver: zodResolver(resolveSchema),
    defaultValues: {
      action: options.length === 1 ? options[0]!.value : "",
      note: "",
      member_message: "",
      subject_user_id: "",
      remove_message: false,
    },
  });
  const action = form.watch("action") as Action | "";
  const appeal = r.category === "appeal";
  const needsMessage = action === "warn" || action === "suspend" || appeal;
  const needsSubject =
    r.target_type === "room" && !r.target_member && (action === "warn" || action === "suspend");
  const subjects = [
    ...new Map(
      r.evidence.messages
        .filter((m) => m.sender_user_id)
        .map((m) => [m.sender_user_id!, m.sender_name ?? "Anggota tanpa nama"] as const),
    ),
  ];
  const strong = action === "suspend" || action === "unsuspend";

  const resolve = useApiMutation<Detail, ResolveValues, ResolveValues>({
    setError: form.setError,
    request: (v, ctx) =>
      api.POST("/admin/reports/{reportId}/resolve", {
        params: {
          path: { reportId: r.id },
          header: { "If-Match": r.version, "Idempotency-Key": ctx.idempotencyKey },
        },
        body: {
          action: v.action as Action,
          note: v.note.trim(),
          ...(v.member_message.trim() ? { member_message: v.member_message.trim() } : {}),
          ...(needsSubject && v.subject_user_id ? { subject_user_id: v.subject_user_id } : {}),
          // remove_message hanya bermakna untuk laporan pesan; selain itu selalu false (bawaan kontrak).
          remove_message: r.target_type === "message" ? v.remove_message : false,
          ...(v.action === "suspend" || v.action === "unsuspend" ? { confirm: true } : {}),
        },
      }),
    onSuccess: (data) => {
      setConfirming(false);
      queryClient.setQueryData(reportDetailKey(r.id), data);
      void queryClient.invalidateQueries({ queryKey: [...REPORTS_KEY, "list"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-dashboard"] });
      notify(
        "success",
        `Laporan diputus: ${ACTION_LABEL[data.resolution?.action ?? (form.getValues("action") as Action)]}.`,
      );
    },
    onReloadLatest: (error) => {
      setConfirming(false);
      onConflict(error);
    },
    onError: () => setConfirming(false),
  });

  const submit = form.handleSubmit((v) => {
    let ok = true;
    if (needsMessage && v.member_message.trim().length < 3) {
      form.setError(
        "member_message",
        { type: "manual", message: "Pesan untuk anggota minimal 3 karakter." },
        { shouldFocus: true },
      );
      ok = false;
    }
    if (needsSubject && !v.subject_user_id) {
      form.setError(
        "subject_user_id",
        { type: "manual", message: "Pilih anggota grup yang dikenai tindakan." },
        { shouldFocus: ok },
      );
      ok = false;
    }
    if (ok) setConfirming(true);
  });

  const errors = form.formState.errors;
  return (
    <Card aria-labelledby="laporan-putus" className="flex flex-col gap-4 pb-5">
      <CardHeader
        titleId="laporan-putus"
        title="Putuskan laporan"
        description="Satu keputusan per laporan. Alasan, aktor, waktu dan rujukan bukti tercatat di audit (AC F12-3)."
      />
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4 px-5">
        <FormError message={errors.root?.server?.message} />
        <RadioGroup<Action>
          legend="Tindakan"
          required
          value={action || null}
          onValueChange={(v) =>
            form.setValue("action", v, { shouldDirty: true, shouldValidate: form.formState.isSubmitted })
          }
          options={options}
          error={errors.action?.message}
        />
        {needsSubject ? (
          <FormField<ResolveValues, "subject_user_id">
            control={form.control}
            name="subject_user_id"
            label="Anggota grup yang dikenai tindakan"
            required
          >
            {(field, a11y) => (
              <Select
                {...a11y}
                value={field.value}
                onValueChange={field.onChange}
                placeholder="Pilih anggota"
                options={subjects.map(([id, name]) => ({ value: id, label: name }))}
              />
            )}
          </FormField>
        ) : null}
        <FormField<ResolveValues, "note">
          control={form.control}
          name="note"
          label="Catatan internal (alasan keputusan)"
          required
          hint="Hanya untuk pengurus dan audit."
        >
          {(field, a11y) => <Textarea {...field} {...a11y} rows={3} maxLength={1000} />}
        </FormField>
        <FormField<ResolveValues, "member_message">
          control={form.control}
          name="member_message"
          label={appeal ? "Pesan untuk pemohon" : "Pesan untuk anggota"}
          required={needsMessage}
          hint="Ditampilkan ke anggota yang dikenai keputusan, tanpa identitas pelapor."
        >
          {(field, a11y) => <Textarea {...field} {...a11y} rows={2} maxLength={500} />}
        </FormField>
        {r.target_type === "message" ? (
          <Checkbox
            label="Jadikan pesan terlapor placeholder (snapshot bukti tetap tersimpan)"
            checked={form.watch("remove_message")}
            onCheckedChange={(v) => form.setValue("remove_message", v)}
          />
        ) : null}
        <Button type="submit" variant={strong ? "danger" : "primary"} className="self-start">
          Putuskan laporan
        </Button>
      </form>
      <ConfirmDialog
        open={confirming}
        tone={strong ? "danger" : "primary"}
        onCancel={() => setConfirming(false)}
        onConfirm={() => resolve.mutate(form.getValues())}
        pending={resolve.isPending}
        title={action ? `${ACTION_LABEL[action]} laporan ini?` : "Putuskan laporan?"}
        description={action ? ACTION_CONSEQUENCE[action] : undefined}
        confirmLabel={action ? `Ya, ${ACTION_LABEL[action].toLowerCase()}` : "Putuskan"}
        acknowledgement="Saya sudah memeriksa bukti dan keputusan ini sesuai pedoman moderasi."
      >
        <blockquote className="rounded-md border-l-4 border-primary bg-green-50 px-3 py-2 text-sm text-text">
          {form.getValues("note")}
        </blockquote>
      </ConfirmDialog>
    </Card>
  );
}
