import { PlaceholderPage } from "../../components/layout/PlaceholderPage";

/** Placeholder area notifikasi; diganti agen halaman admin `governance` (Phase C). */
export function NotificationsPage() {
  return (
    <PlaceholderPage
      title="Notifikasi"
      description="Status pengiriman email dan push ke anggota."
      feature="Pemantauan pengiriman notifikasi"
      items={[
        "Pengiriman gagal per kanal (email/push) dan alasannya (AC F13-4)",
        "Kirim ulang pengiriman yang gagal",
      ]}
    />
  );
}
