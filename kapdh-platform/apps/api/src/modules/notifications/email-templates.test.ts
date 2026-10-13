import { describe, expect, it } from "vitest";
import { renderNotificationEmail } from "./email-templates.js";

const PAYMENT_ID = "0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f";

describe("Templat email notifikasi (F-13, D10)", () => {
  it("kategori payment: subjek, salam, rincian, deep link kapdh://app, catatan preferensi", () => {
    const mail = renderNotificationEmail({
      to: "anggota@contoh.test",
      category: "payment",
      title: "Pembayaran disetujui",
      body: "Iuran pendaftaran Rp60.000 telah disetujui. KTA Anda aktif.",
      route: `/payments/${PAYMENT_ID}`,
      recipientName: "Ahmad Fauzi",
      supportEmail: "bantuan@kapdh.or.id",
    });
    expect(mail.to).toBe("anggota@contoh.test");
    expect(mail.subject).toBe("KAPDH: Pembayaran disetujui");
    expect(mail.text).toContain("Halo, Ahmad Fauzi.");
    expect(mail.text).toContain("Ada kabar terbaru tentang pembayaran Anda di KAPDH.");
    expect(mail.text).toContain("Iuran pendaftaran Rp60.000 telah disetujui.");
    expect(mail.text).toContain(`kapdh://app/payments/${PAYMENT_ID}`);
    expect(mail.text).toContain("notifikasi email kategori Pembayaran aktif");
    expect(mail.text).toContain("bantuan@kapdh.or.id");
    expect(mail.html).toContain('lang="id"');
  });

  it("kategori wajib (security, account): tidak dapat dinonaktifkan; security memuat peringatan", () => {
    const security = renderNotificationEmail({
      to: "a@contoh.test",
      category: "security",
      title: "Sandi Anda diubah",
      body: null,
      route: "/account/sessions",
      recipientName: null,
      supportEmail: "bantuan@kapdh.or.id",
    });
    expect(security.text).toContain("Halo, Anggota KAPDH.");
    expect(security.text).toContain("selalu dikirim dan tidak dapat dinonaktifkan");
    expect(security.text).toContain("segera ganti sandi");
    const account = renderNotificationEmail({
      to: "a@contoh.test",
      category: "account",
      title: "Akun dibatasi",
      body: "Hubungi pengurus.",
      route: null,
      recipientName: "Siti",
      supportEmail: "bantuan@kapdh.or.id",
    });
    expect(account.text).toContain("selalu dikirim dan tidak dapat dinonaktifkan");
    expect(account.text).toContain("menu Notifikasi");
    expect(account.text).not.toContain("kapdh://");
    expect(account.text).not.toContain("ganti sandi");
  });

  it("HTML di-escape; subjek satu baris; kontak di isi disamarkan", () => {
    const mail = renderNotificationEmail({
      to: "a@contoh.test",
      category: "event",
      title: "Event <script>alert(1)</script>",
      body: 'Info "panitia": hubungi panitia@contoh.test atau 081234567890',
      route: null,
      recipientName: "Budi & Co",
      supportEmail: "bantuan@kapdh.or.id",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("Budi &amp; Co");
    expect(mail.text).not.toContain("panitia@contoh.test");
    expect(mail.text).not.toContain("081234567890");
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});
