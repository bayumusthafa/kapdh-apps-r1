import type { AdminRole, components, EffectiveStatus } from "@kapdh/contracts";
import { membershipLabelFor } from "@kapdh/shared";
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Eye,
  FileClock,
  Hourglass,
  MailQuestionMark,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Badge berlabel teks + ikon; status tidak pernah dibedakan dengan warna saja (PRD 4.5, ARCHITECTURE §2.10).
 */
export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral" | "primary" | "gold";

const TONE: Record<BadgeTone, string> = {
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  info: "bg-info-bg text-info",
  neutral: "bg-neutral-bg text-neutral",
  primary: "bg-green-100 text-primary",
  gold: "bg-accent text-on-accent",
};

export function Badge({
  tone = "neutral",
  icon,
  children,
  className,
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-max max-w-full items-center gap-1 whitespace-nowrap rounded-pill px-2.5 py-1 text-xs font-semibold [&_svg]:size-3.5 [&_svg]:shrink-0",
        TONE[tone],
        className,
      )}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

interface StatusStyle {
  label: string;
  tone: BadgeTone;
  icon: ReactNode;
}

function StatusBadge<S extends string>({ status, map }: { status: S; map: Record<S, StatusStyle> }) {
  const s = map[status] ?? { label: status, tone: "neutral" as const, icon: <CircleDashed /> };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

type PaymentStatus = components["schemas"]["PaymentStatus"];

/** Status pembayaran (PRD 3.4, 4.3). */
export const PAYMENT_STATUS: Record<PaymentStatus, StatusStyle> = {
  pending: { label: "Menunggu", tone: "info", icon: <Clock /> },
  paid: { label: "Disetujui", tone: "success", icon: <CircleCheck /> },
  rejected: { label: "Ditolak", tone: "danger", icon: <CircleX /> },
  cancelled: { label: "Dibatalkan", tone: "neutral", icon: <Ban /> },
};

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <StatusBadge status={status} map={PAYMENT_STATUS} />;
}

/**
 * Status keanggotaan efektif (PRD 2.2) memakai kelas token `.badge-*` dari @kapdh/design-tokens dan label
 * katalog bersama (sama dengan aplikasi Flutter).
 */
const MEMBERSHIP_CLASS: Record<EffectiveStatus, { cls: string; icon: ReactNode }> = {
  verified: { cls: "badge-verified", icon: <ShieldCheck /> },
  expiring: { cls: "badge-expiring", icon: <Hourglass /> },
  expired: { cls: "badge-expired", icon: <CircleX /> },
  unverified: { cls: "badge-unverified", icon: <TriangleAlert /> },
  pending_otp: { cls: "badge-pending-review", icon: <MailQuestionMark /> },
  suspended: { cls: "badge-suspended", icon: <ShieldAlert /> },
  disabled: { cls: "badge-suspended", icon: <Ban /> },
  deletion_pending: { cls: "badge-suspended", icon: <FileClock /> },
};

export function MembershipStatusBadge({ status }: { status: EffectiveStatus }) {
  const s = MEMBERSHIP_CLASS[status] ?? { cls: "badge-suspended", icon: <CircleDashed /> };
  return (
    <span
      className={cn(
        "inline-flex w-max items-center gap-1 whitespace-nowrap rounded-pill px-2.5 py-1 text-xs font-semibold [&_svg]:size-3.5",
        s.cls,
      )}
    >
      <span aria-hidden="true">{s.icon}</span>
      {membershipLabelFor(status)}
    </span>
  );
}

/** Status event (PRD 3.9, 4.4). Nilai mengikuti enum app.event_status. */
export type EventStatus = "draft" | "open" | "closed" | "done" | "cancelled";
export const EVENT_STATUS: Record<EventStatus, StatusStyle> = {
  draft: { label: "Draf", tone: "neutral", icon: <CircleDashed /> },
  open: { label: "Pendaftaran dibuka", tone: "success", icon: <CircleCheck /> },
  closed: { label: "Pendaftaran ditutup", tone: "warning", icon: <Clock /> },
  done: { label: "Selesai", tone: "info", icon: <CircleCheck /> },
  cancelled: { label: "Dibatalkan", tone: "danger", icon: <Ban /> },
};
export function EventStatusBadge({ status }: { status: EventStatus }) {
  return <StatusBadge status={status} map={EVENT_STATUS} />;
}

/** Status tiket (PRD 4.4). Nilai mengikuti enum app.ticket_status. */
export type TicketStatus = "awaiting_payment" | "awaiting_review" | "paid" | "expired" | "cancelled";
export const TICKET_STATUS: Record<TicketStatus, StatusStyle> = {
  awaiting_payment: { label: "Menunggu pembayaran", tone: "warning", icon: <Hourglass /> },
  awaiting_review: { label: "Menunggu verifikasi", tone: "info", icon: <Eye /> },
  paid: { label: "Lunas", tone: "success", icon: <CircleCheck /> },
  expired: { label: "Kedaluwarsa", tone: "neutral", icon: <Clock /> },
  cancelled: { label: "Dibatalkan", tone: "danger", icon: <Ban /> },
};
export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <StatusBadge status={status} map={TICKET_STATUS} />;
}

/** Status laporan moderasi (PRD 3.12). Nilai mengikuti enum app.report_status. */
export type ReportStatus = "open" | "in_review" | "resolved" | "dismissed";
export const REPORT_STATUS: Record<ReportStatus, StatusStyle> = {
  open: { label: "Terbuka", tone: "warning", icon: <TriangleAlert /> },
  in_review: { label: "Ditinjau", tone: "info", icon: <Eye /> },
  resolved: { label: "Selesai", tone: "success", icon: <CircleCheck /> },
  dismissed: { label: "Diabaikan", tone: "neutral", icon: <Ban /> },
};
export function ReportStatusBadge({ status }: { status: ReportStatus }) {
  return <StatusBadge status={status} map={REPORT_STATUS} />;
}

/** Status akun admin (F-16). Nilai mengikuti enum app.admin_status. */
export type AdminStatus = "invited" | "active" | "disabled";
export const ADMIN_STATUS: Record<AdminStatus, StatusStyle> = {
  invited: { label: "Diundang", tone: "info", icon: <MailQuestionMark /> },
  active: { label: "Aktif", tone: "success", icon: <CircleCheck /> },
  disabled: { label: "Nonaktif", tone: "neutral", icon: <Ban /> },
};
export function AdminStatusBadge({ status }: { status: AdminStatus }) {
  return <StatusBadge status={status} map={ADMIN_STATUS} />;
}

const ROLE_LABEL: Record<AdminRole, string> = { super_admin: "Super Admin", admin: "Admin" };
export function AdminRoleBadge({ role }: { role: AdminRole }) {
  return (
    <Badge tone={role === "super_admin" ? "primary" : "info"} icon={<ShieldCheck />}>
      {ROLE_LABEL[role]}
    </Badge>
  );
}
