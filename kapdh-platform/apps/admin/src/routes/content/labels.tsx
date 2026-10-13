import {
  Archive,
  CalendarClock,
  CircleCheck,
  CircleDashed,
  Clock,
  EyeOff,
  FilePen,
  Link2Off,
  type LucideIcon,
} from "lucide-react";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import type { AdminPostState, BannerTargetType, S } from "./contentApi";

/** Label + ikon + warna; status tidak pernah dibedakan dengan warna saja (PRD 4.5, ARCHITECTURE §2.10). */
interface StateStyle {
  label: string;
  tone: BadgeTone;
  icon: LucideIcon;
}

/** Keadaan berita turunan server (AdminPostState, AC F08-1, F15-5). */
export const POST_STATE: Record<AdminPostState, StateStyle> = {
  draft: { label: "Draf", tone: "neutral", icon: FilePen },
  scheduled: { label: "Terjadwal", tone: "info", icon: CalendarClock },
  published: { label: "Terbit", tone: "success", icon: CircleCheck },
  archived: { label: "Diarsipkan", tone: "warning", icon: Archive },
};

export function PostStateBadge({ state }: { state: AdminPostState }) {
  const s = POST_STATE[state] ?? { label: state, tone: "neutral" as const, icon: CircleDashed };
  const Icon = s.icon;
  return (
    <Badge tone={s.tone} icon={<Icon />}>
      {s.label}
    </Badge>
  );
}

/** Keadaan tayang banner turunan server (AdminBannerState, AC F08-2). */
export const BANNER_STATE: Record<S["AdminBannerState"], StateStyle> = {
  inactive: { label: "Nonaktif", tone: "neutral", icon: EyeOff },
  scheduled: { label: "Terjadwal", tone: "info", icon: CalendarClock },
  live: { label: "Tayang", tone: "success", icon: CircleCheck },
  ended: { label: "Berakhir", tone: "neutral", icon: Clock },
};

export function BannerStateBadge({ state }: { state: S["AdminBannerState"] }) {
  const s = BANNER_STATE[state] ?? { label: state, tone: "neutral" as const, icon: CircleDashed };
  const Icon = s.icon;
  return (
    <Badge tone={s.tone} icon={<Icon />}>
      {s.label}
    </Badge>
  );
}

/** Penanda tujuan banner yang tidak lagi dapat dibuka anggota (AC F08-2). */
export function TargetUnavailableBadge() {
  return (
    <Badge tone="warning" icon={<Link2Off />}>
      Tujuan tidak tersedia
    </Badge>
  );
}

export const BANNER_TARGET_LABEL: Record<BannerTargetType, string> = {
  none: "Tanpa tujuan",
  post: "Berita",
  event: "Event",
  page: "Halaman",
  url: "Tautan luar",
};

export const LEGAL_DOCUMENT_LABEL: Record<S["PageLegalDocument"], string> = {
  privacy: "Kebijakan privasi",
  terms: "Ketentuan layanan",
  community: "Ketentuan komunitas",
};
