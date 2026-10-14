import { useNavigate } from "@tanstack/react-router";
import { PageHeader } from "../../components/ui/PageHeader";
import { EventDetailPage } from "./EventDetailPage";
import { EventForm } from "./EventForm";
import { EventListPage } from "./EventListPage";

/**
 * Halaman area events (dimuat lazy oleh routes.tsx): tabel event (guideline p14), buat event, dan detail event.
 * Pemindai check-in ada di CheckinPage.tsx (potongan kode terpisah).
 */
export function EventsPage() {
  return <EventListPage />;
}

/** Buat event baru (F-15): selalu tersimpan sebagai draf, lalu diterbitkan dari halaman detail. */
export function EventCreatePage() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Buat Event Baru"
        description="Event tersimpan sebagai draf dan baru terlihat oleh anggota setelah diterbitkan."
        breadcrumbs={[{ label: "Event dan Tiket", to: "/events" }, { label: "Buat Event Baru" }]}
      />
      <EventForm
        mode="create"
        onSaved={(saved) => void navigate({ to: "/events/$eventId", params: { eventId: saved.id } })}
        onCancel={() => void navigate({ to: "/events" })}
      />
    </div>
  );
}

export { EventDetailPage };
