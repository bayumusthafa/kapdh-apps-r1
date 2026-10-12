import { useAuth } from "../../auth/session";
import { PlaceholderPage } from "../../components/layout/PlaceholderPage";
import { AdminRoleBadge, Badge } from "../../components/ui/Badge";
import { Card, CardHeader } from "../../components/ui/Card";
import { KeyValueList } from "../../components/ui/DataDisplay";
import { PERMISSION_LABEL } from "../../lib/labels";

/**
 * Akun admin sendiri. Identitas dan izin efektif ditampilkan dari GET /admin/me; ganti sandi, sesi aktif dan
 * backup code dibangun agen halaman admin `governance` (Phase C).
 */
export function AccountPage() {
  const auth = useAuth();
  const profile = auth.profile;
  return (
    <PlaceholderPage
      title="Akun saya"
      description="Identitas admin, izin efektif dan keamanan akun."
      feature="Keamanan akun admin"
      items={["Ganti kata sandi", "Sesi aktif dan keluar dari semua perangkat", "Buat ulang backup code"]}
    >
      {profile ? (
        <Card className="flex flex-col gap-4 pb-5">
          <CardHeader title="Profil admin" />
          <div className="px-5">
            <KeyValueList
              items={[
                { label: "Nama", value: profile.display_name },
                { label: "Peran", value: <AdminRoleBadge role={profile.role} /> },
                {
                  label: `Izin efektif (versi ${profile.permissions_version})`,
                  wide: true,
                  value: (
                    <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Daftar izin">
                      {profile.permissions.map((p) => (
                        <li key={p}>
                          <Badge tone="primary">{PERMISSION_LABEL[p] ?? p}</Badge>
                        </li>
                      ))}
                    </ul>
                  ),
                },
              ]}
            />
          </div>
        </Card>
      ) : null}
    </PlaceholderPage>
  );
}
