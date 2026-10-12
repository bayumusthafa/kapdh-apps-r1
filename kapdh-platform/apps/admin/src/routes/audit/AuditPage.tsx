import { useAuth } from "../../auth/session";
import { PlaceholderPage } from "../../components/layout/PlaceholderPage";

/** Placeholder area audit; diganti agen halaman admin `governance` (Phase C). */
export function AuditPage() {
  const auth = useAuth();
  const items = [
    "Filter aktor, entitas dan rentang waktu (AC F17-4)",
    "Detail perubahan before/after yang sudah disaring",
  ];
  if (auth.can("audit.export"))
    items.push("Ekspor CSV dengan filter yang sama, diproses worker dan kedaluwarsa otomatis (AC F17-3)");
  return (
    <PlaceholderPage
      title="Audit"
      description="Jejak perubahan penting untuk akuntabilitas dan penanganan sengketa."
      feature="Penelusuran audit"
      items={items}
    />
  );
}
