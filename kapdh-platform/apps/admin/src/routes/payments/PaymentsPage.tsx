import type { Permission } from "@kapdh/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth } from "../../auth/session";
import { PageHeader } from "../../components/ui/PageHeader";
import { PermissionGate } from "../../components/ui/PermissionGate";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import { AdjustmentsTab } from "./AdjustmentsTab";
import { FeesTab } from "./FeesTab";
import { MethodsTab } from "./MethodsTab";
import { usePaymentSummary } from "./queries";
import type { PaymentTab } from "./routes";
import { VerificationTab } from "./VerificationTab";

const TABS: { value: PaymentTab; label: string; anyOf: Permission[] }[] = [
  { value: "verify", label: "Verifikasi Pembayaran", anyOf: ["payments.read"] },
  { value: "methods", label: "Kelola Metode", anyOf: ["settings.manage"] },
  { value: "fees", label: "Biaya Pembayaran", anyOf: ["settings.manage"] },
  { value: "adjustments", label: "Penyesuaian", anyOf: ["payments.read"] },
];

const HEADER = {
  verify: {
    title: "Verifikasi Pembayaran",
    description: "Setujui hanya bila dana sudah terlihat di rekening tujuan.",
  },
  settings: {
    title: "Metode & Biaya Pembayaran",
    description: "Atur rekening tujuan transfer dan biaya iuran. Perubahan meminta konfirmasi identitas.",
  },
} as const;

/** Deskripsi khusus per tab; tab verifikasi memakai deskripsi judul halaman. */
const TAB_DESCRIPTION: Partial<Record<PaymentTab, string>> = {
  methods: "Rekening bank dan e-wallet tujuan transfer yang ditampilkan ke alumni.",
  fees: "Biaya pendaftaran, kartu dan perpanjangan. Versi baru hanya berlaku untuk tagihan baru.",
  adjustments: "Refund dan koreksi pembayaran tanpa mengubah status lunas.",
};

/** Makna hitungan tab untuk pembaca layar (N-11): angka saja tidak bermakna tanpa konteks. */
const COUNT_LABEL: Partial<Record<PaymentTab, string>> = {
  verify: "menunggu verifikasi",
  adjustments: "penyesuaian menunggu proses",
};

/** Izin per tab; dicek ulang di dalam panel karena izin dapat berubah saat halaman terbuka (AC F16-3). */
const TAB_ACCESS: Record<PaymentTab, Permission[]> = {
  verify: ["payments.read"],
  methods: ["settings.manage"],
  fees: ["settings.manage"],
  adjustments: ["payments.read"],
};

/**
 * Halaman pembayaran (prototipe screen_8, guidelines hlm. 17): Verifikasi | Kelola Metode | Biaya Pembayaran |
 * Penyesuaian. Tab hanya muncul sesuai izin (AC F15-1); tab aktif disimpan di URL (?tab=). Hitungan pada tab
 * Verifikasi (siap diputus) dan Penyesuaian (menunggu proses) berasal dari GET /admin/payments/summary, sama
 * dengan pill emas menu.
 */
export function PaymentsPage() {
  const auth = useAuth();
  const search = useSearch({ from: "/app/payments" });
  const navigate = useNavigate({ from: "/payments" });
  const summary = usePaymentSummary();
  const tabs = TABS.filter((t) => auth.canAny(t.anyOf));
  const requested = tabs.find((t) => t.value === search.tab);
  const tab = (requested ?? tabs[0])?.value ?? "verify";
  // Judul mengikuti cakupan izin: admin pengaturan tanpa payments.read tidak memverifikasi apa pun (AC F15-1).
  const header = auth.can("payments.read") ? HEADER.verify : HEADER.settings;
  const counts: Partial<Record<PaymentTab, number>> = summary.data
    ? {
        verify: summary.data.awaiting_review_count,
        adjustments: summary.data.adjustments_pending_count,
      }
    : {};
  const countText = (t: PaymentTab, n: number | undefined) =>
    n === undefined ? undefined : `${n} ${COUNT_LABEL[t] ?? ""}`.trim();

  return (
    <>
      <PageHeader
        title={header.title}
        description={TAB_DESCRIPTION[tab] ?? header.description}
        actions={
          tabs.length > 1 ? (
            <Tabs<PaymentTab>
              label="Menu pembayaran"
              idPrefix="pembayaran"
              value={tab}
              onValueChange={(next) => void navigate({ search: { tab: next }, replace: true })}
              items={tabs.map((t) => ({
                value: t.value,
                label: t.label,
                count: counts[t.value],
                countLabel: countText(t.value, counts[t.value]),
              }))}
            />
          ) : null
        }
      />
      <TabFrame tabbed={tabs.length > 1} tab={tab}>
        <PermissionGate anyOf={TAB_ACCESS[tab]}>
          {tab === "verify" ? (
            <VerificationTab />
          ) : tab === "methods" ? (
            <MethodsTab />
          ) : tab === "fees" ? (
            <FeesTab />
          ) : (
            <AdjustmentsTab />
          )}
        </PermissionGate>
      </TabFrame>
    </>
  );
}

/** Panel tab hanya bila tablist tampil (lebih dari satu tab diizinkan); selain itu wadah biasa. */
function TabFrame({ tabbed, tab, children }: { tabbed: boolean; tab: PaymentTab; children: ReactNode }) {
  if (!tabbed) return <div className="flex flex-col gap-5">{children}</div>;
  return (
    <TabPanel idPrefix="pembayaran" value={tab} className="flex flex-col gap-5">
      {children}
    </TabPanel>
  );
}
