import { PlaceholderPage } from "../../components/layout/PlaceholderPage";

/** Placeholder area moderasi; diganti agen halaman admin `governance` (Phase C). */
export function ModerationPage() {
  return (
    <PlaceholderPage
      title="Moderasi"
      description="Laporan pengguna, pesan dan grup yang perlu ditinjau."
      feature="Antrean laporan moderasi"
      items={[
        "Filter status, kategori dan prioritas",
        "Bukti laporan yang diminimalkan",
        "Tindakan: abaikan, peringatkan, suspend",
      ]}
    />
  );
}

export function ReportDetailPage() {
  return (
    <PlaceholderPage
      title="Detail Laporan"
      breadcrumbs={[{ label: "Moderasi", to: "/moderation" }, { label: "Detail Laporan" }]}
      feature="Peninjauan laporan"
      items={["Bukti dan riwayat laporan", "Keputusan dengan konfirmasi dan alasan teraudit"]}
    />
  );
}
