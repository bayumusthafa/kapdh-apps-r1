import type { Permission } from "@kapdh/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth } from "../../auth/session";
import { Card } from "../../components/ui/Card";
import { PageHeader } from "../../components/ui/PageHeader";
import { UnderConstruction } from "../../components/ui/States";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import type { PaymentTab } from "./routes";
import { VerificationTab } from "./VerificationTab";

const TABS: { value: PaymentTab; label: string; anyOf: Permission[] }[] = [
  { value: "verify", label: "Verifikasi Pembayaran", anyOf: ["payments.read"] },
  { value: "methods", label: "Kelola Metode", anyOf: ["settings.manage"] },
  { value: "fees", label: "Biaya Pembayaran", anyOf: ["settings.manage"] },
  { value: "adjustments", label: "Penyesuaian", anyOf: ["payments.read"] },
];

/**
 * Halaman pembayaran (prototipe screen_8, guidelines hlm. 17). Tab hanya muncul sesuai izin; tab aktif disimpan
 * di URL (?tab=). Verifikasi adalah layar rujukan pola halaman admin (daftar-detail, paging kursor, keputusan
 * dengan konflik versi). Saat ini memakai server tiruan sampai endpoint admin payments tersedia di API.
 */
export function PaymentsPage() {
  const auth = useAuth();
  const search = useSearch({ from: "/app/payments" });
  const navigate = useNavigate({ from: "/payments" });
  const tabs = TABS.filter((t) => auth.canAny(t.anyOf));
  const requested = tabs.find((t) => t.value === search.tab);
  const tab = (requested ?? tabs[0])?.value ?? "verify";

  return (
    <>
      <PageHeader
        title="Verifikasi Pembayaran"
        description="Setujui hanya bila dana sudah terlihat di rekening tujuan."
        actions={
          tabs.length > 1 ? (
            <Tabs<PaymentTab>
              label="Menu pembayaran"
              idPrefix="pembayaran"
              value={tab}
              onValueChange={(next) => void navigate({ search: { tab: next }, replace: true })}
              items={tabs.map((t) => ({ value: t.value, label: t.label }))}
            />
          ) : null
        }
      />
      <TabFrame tabbed={tabs.length > 1} tab={tab}>
        {tab === "verify" ? (
          <VerificationTab />
        ) : (
          <Card>
            <UnderConstruction
              feature={
                tab === "methods"
                  ? "Kelola metode pembayaran"
                  : tab === "fees"
                    ? "Biaya pembayaran"
                    : "Penyesuaian pembayaran"
              }
              items={
                tab === "methods"
                  ? [
                      "Rekening bank dan e-wallet tujuan transfer",
                      "Perubahan dengan reautentikasi dan audit (AC F15-3)",
                    ]
                  : tab === "fees"
                    ? [
                        "Biaya pendaftaran, kartu dan perpanjangan",
                        "Versi baru berlaku hanya untuk tagihan baru (AC F15-3)",
                      ]
                    : ["Refund dan koreksi tanpa mengubah status lunas (ARCHITECTURE §2.13)"]
              }
            />
          </Card>
        )}
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
