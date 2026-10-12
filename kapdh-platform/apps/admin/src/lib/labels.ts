import type { AdminRole, components, Permission } from "@kapdh/contracts";

type PaymentType = components["schemas"]["PaymentType"];

/** Label jenis pembayaran (PRD 3.3, 3.9). */
export const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  registration: "Pendaftaran",
  renewal: "Perpanjangan",
  ticket: "Tiket event",
};

/** Label peran admin untuk header "Masuk sebagai <nama> (<peran>)" (F-16). */
export const ADMIN_ROLE_LABEL: Record<AdminRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
};

/** Deskripsi izin untuk layar admin dan pesan akses ditolak (PRD 2.3, ARCHITECTURE §4.5). */
export const PERMISSION_LABEL: Record<Permission, string> = {
  "payments.read": "Melihat antrean dan bukti pembayaran",
  "payments.decide": "Menyetujui atau menolak pembayaran",
  "members.read": "Melihat data anggota",
  "members.manage": "Mengubah data administratif anggota",
  "content.manage": "Mengelola berita, banner dan halaman",
  "master.manage": "Mengelola master profesi dan keahlian",
  "events.manage": "Mengelola event dan tiket",
  "events.checkin": "Melakukan check-in tiket",
  "moderation.read": "Membaca laporan moderasi",
  "moderation.resolve": "Menyelesaikan laporan moderasi",
  "audit.read": "Menelusuri audit",
  "audit.export": "Mengekspor audit",
  "settings.manage": "Mengubah metode bayar, biaya dan pengaturan",
  "admins.manage": "Mengelola admin dan izin",
  "notifications.manage": "Memantau dan mengulang pengiriman notifikasi",
};
