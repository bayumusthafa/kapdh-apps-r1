import { PlaceholderPage } from "../../components/layout/PlaceholderPage";

/** Placeholder area pengaturan; diganti agen halaman admin `governance` (Phase C). */
export function SettingsPage() {
  return (
    <PlaceholderPage
      title="Pengaturan"
      description="Konfigurasi aplikasi yang berversi dan teraudit."
      feature="Pengaturan aplikasi"
      items={[
        "Versi aplikasi minimum Android/iOS dengan reautentikasi (AC F15-3)",
        "Mode pemeliharaan dan pesan untuk pengguna",
        "Tautan toko aplikasi dan kanal bantuan",
      ]}
    />
  );
}
