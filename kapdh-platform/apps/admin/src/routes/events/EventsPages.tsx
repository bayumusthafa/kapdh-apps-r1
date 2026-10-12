import { PlaceholderPage } from "../../components/layout/PlaceholderPage";

/** Placeholder area events; diganti agen halaman admin `events` (Phase C). */
export function EventsPage() {
  return (
    <PlaceholderPage
      title="Event dan Tiket"
      description="Kegiatan alumni, periode pendaftaran, kuota dan tiket terjual."
      feature="Pengelolaan event dan tiket"
      items={[
        "Pencarian event, kategori dan lokasi",
        "Periode pendaftaran, total tiket dan sisa tiket",
        "Kuota tidak dapat diturunkan di bawah tiket yang ditahan/terbayar (AC F15-2)",
        "Pembatalan event dengan notifikasi dan pengembalian dana",
      ]}
    />
  );
}

export function EventEditorPage() {
  return (
    <PlaceholderPage
      title="Detail Event"
      breadcrumbs={[{ label: "Event dan Tiket", to: "/events" }, { label: "Detail Event" }]}
      feature="Pembuatan dan pengubahan event"
      items={[
        "Informasi, kategori, lokasi dan zona waktu event",
        "Harga, kuota dan periode pendaftaran",
        "Daftar tiket peserta",
      ]}
    />
  );
}

export function CheckinPage() {
  return (
    <PlaceholderPage
      title="Check-in Tiket"
      description="Pindai QR tiket peserta pada hari kegiatan."
      feature="Pemindai check-in tiket"
      items={[
        "Pindai QR dengan kamera atau ketik kode",
        "Tiket yang sudah dipakai menampilkan waktu dan petugas sebelumnya",
      ]}
    />
  );
}
