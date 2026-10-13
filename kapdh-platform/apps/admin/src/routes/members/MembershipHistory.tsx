import { ADMIN_MEMBERSHIP_EVENT_KIND_VALUES, type components } from "@kapdh/contracts";
import { keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Card, CardHeader } from "../../components/ui/Card";
import { useCursorPaging } from "../../components/ui/DataTable";
import { Timeline, type TimelineItem } from "../../components/ui/DataDisplay";
import { Field } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Input";
import { EmptyState, ErrorState, Loading } from "../../components/ui/States";
import { formatDate, formatDateTime } from "../../lib/format";
import { CursorPager, pageSummary } from "./CursorPager";
import { MEMBERSHIP_EVENT_LABEL, REASON_REDACTED_TEXT } from "./labels";
import { memberKeys } from "./queries";

type Event = components["schemas"]["AdminMembershipEvent"];
type Kind = components["schemas"]["AdminMembershipEventKind"];

export const HISTORY_PAGE_SIZE = 10;

const TONE: Record<Kind, TimelineItem["tone"]> = {
  activation: "success",
  renewal: "success",
  suspend: "danger",
  unsuspend: "info",
  number_correction: "warning",
  warn: "warning",
};

/** Ringkasan satu entri: aktor, perubahan nomor/periode, dan alasan (atau penanda alasan disembunyikan). */
export function eventDescription(e: Event): string {
  const parts: string[] = [e.actor ? `Pengurus: ${e.actor.display_name}` : "Sistem"];
  if (e.kind === "number_correction")
    parts.push(`Nomor ${e.before_member_number ?? "-"} → ${e.after_member_number ?? "-"}`);
  if ((e.kind === "activation" || e.kind === "renewal") && e.after_expires_at)
    parts.push(
      `Masa aktif ${formatDate(e.after_starts_at)} - ${formatDate(e.after_expires_at)}` +
        (e.before_expires_at ? ` (sebelumnya berakhir ${formatDate(e.before_expires_at)})` : ""),
    );
  if (e.reason_redacted) parts.push(REASON_REDACTED_TEXT);
  else if (e.reason) parts.push(`Alasan: ${e.reason}`);
  return parts.join(" | ");
}

/**
 * Histori keanggotaan dan moderasi (PRD 4.2, 6.3): aktivasi, perpanjangan, suspend, unsuspend, koreksi nomor dan
 * peringatan; terbaru lebih dulu, paging kursor server. Filter `warn` hanya untuk pemegang moderation.read (server
 * menolak 403 bagi yang lain; entri warn tidak dikirim kepada mereka).
 */
export function MembershipHistory({ userId }: { userId: string }) {
  const auth = useAuth();
  const canModeration = auth.can("moderation.read");
  const [kind, setKind] = useState<Kind | "all">("all");
  const paging = useCursorPaging(kind, HISTORY_PAGE_SIZE);
  const history = useApiQuery({
    queryKey: [...memberKeys.events(userId), { kind, cursor: paging.cursor }],
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/members/{userId}/membership-events", {
        params: {
          path: { userId },
          query: {
            ...(kind !== "all" ? { kind } : {}),
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
            limit: HISTORY_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });

  const options = [
    { value: "all", label: "Semua jenis" },
    ...ADMIN_MEMBERSHIP_EVENT_KIND_VALUES.filter((k) => k !== "warn" || canModeration).map((k) => ({
      value: k,
      label: MEMBERSHIP_EVENT_LABEL[k],
    })),
  ];
  const items = history.data?.items ?? [];
  const loadingPage = history.isFetching && history.isPlaceholderData;
  const timeline: TimelineItem[] = items.map((e) => ({
    id: e.id,
    title: MEMBERSHIP_EVENT_LABEL[e.kind] ?? e.kind,
    time: formatDateTime(e.created_at),
    description: eventDescription(e),
    tone: TONE[e.kind] ?? "neutral",
  }));

  return (
    <Card aria-labelledby="histori-keanggotaan" className="flex flex-col gap-4 pb-2">
      <CardHeader
        title="Histori keanggotaan dan moderasi"
        titleId="histori-keanggotaan"
        actions={
          <Field label="Jenis histori" labelHidden className="w-56">
            {(a11y) => (
              <Select
                {...a11y}
                size="sm"
                options={options}
                value={kind}
                onValueChange={(v) => setKind(v as Kind | "all")}
              />
            )}
          </Field>
        }
      />
      <div className="px-5">
        {history.status === "pending" ? (
          <Loading label="Memuat histori keanggotaan..." rows={4} className="p-0" />
        ) : history.status === "error" ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} compact />
        ) : items.length === 0 ? (
          <EmptyState
            compact
            title={paging.pageIndex > 0 ? "Halaman ini sudah kosong" : "Belum ada histori"}
            description={
              kind === "all"
                ? "Histori muncul setelah iuran disetujui atau ada tindakan pengurus."
                : "Tidak ada histori jenis ini."
            }
          />
        ) : (
          <Timeline
            label="Histori keanggotaan"
            items={timeline}
            className={loadingPage ? "opacity-60" : undefined}
          />
        )}
      </div>
      {history.status === "success" ? (
        <CursorPager
          className="border-t border-divider"
          summary={pageSummary({
            loading: loadingPage,
            pageIndex: paging.pageIndex,
            pageSize: HISTORY_PAGE_SIZE,
            shown: items.length,
            total: history.data?.total,
            noun: "entri",
          })}
          pageIndex={paging.pageIndex}
          nextCursor={history.data?.next_cursor}
          loading={loadingPage}
          onPrev={paging.prev}
          onNext={paging.next}
        />
      ) : null}
    </Card>
  );
}
