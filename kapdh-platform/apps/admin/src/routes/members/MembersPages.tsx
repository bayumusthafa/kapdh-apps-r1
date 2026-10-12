import { PlaceholderPage } from "../../components/layout/PlaceholderPage";

/** Placeholder area members; diganti agen halaman admin `members` (Phase C). */
export function MembersPage() {
  return (
    <PlaceholderPage
      title="Manajemen Users"
      description="Data alumni terdaftar, status keanggotaan dan koreksi data administratif."
      feature="Manajemen data alumni"
      items={[
        "Total alumni terdaftar, pencarian dan filter (angkatan, status KTA)",
        "Informasi profil alumni dan riwayat keanggotaan",
        "Koreksi data administratif teraudit (AC F05-6)",
        "Suspend/aktifkan kembali dan reset akses alumni (AC F16-4)",
      ]}
    />
  );
}

export function MemberDetailPage() {
  return (
    <PlaceholderPage
      title="Informasi Pengguna"
      breadcrumbs={[{ label: "Manajemen Users", to: "/members" }, { label: "Informasi Pengguna" }]}
      feature="Detail alumni"
      items={[
        "Profil, KTA dan periode keanggotaan",
        "Riwayat pembayaran dan tiket",
        "Tindakan administratif teraudit",
      ]}
    />
  );
}

export function MastersPage() {
  return (
    <PlaceholderPage
      title="Skill & Profesi"
      description="Master profesi dan keahlian untuk profil alumni dan jejaring."
      breadcrumbs={[{ label: "Manajemen Users", to: "/members" }, { label: "Skill & Profesi" }]}
      feature="Pengelolaan master profesi dan keahlian"
      items={["Tambah, ubah dan nonaktifkan profesi", "Tambah, ubah dan nonaktifkan keahlian"]}
    />
  );
}
