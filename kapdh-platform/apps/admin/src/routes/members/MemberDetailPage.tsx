import type { components } from "@kapdh/contracts";
import { membershipLabelFor } from "@kapdh/shared";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ExternalLink, KeyRound, Pencil, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/session";
import {
  AdminRoleBadge,
  AdminStatusBadge,
  Badge,
  MembershipStatusBadge,
  PaymentStatusBadge,
  TicketStatusBadge,
} from "../../components/ui/Badge";
import { Button, buttonClass } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Avatar, KeyValueList } from "../../components/ui/DataDisplay";
import { type Breadcrumb, PageHeader } from "../../components/ui/PageHeader";
import { ErrorState, ForbiddenState, Loading, NotFoundState } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { formatDate, formatDateTime, formatRupiah } from "../../lib/format";
import { PAYMENT_TYPE_LABEL } from "../../lib/labels";
import { canRecordDuesFor, RECORD_PERMISSIONS } from "../payments/recordEligibility";
import {
  ACCOUNT_STATUS_LABEL,
  classLabel,
  EDUCATION_STATUS_LABEL,
  educationMeta,
  GENDER_LABEL,
  PERIOD_KIND_LABEL,
  REASON_REDACTED_TEXT,
  SOCIAL_PLATFORM_BASE,
  SOCIAL_PLATFORM_LABEL,
} from "./labels";
import { lastMembersSearch } from "./listMemory";
import { PasswordResetDialog, SuspendDialog, UnsuspendDialog } from "./MemberActionDialogs";
import { MemberEditDialog } from "./MemberEditDialog";
import { MembershipHistory } from "./MembershipHistory";
import { type MemberDetail, professionEntries, useMemberDetail } from "./queries";
import { RefreshFailedBanner } from "./RefreshFailedBanner";

type S = components["schemas"];

/** Pesan hasil tindakan di region live halaman detail (PRD 4.5: hasil dan perubahan oleh pihak lain diumumkan). */
export interface MemberNotice {
  tone: "success" | "warning";
  message: string;
  /** Koreksi nomor anggota dari respons server (AC F05-6): nomor lama → nomor baru. */
  numberChange?: { before: string | null; after: string | null };
}

type ActionDialog = "edit" | "suspend" | "unsuspend" | "reset" | null;

/** Breadcrumb kembali ke daftar dengan pencarian/filter terakhir yang dipakai (F-15, guideline hal. 16). */
function breadcrumbs(): Breadcrumb[] {
  return [
    { label: "Manajemen Users", to: "/members", search: { ...lastMembersSearch() } },
    { label: "Informasi Pengguna" },
  ];
}

/**
 * Informasi Pengguna (F-15, guideline hal. 16): profil, kontak administratif terlepas dari flag privasi (F-10),
 * keanggotaan dan periode, ringkasan pembayaran/tiket/moderasi sesuai izin (PRD 2.3), histori keanggotaan dan
 * moderasi, serta tindakan teraudit: ubah data/koreksi identitas (AC F05-6, F15-4), batasi/cabut pembatasan
 * (PRD 4.2, AC F12-3..F12-5) dan pemulihan sandi oleh Super Admin (AC F16-4).
 */
export function MemberDetailPage() {
  const auth = useAuth();
  if (!auth.can("members.read"))
    return (
      <>
        <PageHeader title="Informasi Pengguna" breadcrumbs={breadcrumbs()} />
        <Card>
          <ForbiddenState description="Detail anggota memerlukan izin melihat data anggota (members.read)." />
        </Card>
      </>
    );
  return <MemberDetailView />;
}

