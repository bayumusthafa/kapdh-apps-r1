import type { MailMessage } from "../../core/adapters/mailer.js";
import { deepLinkFor } from "../../core/notifications-kernel/app-routes.js";
import type { NotificationCategory } from "../../core/notifications-kernel/notification.service.js";
import { isMandatoryCategory } from "./channel-policy.js";
import { lockScreenText } from "./delivery-policy.js";

/**
 * Templat email transaksional notifikasi (F-13, D10: pengirim noreply@kapdh.or.id). Satu templat per kategori ber-email
 * (payment, membership, event, security, account), Bahasa Indonesia. Isi berasal dari baris inbox yang sama (judul,
 * isi, rute) sehingga email tidak pernah memuat lebih dari kotak masuk: tanpa isi chat, bukti bayar, OTP, token atau
 * kontak (ARCHITECTURE §2 butir 3; teks disaring {@link lockScreenText}). Deep link memakai bentuk eksternal
 * `kapdh://app/<rute>`; aplikasi tetap memeriksa sesi sebelum membuka objek (AC F13-3).
 */
export type EmailCategory = Extract<
  NotificationCategory,
  "payment" | "membership" | "event" | "security" | "account"
>;

interface CategoryCopy {
  label: string;
  intro: string;
}

const COPY: Record<EmailCategory, CategoryCopy> = {
  payment: { label: "Pembayaran", intro: "Ada kabar terbaru tentang pembayaran Anda di KAPDH." },
  membership: {
    label: "Keanggotaan dan KTA",
    intro: "Ada kabar terbaru tentang keanggotaan dan KTA digital Anda.",
  },
  event: { label: "Event", intro: "Ada kabar terbaru tentang event KAPDH yang Anda ikuti." },
  security: { label: "Keamanan akun", intro: "Ini pemberitahuan keamanan untuk akun KAPDH Anda." },
  account: { label: "Akun", intro: "Ini pemberitahuan tentang akun KAPDH Anda." },
};

export interface NotificationEmailInput {
  to: string;
  category: EmailCategory;
  title: string;
  body: string | null;
  /** Rute aplikasi relatif §8.4 yang sudah divalidasi, atau null. */
  route: string | null;
  /** Nama penerima (alumni.full_name) atau null. */
  recipientName: string | null;
  /** Kontak dukungan dari app_settings `support` (PRD 8.3). */
  supportEmail: string;
}

const TITLE_MAX = 120;
const BODY_MAX = 500;
const NAME_MAX = 80;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Menyusun email notifikasi (subjek, teks, HTML sederhana yang di-escape). */
export function renderNotificationEmail(input: NotificationEmailInput): MailMessage {
  const copy = COPY[input.category];
  const title = lockScreenText(input.title, TITLE_MAX);
  const body = input.body ? lockScreenText(input.body, BODY_MAX) : null;
  const name = input.recipientName ? lockScreenText(input.recipientName, NAME_MAX) : null;
  const link = deepLinkFor(input.route);
  const greeting = name ? `Halo, ${name}.` : "Halo, Anggota KAPDH.";
  const mandatory = isMandatoryCategory(input.category);
  const footer = mandatory
    ? `Email ${copy.label.toLowerCase()} selalu dikirim dan tidak dapat dinonaktifkan karena berkaitan dengan keamanan dan hak akses akun Anda.`
    : `Anda menerima email ini karena notifikasi email kategori ${copy.label} aktif. Ubah di aplikasi KAPDH: Akun > Notifikasi.`;
  const caution =
    input.category === "security"
      ? `Jika Anda tidak merasa melakukan aktivitas ini, segera ganti sandi di aplikasi dan hubungi ${input.supportEmail}.`
      : null;
  const linkLine = link
    ? `Buka aplikasi KAPDH untuk melihat rinciannya: ${link}`
    : "Buka aplikasi KAPDH untuk melihat rinciannya di menu Notifikasi.";

  const text = [
    greeting,
    "",
    copy.intro,
    "",
    title,
    ...(body ? [body] : []),
    "",
    linkLine,
    ...(caution ? ["", caution] : []),
    "",
    "--",
    footer,
    `Butuh bantuan? Hubungi ${input.supportEmail}.`,
    "Email ini dikirim otomatis oleh KAPDH; mohon tidak membalas email ini.",
  ].join("\n");

  const paragraph = (value: string, style = "") =>
    `<p style="margin:0 0 12px;${style}">${escapeHtml(value)}</p>`;
  const html = [
    '<!doctype html><html lang="id"><body style="margin:0;padding:24px;background:#f7f3ea;font-family:Arial,Helvetica,sans-serif;color:#1f2a1d">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">',
    paragraph("KAPDH - Keluarga Alumni Pesantren Darel Hikmah", "font-weight:bold;color:#0e280c"),
    paragraph(greeting),
    paragraph(copy.intro),
    paragraph(title, "font-size:18px;font-weight:bold"),
    ...(body ? [paragraph(body)] : []),
    paragraph(linkLine),
    ...(caution ? [paragraph(caution, "color:#8a1c1c")] : []),
    '<hr style="border:none;border-top:1px solid #e5e0d5;margin:16px 0">',
    paragraph(footer, "font-size:12px;color:#5b6157"),
    paragraph(`Butuh bantuan? Hubungi ${input.supportEmail}.`, "font-size:12px;color:#5b6157"),
    paragraph(
      "Email ini dikirim otomatis oleh KAPDH; mohon tidak membalas email ini.",
      "font-size:12px;color:#5b6157",
    ),
    "</div></body></html>",
  ].join("");

  return { to: input.to, subject: `KAPDH: ${title}`, text, html };
}
