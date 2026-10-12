import { PlaceholderPage } from "../../components/layout/PlaceholderPage";

/** Placeholder area admin; diganti agen halaman admin `governance` (Phase C). */
export function AdminsPage() {
  return (
    <PlaceholderPage
      title="Manajemen Admin"
      description="Akun administrator, peran dan hak akses."
      feature="Pengelolaan admin dan izin"
      items={[
        "Daftar dan pencarian admin",
        "Delegasi alumni menjadi admin melalui undangan (F-16)",
        "Ubah peran/izin dengan reautentikasi dan audit (AC F16-1)",
        "Minimal satu Super Admin aktif (AC F16-2)",
      ]}
    />
  );
}

export function AdminDetailPage() {
  return (
    <PlaceholderPage
      title="Detail Admin"
      breadcrumbs={[{ label: "Manajemen Admin", to: "/admins" }, { label: "Detail Admin" }]}
      feature="Detail admin"
      items={["Peran, izin dan status akun", "Riwayat perubahan izin"]}
    />
  );
}