function MemberDetailView() {
  const auth = useAuth();
  const { userId } = useParams({ from: "/app/members/$userId" });
  const search = useSearch({ from: "/app/members/$userId" });
  const navigate = useNavigate({ from: "/members/$userId" });
  const detail = useMemberDetail(userId);
  const [dialog, setDialog] = useState<ActionDialog>(null);
  const [notice, setNotice] = useState<(MemberNotice & { seq: number }) | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  const m = detail.data;
  const selfLinked = Boolean(m?.linked_admin && m.linked_admin.admin_id === auth.profile?.admin_id);
  const closed = m ? m.account_status === "deletion_pending" || m.account_status === "deleted" : false;
  const canEdit = auth.can("members.read") && auth.can("members.manage") && !selfLinked && !closed;
  const canModerate =
    auth.can("members.read") && auth.can("moderation.read") && auth.can("moderation.resolve") && !selfLinked;
  const canSuspend = canModerate && m !== undefined && m.suspension === null && !closed;
  const canUnsuspend = canModerate && m !== undefined && m.suspension !== null;
  // Pemulihan sandi hanya Super Admin (x-kapdh-access role super_admin) untuk akun aktif (AC F16-4).
  const isSuperAdmin = auth.profile?.role === "super_admin";
  const canReset = isSuperAdmin && !selfLinked && m?.account_status === "active";

  function announce(next: MemberNotice) {
    setNotice((n) => ({ ...next, seq: (n?.seq ?? 0) + 1 }));
  }

  // Ikon ubah pada kartu daftar membuka formulir langsung (?edit=1); parameter dihapus agar muat ulang tidak
  // membuka formulir lagi. Bila formulir tidak boleh dibuka, alasannya diumumkan (PRD 2.3, F-14, PRD 4.5).
  const editRequested = search.edit === true;
  const editBlockedReason = !auth.can("members.manage")
    ? "Formulir ubah data tidak dibuka: Anda tidak memiliki izin mengubah data anggota (members.manage)."
    : selfLinked
      ? "Formulir ubah data tidak dibuka: akun alumni ini tertaut ke akun admin Anda, sehingga perubahannya harus dilakukan pengurus lain (konflik kepentingan, PRD 2.3)."
      : closed
        ? "Formulir ubah data tidak dibuka: akun ini sedang dalam proses penghapusan atas permintaan anggota (F-14)."
        : null;
  useEffect(() => {
    if (!editRequested || !m) return;
    if (canEdit) setDialog("edit");
    else if (editBlockedReason)
      setNotice((n) => ({ tone: "warning", message: editBlockedReason, seq: (n?.seq ?? 0) + 1 }));
    void navigate({ search: {}, replace: true });
  }, [editRequested, m, canEdit, editBlockedReason, navigate]);

  // Setelah tindakan selesai, tombol pemicu dapat hilang (mis. Batasi → Cabut pembatasan): fokus dipindah ke
  // pesan hasil agar pengguna keyboard/pembaca layar tidak kehilangan posisi (N-11).
  const noticeSeq = notice?.seq ?? 0;
  useEffect(() => {
    if (noticeSeq > 0 && dialog === null) noticeRef.current?.focus();
  }, [noticeSeq, dialog]);

  if (detail.isPending)
    return (
      <>
        <PageHeader title="Informasi Pengguna" breadcrumbs={breadcrumbs()} />
        <Card>
          <Loading label="Memuat detail anggota..." rows={8} />
        </Card>
      </>
    );
  // Galat satu halaman penuh hanya bila belum ada data; refetch latar yang gagal tidak membuang halaman maupun
  // formulir yang sedang diisi (PRD 4.5).
  if (detail.data === undefined)
    return (
      <>
        <PageHeader title="Informasi Pengguna" breadcrumbs={breadcrumbs()} />
        <Card>
          {detail.error?.code === "NOT_FOUND" ? (
            <NotFoundState
              description="Anggota tidak ditemukan atau akunnya sudah dihapus."
              action={
                <Link
                  to="/members"
                  search={lastMembersSearch()}
                  className={buttonClass({ variant: "outline", size: "sm" })}
                >
                  Kembali ke daftar alumni
                </Link>
              }
            />
          ) : (
            <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
          )}
        </Card>
      </>
    );

  const member = detail.data;
  return (
    <>
      <PageHeader
        title={member.full_name}
        description={[member.member_number ?? "Belum bernomor", member.cohort_code].join(" | ")}
        breadcrumbs={breadcrumbs()}
        actions={
          <>
            {canEdit ? (
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Pencil aria-hidden="true" className="size-4" />}
                onClick={() => setDialog("edit")}
              >
                Ubah data
              </Button>
            ) : null}
            {canSuspend ? (
              <Button
                variant="danger"
                size="sm"
                leftIcon={<ShieldAlert aria-hidden="true" className="size-4" />}
                onClick={() => setDialog("suspend")}
              >
                Batasi akun
              </Button>
            ) : null}
            {canUnsuspend ? (
              <Button
                variant="outline"
                size="sm"
                leftIcon={<ShieldCheck aria-hidden="true" className="size-4" />}
                onClick={() => setDialog("unsuspend")}
              >
                Cabut pembatasan
              </Button>
            ) : null}
            {canReset ? (
              <Button
                variant="outline"
                size="sm"
                leftIcon={<KeyRound aria-hidden="true" className="size-4" />}
                onClick={() => setDialog("reset")}
              >
                Reset sandi
              </Button>
            ) : null}
          </>
        }
      />

      {/* Region live selalu ada (awalnya kosong) agar hasil tindakan pasti diumumkan. */}
      <div
        ref={noticeRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={
          notice
            ? cn(
                "flex flex-col gap-1 rounded-md p-3 text-sm font-medium outline-none",
                notice.tone === "success" ? "bg-success-bg text-success" : "bg-warning-bg text-warning",
              )
            : undefined
        }
      >
        {notice ? (
          <>
            <span>{notice.message}</span>
            {notice.numberChange ? (
              <span className="text-text">
                Nomor anggota:{" "}
                <span className="font-mono">{notice.numberChange.before ?? "Belum bernomor"}</span> →{" "}
                <span className="font-mono font-semibold">
                  {notice.numberChange.after ?? "Belum bernomor"}
                </span>{" "}
                (nomor urut tetap). QR lama perlu diperbarui; anggota cukup membuka KTA di aplikasi untuk
                memuat QR baru.
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      {detail.isError ? (
        <RefreshFailedBanner
          error={detail.error}
          subject="Data anggota"
          retrying={detail.isFetching}
          onRetry={() => void detail.refetch()}
        />
      ) : null}

      {selfLinked ? (
        <p role="note" className="rounded-md bg-warning-bg p-3 text-sm text-warning">
          Akun alumni ini tertaut ke akun admin Anda. Perubahan data, pembatasan dan pemulihan sandi untuk
          akun ini harus dilakukan pengurus lain (konflik kepentingan, PRD 2.3).
        </p>
      ) : null}
      {closed ? (
        <p role="note" className="rounded-md bg-neutral-bg p-3 text-sm text-text">
          Akun ini sedang dalam proses penghapusan atas permintaan anggota (F-14) sehingga tidak dapat diubah
          atau dibatasi.
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[3_1_520px] flex-col gap-5">
          <ProfileCard member={member} />
          <ContactCard member={member} />
          <MembershipCard member={member} />
          <MembershipHistory userId={member.user_id} />
        </div>
        <div className="flex min-w-0 flex-[2_1_320px] flex-col gap-5">
          {member.suspension ? <SuspensionCard suspension={member.suspension} /> : null}
          {member.linked_admin ? <LinkedAdminCard linked={member.linked_admin} self={selfLinked} /> : null}
          <PaymentsCard member={member} />
          <TicketsCard tickets={member.recent_tickets} />
          <ModerationCard moderation={member.moderation} />
        </div>
      </div>

      {dialog === "edit" ? (
        <MemberEditDialog member={member} onClose={() => setDialog(null)} onDone={announce} />
      ) : null}
      <SuspendDialog
        member={member}
        open={dialog === "suspend"}
        onClose={() => setDialog(null)}
        onDone={announce}
      />
      <UnsuspendDialog
        member={member}
        open={dialog === "unsuspend"}
        onClose={() => setDialog(null)}
        onDone={announce}
      />
      <PasswordResetDialog
        member={member}
        open={dialog === "reset"}
        onClose={() => setDialog(null)}
        onDone={announce}
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */

function Section({
  title,
  description,
  titleId,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  titleId: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card aria-labelledby={titleId} className="flex flex-col gap-4 pb-5">
      <CardHeader title={title} titleId={titleId} description={description} actions={actions} />
      <div className="flex flex-col gap-4 px-5">{children}</div>
    </Card>
  );
}

/**
 * Profesi sesuai urutan anggota (pertama = profesi utama di KTA). Setiap profesi bertaut master nonaktif tetap tampil
 * sebagai label historis dengan penanda per entri (AC F10-4, `profession_entries`).
 */
function ProfessionList({ member: m }: { member: MemberDetail }) {
  const entries = professionEntries(m);
  if (entries.length === 0) return "-";
  return (
    <ul aria-label="Profesi" className="flex flex-wrap gap-1.5">
      {entries.map(({ label, master }, i) => (
        <li key={`${i}-${label}`} className="inline-flex flex-wrap items-center gap-1.5">
          <Badge tone={i === 0 ? "primary" : "neutral"}>
            {i === 0 && entries.length > 1 ? `${label} (utama)` : label}
          </Badge>
          {master?.active === false ? <Badge tone="neutral">Master nonaktif</Badge> : null}
        </li>
      ))}
    </ul>
  );
}

/** Riwayat pendidikan setelah pondok, terbaru di atas (urutan server). */
function EducationList({ entries }: { entries: S["EducationEntry"][] }) {
  if (entries.length === 0) return "-";
  return (
    <ol aria-label="Riwayat pendidikan" className="flex flex-col gap-2">
      {entries.map((e, i) => {
        const meta = educationMeta(e);
        return (
          <li key={`${i}-${e.institution}`} className="flex flex-col">
            <span>{e.institution}</span>
            {meta ? <span className="text-xs font-normal text-text-muted">{meta}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function ProfileCard({ member: m }: { member: MemberDetail }) {
  return (
    <Section title="Profil alumni" titleId="profil-alumni">
      <div className="flex items-center gap-3">
        <Avatar name={m.full_name} src={m.avatar_url} size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-semibold">{m.full_name}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <MembershipStatusBadge status={m.effective_status} />
            {m.has_linked_admin ? (
              <Badge tone="primary" icon={<ShieldCheck />}>
                Admin
              </Badge>
            ) : null}
          </span>
        </div>
      </div>
      <KeyValueList
        items={[
          {
            label: "Nomor anggota",
            value: <span className="font-mono">{m.member_number ?? "Belum bernomor"}</span>,
          },
          { label: "Kode angkatan", value: `${m.cohort_code} (angkatan ${m.cohort})` },
          { label: "Jenis kelamin", value: GENDER_LABEL[m.gender] },
          { label: "Status pendidikan", value: EDUCATION_STATUS_LABEL[m.education_status] },
          { label: "Kelas masuk", value: classLabel(m.class_in) },
          { label: "Kelas keluar", value: classLabel(m.class_out) },
          {
            label: "Tahun masuk - keluar",
            value: `${m.entry_year} - ${m.exit_year} (lulus angkatan ${m.graduation_year})`,
          },
          { label: "Kota domisili", value: m.city ?? "-" },
          { label: "Profesi", wide: true, value: <ProfessionList member={m} /> },
          { label: "Riwayat pendidikan", wide: true, value: <EducationList entries={m.education} /> },
          {
            label: "Keahlian",
            wide: true,
            value:
              m.skills.length === 0 ? (
                "-"
              ) : (
                <ul aria-label="Keahlian" className="flex flex-wrap gap-1.5">
                  {m.skills.map((s) => (
                    <li key={s.id}>
                      <Badge tone={s.active === false ? "neutral" : "primary"}>
                        {s.active === false ? `${s.label} (master nonaktif)` : s.label}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ),
          },
          { label: "Bio", wide: true, value: m.bio ?? "-" },
        ]}
      />
    </Section>
  );
}

/**
 * Tautan sosial aman (aturan SocialHandle): nama pengguna menjadi tautan ke domain platform, URL hanya bila
 * https. Nilai lain ditampilkan sebagai teks biasa (N-14).
 */
export function socialHref(base: string | null, value: string): string | null {
  if (value.startsWith("https://")) {
    try {
      return new URL(value).protocol === "https:" ? value : null;
    } catch {
      return null;
    }
  }
  return base !== null && /^@?[A-Za-z0-9._-]{1,100}$/.test(value)
    ? `${base}${encodeURIComponent(value.replace(/^@/, ""))}`
    : null;
}

function Visibility({ shown }: { shown: boolean }) {
  return (
    <span className="block text-xs font-normal text-text-muted">
      {shown ? "Ditampilkan ke anggota lain" : "Disembunyikan dari anggota lain"}
    </span>
  );
}

function ContactCard({ member: m }: { member: MemberDetail }) {
  return (
    <Section
      title="Kontak (administratif)"
      titleId="kontak-anggota"
      description="Kontak ditampilkan untuk keperluan administratif pengurus yang tercatat, terlepas dari pengaturan privasi anggota (F-10)."
    >
      <p role="note" className="rounded-md bg-info-bg p-3 text-xs text-info">
        Pembukaan detail ini tercatat di audit. Gunakan kontak hanya untuk urusan kepengurusan dan jangan
        membagikannya ke pihak lain.
      </p>
      <KeyValueList
        items={[
          {
            label: "Email",
            value: (
              <>
                <a href={`mailto:${m.email}`} className="text-primary underline-offset-2 hover:underline">
                  {m.email}
                </a>
                <Visibility shown={m.privacy.show_email} />
              </>
            ),
          },
          {
            label: "Telepon",
            value: (
              <>
                {m.phone ?? "-"}
                <Visibility shown={m.privacy.show_phone} />
              </>
            ),
          },
          ...(m.social_links.length === 0
            ? [{ label: "Media sosial", value: "-" }]
            : m.social_links.map((link) => {
                const label = SOCIAL_PLATFORM_LABEL[link.platform];
                const href = socialHref(SOCIAL_PLATFORM_BASE[link.platform], link.value);
                return {
                  label,
                  value: (
                    <>
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${label} ${link.value} (tab baru)`}
                          className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                        >
                          {link.value}
                          <ExternalLink aria-hidden="true" className="size-3.5" />
                        </a>
                      ) : (
                        link.value
                      )}
                      <Visibility shown={m.privacy.show_social} />
                    </>
                  ),
                };
              })),
          {
            label: "Direktori alumni",
            value: m.privacy.show_in_directory ? "Tampil di direktori" : "Tidak tampil di direktori",
          },
        ]}
      />
    </Section>
  );
}

function MembershipCard({ member: m }: { member: MemberDetail }) {
  return (
    <Section title="Keanggotaan" titleId="keanggotaan-anggota">
      <KeyValueList
        items={[
          { label: "Status keanggotaan", value: <MembershipStatusBadge status={m.effective_status} /> },
          { label: "Status akun", value: ACCOUNT_STATUS_LABEL[m.account_status] ?? m.account_status },
          { label: "Mulai berlaku", value: formatDateTime(m.starts_at) },
          { label: "Berlaku sampai", value: formatDateTime(m.expires_at) },
          { label: "Perpanjangan dibuka", value: formatDateTime(m.renewal_opens_at) },
          { label: "KTA dibuat (email terverifikasi)", value: formatDateTime(m.email_verified_at) },
          { label: "Terdaftar", value: formatDateTime(m.registered_at) },
          { label: "Login terakhir", value: formatDateTime(m.last_login_at) },
        ]}
      />
      {m.suspension ? (
        <p className="text-xs text-text-muted">
          Tanggal masa aktif tidak berubah selama pembatasan; status dihitung ulang saat pembatasan dicabut
          (PRD 4.2).
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Periode keanggotaan</h3>
        {m.periods.length === 0 ? (
          <p className="text-sm text-text-muted">
            Belum ada periode: iuran pendaftaran belum disetujui ({membershipLabelFor(m.effective_status)}).
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-divider">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <caption className="sr-only">Periode keanggotaan</caption>
              <thead>
                <tr className="bg-green-50 text-left text-xs font-semibold uppercase tracking-wide text-neutral-700">
                  <th scope="col" className="px-3 py-2">
                    Jenis
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Mulai
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Berakhir
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Disetujui
                  </th>
                </tr>
              </thead>
              <tbody>
                {m.periods.map((p) => (
                  <tr key={`${p.kind}-${p.starts_at}`} className="border-t border-divider">
                    <th scope="row" className="px-3 py-2 text-left font-medium">
                      {PERIOD_KIND_LABEL[p.kind] ?? p.kind}
                    </th>
                    <td className="px-3 py-2">{formatDate(p.starts_at)}</td>
                    <td className="px-3 py-2">{formatDate(p.expires_at)}</td>
                    <td className="px-3 py-2">{formatDateTime(p.approved_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}

function SuspensionCard({ suspension }: { suspension: S["AdminMemberSuspension"] }) {
  return (
    <Card aria-labelledby="pembatasan-anggota" className="flex flex-col gap-3 border-danger/40 p-5">
      <h2
        id="pembatasan-anggota"
        className="flex items-center gap-2 font-heading text-h3 font-semibold text-danger"
      >
        <ShieldOff aria-hidden="true" className="size-5" />
        Akun dibatasi
      </h2>
      <KeyValueList
        className="sm:grid-cols-1"
        items={[
          { label: "Sejak", value: formatDateTime(suspension.suspended_at) },
          {
            label: "Oleh",
            value: suspension.suspended_by?.display_name ?? "Sistem atau admin yang sudah dihapus",
          },
          { label: "Pesan untuk anggota", value: suspension.member_message ?? "-" },
          {
            label: "Alasan internal",
            value: suspension.reason_redacted ? (
              <span className="text-text-muted">{REASON_REDACTED_TEXT}</span>
            ) : (
              (suspension.reason ?? "Tidak tercatat")
            ),
          },
        ]}
      />
    </Card>
  );
}

function LinkedAdminCard({ linked, self }: { linked: S["AdminMemberLinkedAdmin"]; self: boolean }) {
  return (
    <Section
      title="Akun admin tertaut"
      titleId="admin-tertaut"
      description="Identitas admin terpisah yang tertaut ke akun alumni ini untuk pemeriksaan konflik kepentingan (F-16)."
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{linked.display_name}</span>
        <AdminRoleBadge role={linked.role} />
        <AdminStatusBadge status={linked.status} />
        {self ? <Badge tone="warning">Akun Anda</Badge> : null}
      </div>
    </Section>
  );
}

function PermissionNote({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="rounded-md bg-neutral-bg p-3 text-sm text-text-muted">
      {children}
    </p>
  );
}

/**
 * Pembayaran terbaru anggota. Setiap baris menaut ke payment itu di Verifikasi Pembayaran (`?payment=`), sehingga
 * panel keputusan langsung membuka payment yang dimaksud apa pun statusnya (F-04, PRD 4.5); "Semua pembayaran"
 * membuka daftar yang dibatasi ke anggota ini (`?user=`), termasuk payment di luar ringkasan terbaru. "Catat iuran"
 * membuka pencatatan iuran di luar aplikasi (rencana cadangan D13, adminRecordPayment) dengan alumni ini sudah
 * terpilih, hanya bila iurannya dapat dicatat sekarang.
 */
function PaymentsCard({ member }: { member: MemberDetail }) {
  const auth = useAuth();
  const payments = member.recent_payments;
  const canOpen = payments !== null && auth.can("payments.read");
  const canRecord =
    payments !== null &&
    RECORD_PERMISSIONS.every((p) => auth.can(p)) &&
    canRecordDuesFor(member, auth.profile?.admin_id);
  return (
    <Section
      title="Pembayaran terbaru"
      titleId="pembayaran-anggota"
      actions={
        canOpen ? (
          <>
            {canRecord ? (
              <Link
                to="/payments"
                search={{ tab: "verify", record: member.user_id }}
                className={buttonClass({ variant: "outline", size: "sm" })}
              >
                Catat iuran
              </Link>
            ) : null}
            {/* Seluruh payment anggota ini (filter user_id adminListPayments, semua status), bukan antrean bawaan. */}
            <Link
              to="/payments"
              search={{ tab: "verify", user: member.user_id }}
              className={buttonClass({ variant: "ghost", size: "sm" })}
            >
              Semua pembayaran
            </Link>
          </>
        ) : null
      }
    >
      {payments === null ? (
        <PermissionNote>
          Ringkasan pembayaran hanya untuk admin dengan izin melihat pembayaran (payments.read).
        </PermissionNote>
      ) : payments.length === 0 ? (
        <p className="text-sm text-text-muted">Belum ada pembayaran.</p>
      ) : (
        <ul aria-label="Pembayaran terbaru" className="flex flex-col divide-y divide-divider">
          {payments.map((p) => {
            const title = `${PAYMENT_TYPE_LABEL[p.type]} ${formatRupiah(p.amount)}`;
            return (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="flex min-w-0 flex-col">
                  {canOpen ? (
                    <Link
                      to="/payments"
                      search={{ tab: "verify", payment: p.id }}
                      aria-label={`${title}, dibuat ${formatDateTime(p.created_at)}`}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {title}
                    </Link>
                  ) : (
                    <span className="font-medium">{title}</span>
                  )}
                  <span className="text-xs text-text-muted">
                    Dibuat {formatDateTime(p.created_at)}
                    {p.decided_at ? ` | Diputus ${formatDateTime(p.decided_at)}` : ""}
                  </span>
                </span>
                <PaymentStatusBadge status={p.status} />
              </li>
            );
          })}
        </ul>
      )}
      {payments !== null ? (
        <p className="text-xs text-text-muted">
          {canOpen
            ? "Pilih pembayaran untuk membuka bukti transfer dan histori di menu Verifikasi Pembayaran."
            : "Bukti transfer hanya dapat dibuka di menu Verifikasi Pembayaran."}
        </p>
      ) : null}
    </Section>
  );
}

function TicketsCard({ tickets }: { tickets: S["AdminMemberTicketSummary"][] | null }) {
  return (
    <Section title="Tiket event terbaru" titleId="tiket-anggota">
      {tickets === null ? (
        <PermissionNote>
          Ringkasan tiket hanya untuk pengelola event (events.manage) atau pembaca pembayaran (payments.read).
        </PermissionNote>
      ) : tickets.length === 0 ? (
        <p className="text-sm text-text-muted">Belum ada tiket.</p>
      ) : (
        <ul aria-label="Tiket event terbaru" className="flex flex-col divide-y divide-divider">
          {tickets.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{t.event_title}</span>
                <span className="text-xs text-text-muted">
                  {formatDateTime(t.event_starts_at)} | {formatRupiah(t.total)}
                  {t.checked_in_at ? ` | Check-in ${formatDateTime(t.checked_in_at)}` : ""}
                </span>
              </span>
              <TicketStatusBadge status={t.status} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ModerationCard({ moderation }: { moderation: S["AdminMemberModerationSummary"] | null }) {
  const auth = useAuth();
  return (
    <Section
      title="Moderasi"
      titleId="moderasi-anggota"
      actions={
        moderation && auth.canAny(["moderation.read", "moderation.resolve"]) ? (
          <Link to="/moderation" className={buttonClass({ variant: "ghost", size: "sm" })}>
            Laporan Moderasi
          </Link>
        ) : null
      }
    >
      {moderation === null ? (
        <PermissionNote>
          Ringkasan moderasi hanya untuk admin dengan izin membaca laporan (moderation.read).
        </PermissionNote>
      ) : (
        <KeyValueList
          items={[
            { label: "Laporan aktif", value: String(moderation.open_report_count) },
            { label: "Total laporan", value: String(moderation.total_report_count) },
            { label: "Peringatan", value: String(moderation.warning_count) },
            { label: "Tindakan terakhir", value: formatDateTime(moderation.last_action_at) },
          ]}
        />
      )}
    </Section>
  );
}
