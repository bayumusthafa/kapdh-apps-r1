import type { components } from "@kapdh/contracts";
import { Siren } from "lucide-react";
import { Badge } from "../../components/ui/Badge";

type Category = components["schemas"]["ModerationReportCategory"];
type Target = components["schemas"]["ModerationTargetType"];
type Action = components["schemas"]["ModerationAction"];
type HistoryKind = components["schemas"]["ModerationHistoryKind"];

export const REPORTS_KEY = ["admin-reports"] as const;
export const reportDetailKey = (reportId: string) => [...REPORTS_KEY, "detail", reportId] as const;

/** Label kategori laporan (kontrak ModerationReportCategory, PRD 3.12). */
export const CATEGORY_LABEL: Record<Category, string> = {
  spam: "Spam",
  harassment: "Pelecehan",
  hate: "Ujaran kebencian",
  sexual: "Konten seksual",
  violence_threat: "Ancaman/keselamatan",
  scam: "Penipuan",
  other: "Lainnya",
  appeal: "Banding",
};

export const TARGET_LABEL: Record<Target, string> = { user: "Pengguna", message: "Pesan", room: "Grup" };

export const ACTION_LABEL: Record<Action, string> = {
  dismiss: "Abaikan",
  warn: "Peringatkan",
  suspend: "Suspend",
  unsuspend: "Cabut suspend",
};

export const HISTORY_LABEL: Record<HistoryKind, string> = {
  warn: "Peringatan",
  suspend: "Suspend",
  unsuspend: "Suspend dicabut",
};

/**
 * Prioritas laporan: mendesak = ancaman/keselamatan atau konten seksual, target 24 jam (v3.2, keputusan PP K5);
 * teks selalu tertulis.
 */
export function PriorityBadge({ priority }: { priority: components["schemas"]["ModerationReportPriority"] }) {
  return priority === "urgent" ? (
    <Badge tone="danger" icon={<Siren />}>
      Mendesak
    </Badge>
  ) : (
    <Badge tone="neutral">Normal</Badge>
  );
}
